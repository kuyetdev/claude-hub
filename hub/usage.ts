import type { DatabaseSync } from 'node:sqlite';
import type { HubState, TokenTotals, UserState, Utilization, WeightConfig } from '../shared/types.ts';
import { getResetSchedule, nextWeeklyReset } from './schedule.ts';

interface ReportRow {
  username: string;
  machineId: string;
  hostname: string;
  lastSeenMs: number;
  agentVersion: string;
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

export function computeState(db: DatabaseSync, weights: WeightConfig, telegramConfigured: boolean, now = Date.now()): HubState {
  const schedule = getResetSchedule(db);
  const week = db.prepare('SELECT week_key AS weekKey FROM reports ORDER BY week_key DESC LIMIT 1').get() as { weekKey: string } | undefined;
  const weekKey = schedule ? nextWeeklyReset(now, schedule) : (week?.weekKey ?? null);
  let latest: Utilization | undefined;
  const utilizationRows = db.prepare('SELECT utilization_json AS utilizationJson FROM reports').all() as unknown as Array<{ utilizationJson: string }>;
  for (const row of utilizationRows) {
    const utilization = parseJson<Utilization | undefined>(row.utilizationJson, undefined);
    if (utilization && (!latest || utilization.fetchedAtMs > latest.fetchedAtMs)) latest = utilization;
  }
  const rows = db.prepare(`
    SELECT u.username, u.quota_percent AS quotaPercent,
      m.machine_id AS machineId, m.hostname, m.last_seen_ms AS lastSeenMs, m.agent_version AS agentVersion,
      r.week_key AS weekKey, r.tokens_json AS tokensJson, r.utilization_json AS utilizationJson
    FROM users u
    LEFT JOIN machines m ON m.username = u.username
    LEFT JOIN reports r ON r.machine_id = m.machine_id AND r.week_key = ?
    ORDER BY u.username, m.hostname
  `).all(weekKey ?? '') as unknown as ReportRow[];
  const byUser = new Map<string, UserState>();
  for (const row of rows) {
    let user = byUser.get(row.username);
    if (!user) {
      user = { username: row.username, quotaPercent: row.quotaPercent, usedPercent: 0, quotaRatioPercent: 0, weightedTokens: 0, machines: [] };
      byUser.set(row.username, user);
    }
    if (row.machineId) {
      user.machines.push({
        machineId: row.machineId, hostname: row.hostname, lastSeenMs: row.lastSeenMs,
        agentVersion: row.agentVersion, offline: row.lastSeenMs === 0 || now - row.lastSeenMs > 30 * 60_000,
      });
    }
    if (row.weekKey !== weekKey) continue;
    user.weightedTokens += weightedTokens(parseJson(row.tokensJson, {}), weights);
  }
  const users = [...byUser.values()];
  const totalWeighted = users.reduce((sum, user) => sum + user.weightedTokens, 0);
  const accountPercent = latest?.weeklyPercent ?? 0;
  for (const user of users) {
    user.usedPercent = totalWeighted > 0 ? accountPercent * user.weightedTokens / totalWeighted : 0;
    user.quotaRatioPercent = user.quotaPercent > 0 ? user.usedPercent / user.quotaPercent * 100 : (user.usedPercent > 0 ? 100 : 0);
  }
  const quotaTotal = users.reduce((sum, user) => sum + user.quotaPercent, 0);
  return {
    weekKey,
    resetAt: weekKey,
    accountResetAt: latest?.accountResetsAt ?? (!schedule ? weekKey : null),
    resetSchedule: schedule,
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

export function updateQuotas(db: DatabaseSync, value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_QUOTA');
  const quotas = value as Record<string, unknown>;
  const users = (db.prepare('SELECT username FROM users ORDER BY username').all() as unknown as Array<{ username: string }>).map((item) => item.username);
  const keys = Object.keys(quotas).sort();
  if (keys.length !== users.length || keys.some((key, index) => key !== users[index])) throw new Error('QUOTA_USERS_MISMATCH');
  const values = keys.map((key) => quotas[key]);
  if (values.some((quota) => typeof quota !== 'number' || !Number.isFinite(quota) || quota < 0 || quota > 100)) throw new Error('INVALID_QUOTA');
  const total = (values as number[]).reduce((sum, quota) => sum + quota, 0);
  if (Math.abs(total - 100) > 0.01) throw new Error('QUOTA_TOTAL');
  db.exec('BEGIN IMMEDIATE');
  try {
    const update = db.prepare('UPDATE users SET quota_percent = ?, quota_manual = 1 WHERE username = ?');
    for (const username of keys) update.run(quotas[username] as number, username);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
