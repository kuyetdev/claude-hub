import type { DatabaseSync } from 'node:sqlite';
import type { HubState, TokenTotals, UserState, Utilization, WeightConfig } from '../shared/types.ts';
import { normalizeWeekKey } from './validate.ts';

interface ReportRow {
  username: string;
  machineId: string;
  hostname: string;
  lastSeenMs: number;
  agentVersion: string;
  trackingSinceMs: number;
  quotaPercent: number;
  weekKey: string | null;
  tokensJson: string | null;
  utilizationJson: string | null;
}

/** Xấp xỉ tương quan sử dụng; không phải công thức tính phí/hạn mức của Anthropic. */
export function weightedTokens(models: Record<string, TokenTotals>, weights: WeightConfig): number {
  return Object.values(models).reduce((total, tokens) => total
    + tokens.input * weights.input
    + tokens.output * weights.output
    + tokens.cacheCreation * weights.cacheCreation
    + tokens.cacheRead * weights.cacheRead, 0);
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function rawTokens(models: Record<string, TokenTotals>): number {
  return Object.values(models).reduce((sum, tokens) => sum + tokens.input + tokens.output + tokens.cacheCreation + tokens.cacheRead, 0);
}

export function computeState(db: DatabaseSync, weights: WeightConfig, telegramConfigured: boolean, now = Date.now(), requestedAccount?: string | null): HubState {
  const accounts = db.prepare(`SELECT a.account_uuid AS accountUuid, a.email,
      (SELECT r.week_key FROM reports r WHERE r.account_uuid = a.account_uuid ORDER BY r.received_ms DESC LIMIT 1) AS resetAt
    FROM accounts a ORDER BY COALESCE((SELECT MAX(r.received_ms) FROM reports r WHERE r.account_uuid = a.account_uuid), a.created_at) DESC, a.account_uuid`).all() as unknown as Array<{accountUuid:string; email:string|null; resetAt:string|null}>;
  const selectedAccountUuid = accounts.some((account) => account.accountUuid === requestedAccount)
    ? requestedAccount! : (accounts[0]?.accountUuid ?? null);
  const week = selectedAccountUuid ? db.prepare('SELECT week_key AS weekKey FROM reports WHERE account_uuid = ? ORDER BY week_key DESC LIMIT 1').get(selectedAccountUuid) as { weekKey: string } | undefined : undefined;
  const weekKey = week ? normalizeWeekKey(week.weekKey) : null;
  let latest: Utilization | undefined;
  const utilizationRows = selectedAccountUuid ? db.prepare('SELECT utilization_json AS utilizationJson FROM reports WHERE account_uuid = ?').all(selectedAccountUuid) as unknown as Array<{ utilizationJson: string }> : [];
  for (const row of utilizationRows) {
    const utilization = parseJson<Utilization | undefined>(row.utilizationJson, undefined);
    if (utilization && (!latest || utilization.fetchedAtMs > latest.fetchedAtMs)) latest = utilization;
  }
  const rows = db.prepare(`
    SELECT u.username, au.quota_percent AS quotaPercent,
      m.machine_id AS machineId, m.hostname, m.last_seen_ms AS lastSeenMs, m.agent_version AS agentVersion,
      am.tracking_since_ms AS trackingSinceMs,
      r.week_key AS weekKey, r.tokens_json AS tokensJson, r.utilization_json AS utilizationJson
    FROM account_users au
    JOIN users u ON u.username = au.username AND au.account_uuid = ?
    JOIN machines m ON m.username = u.username
    JOIN account_machines am ON am.machine_id = m.machine_id AND am.account_uuid = ?
    LEFT JOIN reports r ON r.machine_id = m.machine_id AND r.account_uuid = am.account_uuid
    ORDER BY u.username, m.hostname
  `).all(selectedAccountUuid ?? '', selectedAccountUuid ?? '') as unknown as ReportRow[];
  const byUser = new Map<string, UserState>();
  for (const row of rows) {
    let user = byUser.get(row.username);
    if (!user) {
      user = { username: row.username, quotaPercent: row.quotaPercent, usedPercent: 0, quotaRatioPercent: 0, weightedTokens: 0, modelUsages: [], machines: [] };
      byUser.set(row.username, user);
    }
    if (row.machineId) {
      const machineWeekKey = row.weekKey ? normalizeWeekKey(row.weekKey) : null;
      const machineModels = machineWeekKey === weekKey ? parseJson<Record<string, TokenTotals>>(row.tokensJson, {}) : {};
      const machineWeighted = weightedTokens(machineModels, weights);
      for (const [model, totals] of Object.entries(machineModels)) {
        let usage = user.modelUsages.find((item) => item.model === model);
        if (!usage) {
          usage = { model, tokenCount: 0, weightedTokens: 0, sharePercent: 0 };
          user.modelUsages.push(usage);
        }
        usage.tokenCount += rawTokens({ [model]: totals });
        usage.weightedTokens += weightedTokens({ [model]: totals }, weights);
      }
      user.machines.push({
        machineId: row.machineId, hostname: row.hostname, lastSeenMs: row.lastSeenMs,
        agentVersion: row.agentVersion, offline: row.lastSeenMs === 0 || now - row.lastSeenMs > 30 * 60_000,
        weightedTokens: machineWeighted, usedPercent: 0, observedSharePercent: 0,
        trackingSinceMs: Math.max(Date.parse(weekKey ?? new Date(now).toISOString()) - 7 * 86400_000, row.trackingSinceMs),
      });
      user.weightedTokens += machineWeighted;
    }
    if (!row.weekKey || normalizeWeekKey(row.weekKey) !== weekKey) continue;
  }
  const users = [...byUser.values()];
  const totalWeighted = users.reduce((sum, user) => sum + user.weightedTokens, 0);
  const accountPercent = latest?.weeklyPercent ?? 0;
  for (const user of users) {
    user.usedPercent = totalWeighted > 0 ? accountPercent * user.weightedTokens / totalWeighted : 0;
    user.quotaRatioPercent = user.quotaPercent > 0 ? user.usedPercent / user.quotaPercent * 100 : (user.usedPercent > 0 ? 100 : 0);
    for (const model of user.modelUsages) {
      model.sharePercent = user.weightedTokens > 0 ? model.weightedTokens / user.weightedTokens * 100 : 0;
    }
    user.modelUsages.sort((a, b) => b.weightedTokens - a.weightedTokens || a.model.localeCompare(b.model));
    for (const machine of user.machines) {
      machine.observedSharePercent = totalWeighted > 0 ? machine.weightedTokens / totalWeighted * 100 : 0;
      machine.usedPercent = totalWeighted > 0 ? accountPercent * machine.weightedTokens / totalWeighted : 0;
    }
  }
  const quotaTotal = users.reduce((sum, user) => sum + user.quotaPercent, 0);
  return {
    accounts: accounts.map((account) => ({ ...account, label: account.email || account.accountUuid })),
    selectedAccountUuid,
    weekKey,
    resetAt: weekKey,
    accountResetAt: latest?.accountResetsAt ?? weekKey,
    accountPercent,
    fetchedAtMs: latest?.fetchedAtMs ?? null,
    stale: !latest || now - latest.fetchedAtMs > 30 * 60_000,
    quotaTotal,
    quotaValid: Math.abs(quotaTotal - 100) <= 0.01,
    telegramConfigured,
    weights,
    users,
  };
}

export function updateQuotas(db: DatabaseSync, value: unknown, accountUuid?: string | null): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_QUOTA');
  const quotas = value as Record<string, unknown>;
  const users = (accountUuid && db.prepare('SELECT 1 FROM accounts WHERE account_uuid = ?').get(accountUuid))
    ? (db.prepare('SELECT username FROM account_users WHERE account_uuid = ? ORDER BY username').all(accountUuid) as unknown as Array<{ username: string }>).map((item) => item.username)
    : (db.prepare('SELECT username FROM users ORDER BY username').all() as unknown as Array<{ username: string }>).map((item) => item.username);
  const keys = Object.keys(quotas).sort();
  if (keys.length !== users.length || keys.some((key, index) => key !== users[index])) throw new Error('QUOTA_USERS_MISMATCH');
  const values = keys.map((key) => quotas[key]);
  if (values.some((quota) => typeof quota !== 'number' || !Number.isFinite(quota) || quota < 0 || quota > 100)) throw new Error('INVALID_QUOTA');
  const total = (values as number[]).reduce((sum, quota) => sum + quota, 0);
  if (Math.abs(total - 100) > 0.01) throw new Error('QUOTA_TOTAL');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (accountUuid && db.prepare('SELECT 1 FROM accounts WHERE account_uuid = ?').get(accountUuid)) {
      const update = db.prepare('UPDATE account_users SET quota_percent = ?, quota_manual = 1 WHERE account_uuid = ? AND username = ?');
      for (const username of keys) update.run(quotas[username] as number, accountUuid, username);
    } else {
      const update = db.prepare('UPDATE users SET quota_percent = ?, quota_manual = 1 WHERE username = ?');
      for (const username of keys) update.run(quotas[username] as number, username);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
