import { createHash } from 'node:crypto';
import { glob, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReportPayload, TokenTotals } from '../shared/types.ts';

export interface AgentFileState { size: number; offset: number; ino?: number; fingerprint?: string }
export interface AgentState {
  accountUuid?: string;
  weekKey?: string;
  files: Record<string, AgentFileState>;
  seen: string[];
  tokensByModel: Record<string, TokenTotals>;
  accounts?: Record<string, { weekKey: string; tokensByModel: Record<string, TokenTotals> }>;
  pendingReport?: ReportPayload;
}

interface ClaudeConfig {
  oauthAccount?: { accountUuid?: unknown; email?: unknown; emailAddress?: unknown };
  cachedUsageUtilization?: {
    fetchedAtMs?: unknown;
    utilization?: {
      seven_day?: { utilization?: unknown; resets_at?: unknown };
      five_hour?: { utilization?: unknown } | null;
    };
  };
}

interface RateLimitCache {
  fetchedAtMs?: unknown;
  fiveHour?: { usedPercentage?: unknown; resetsAt?: unknown } | null;
  sevenDay?: { usedPercentage?: unknown; resetsAt?: unknown } | null;
}

export function emptyState(): AgentState {
  return { files: {}, seen: [], tokensByModel: {} };
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function parseUsageLine(line: string, cutoffMs: number): { id: string; model: string; timestamp: number; tokens: TokenTotals } | undefined {
  try {
    const item = JSON.parse(line) as Record<string, unknown>;
    const message = item.message as Record<string, unknown> | undefined;
    const usage = message?.usage as Record<string, unknown> | undefined;
    const timestamp = Date.parse(String(item.timestamp ?? ''));
    if (!message || !usage || !Number.isFinite(timestamp) || timestamp < cutoffMs) return undefined;
    const messageId = typeof message.id === 'string' ? message.id : '';
    const requestId = typeof item.requestId === 'string' ? item.requestId : '';
    if (!messageId || !requestId || typeof message.model !== 'string' || !message.model) return undefined;
    if (!message.model.startsWith('claude-') && message.model !== '<synthetic>') return undefined;
    const creation = usage.cache_creation && typeof usage.cache_creation === 'object' ? usage.cache_creation as Record<string, unknown> : {};
    const cacheCreation5m = numberOrZero(creation.ephemeral_5m_input_tokens);
    const cacheCreation1h = numberOrZero(creation.ephemeral_1h_input_tokens);
    const cacheCreation = numberOrZero(usage.cache_creation_input_tokens);
    const cacheRead = numberOrZero(usage.cache_read_input_tokens);
    return {
      id: `${messageId}\u0000${requestId}`,
      model: message.model.slice(0, 128),
      timestamp,
      tokens: {
        input: numberOrZero(usage.input_tokens),
        output: numberOrZero(usage.output_tokens),
        cacheCreation,
        cacheRead,
        requests: 1,
        cacheCreation5m,
        cacheCreation1h,
        cacheMisses: cacheCreation > 0 && cacheRead === 0 ? 1 : 0,
        lastActivityMs: timestamp,
        lastActivityCacheRead: cacheRead,
        lastCacheTtlMs: cacheCreation1h > 0 ? 3_600_000 : cacheCreation5m > 0 ? 300_000 : 0,
        lastCacheWriteMs: cacheCreation > 0 ? timestamp : undefined,
        metricsFromMs: timestamp,
      },
    };
  } catch { return undefined; }
}

function addTokens(target: TokenTotals, source: TokenTotals): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheCreation += source.cacheCreation;
  target.cacheRead += source.cacheRead;
  target.requests = (target.requests ?? 0) + (source.requests ?? 1);
  target.cacheCreation5m = (target.cacheCreation5m ?? 0) + (source.cacheCreation5m ?? 0);
  target.cacheCreation1h = (target.cacheCreation1h ?? 0) + (source.cacheCreation1h ?? 0);
  target.cacheMisses = (target.cacheMisses ?? 0) + (source.cacheMisses ?? 0);
  if ((source.lastActivityMs ?? 0) >= (target.lastActivityMs ?? 0)) {
    target.lastActivityMs = source.lastActivityMs;
    target.lastActivityCacheRead = source.lastActivityCacheRead;
  }
  if ((source.cacheCreation ?? 0) > 0 && (source.lastActivityMs ?? 0) >= (target.lastCacheWriteMs ?? 0)) {
    target.lastCacheWriteMs = source.lastActivityMs;
    target.lastCacheTtlMs = source.lastCacheTtlMs;
  }
  if (target.metricsFromMs === undefined || (source.metricsFromMs ?? Infinity) < target.metricsFromMs) target.metricsFromMs = source.metricsFromMs;
}

function resetIso(value: unknown): string | undefined {
  const raw = typeof value === 'number' ? new Date(value * 1000) : typeof value === 'string' ? new Date(value) : undefined;
  return raw && Number.isFinite(raw.getTime()) ? raw.toISOString() : undefined;
}

function canonicalReset(value: string): string {
  const timestamp = Date.parse(value);
  return new Date(Math.round(timestamp / 60_000) * 60_000).toISOString();
}

async function prefixFingerprint(handle: Awaited<ReturnType<typeof open>>, offset: number): Promise<string> {
  const start = Math.max(0, offset - 4096);
  const buffer = Buffer.alloc(offset - start);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
  return createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex');
}

export async function scanClaudeHome(claudeHome: string, previous: AgentState = emptyState(), now = Date.now(), tokenResetAt?: string, rateLimitCachePath?: string, trackingSince: number | Record<string, number> = 0): Promise<{ payload: Omit<ReportPayload, 'machineId' | 'agentVersion' | 'sentAtMs'>; state: AgentState }> {
  const rawConfig = await readFile(join(claudeHome, '..', '.claude.json'), 'utf8');
  const config = JSON.parse(rawConfig) as ClaudeConfig;
  const accountUuid = config.oauthAccount?.accountUuid;
  const trackingWasConfigured = typeof trackingSince === 'number' || (typeof accountUuid === 'string' && Object.hasOwn(trackingSince, accountUuid));
  const trackingSinceMs = typeof trackingSince === 'number' ? trackingSince : (typeof accountUuid === 'string' ? trackingSince[accountUuid] ?? 0 : 0);
  const accountEmailRaw = config.oauthAccount?.email ?? config.oauthAccount?.emailAddress;
  const accountEmail = typeof accountEmailRaw === 'string' && accountEmailRaw.length <= 320 ? accountEmailRaw : undefined;
  const cached = config.cachedUsageUtilization;
  let live: RateLimitCache | undefined;
  if (rateLimitCachePath) {
    try { live = JSON.parse(await readFile(rateLimitCachePath, 'utf8')) as RateLimitCache; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const week = cached?.utilization?.seven_day;
  const liveFetchedAt = typeof live?.fetchedAtMs === 'number' ? live.fetchedAtMs : undefined;
  const liveIsCurrent = liveFetchedAt !== undefined && liveFetchedAt <= now + 60_000 && liveFetchedAt >= now - 24 * 60 * 60 * 1000;
  const cachedFetchedAt = typeof cached?.fetchedAtMs === 'number' ? cached.fetchedAtMs : undefined;
  const cachedWeekly = typeof week?.utilization === 'number' ? week.utilization : undefined;
  const liveWeekly = liveIsCurrent && typeof live?.sevenDay?.usedPercentage === 'number' ? live.sevenDay.usedPercentage : undefined;
  const liveResetAt = liveIsCurrent ? resetIso(live?.sevenDay?.resetsAt) : undefined;
  const cachedResetAt = resetIso(week?.resets_at);
  const sameResetWindow = Boolean(liveResetAt && cachedResetAt && Math.abs(Date.parse(liveResetAt) - Date.parse(cachedResetAt)) < 60_000);
  const useLiveRateLimits = liveWeekly !== undefined && (cachedFetchedAt === undefined || liveFetchedAt! >= cachedFetchedAt);
  const weeklyPercent = liveWeekly !== undefined && cachedWeekly !== undefined && sameResetWindow
    ? Math.max(liveWeekly, cachedWeekly)
    : useLiveRateLimits ? liveWeekly : cachedWeekly;
  const utilizationFetchedAt = Math.max(liveWeekly === undefined ? 0 : liveFetchedAt!, cachedWeekly === undefined ? 0 : cachedFetchedAt!);
  const liveAccountReset = useLiveRateLimits ? liveResetAt : undefined;
  if (typeof accountUuid !== 'string' || accountUuid.length < 3) throw new Error('Không tìm thấy accountUuid trong ~/.claude.json.');
  const liveReset = liveAccountReset;
  if (!liveReset && (typeof week?.resets_at !== 'string' || !Number.isFinite(Date.parse(week.resets_at)))) throw new Error('Không tìm thấy giờ reset tuần trong ~/.claude.json.');
  if (weeklyPercent === undefined || utilizationFetchedAt === undefined) throw new Error('Không tìm thấy số liệu usage tuần trong ~/.claude.json.');

  // Claude's statusLine and cached usage can differ by a few seconds; normalize the reset boundary
  // so that the persisted weekly accumulator is not cleared when the source switches.
  const accountResetAt = canonicalReset(liveReset ?? week!.resets_at as string);
  const weekKey = tokenResetAt ? new Date(tokenResetAt).toISOString() : accountResetAt;
  const state = structuredClone(previous);
  state.files ??= {};
  state.seen ??= [];
  state.tokensByModel ??= {};
  state.weekKey = weekKey;
  state.accounts ??= {};
  const accountState = state.accounts[accountUuid as string] ?? {
    weekKey,
    tokensByModel: !previous.accounts && (!previous.accountUuid || previous.accountUuid === accountUuid) && previous.weekKey === weekKey
      ? structuredClone(previous.tokensByModel) : {},
  };
  if (accountState.weekKey !== weekKey) {
    accountState.weekKey = weekKey;
    accountState.tokensByModel = {};
  }
  state.accounts[accountUuid as string] = accountState;
  const seen = new Set(state.seen);
  const cutoffMs = Math.max(Date.parse(weekKey) - 7 * 24 * 60 * 60 * 1000, trackingSinceMs);

  for await (const file of glob(join(claudeHome, 'projects', '**', '*.jsonl'))) {
    const handle = await open(file, 'r');
    try {
      const info = await handle.stat();
      const old = state.files[file];
      // Read only the new tail, not the entire multi-gigabyte history, on every hook call.
      // The fingerprint detects same-path/same-inode rewrites such as transcript cleanup.
      const cursorIsValid = Boolean(old?.fingerprint)
        && old!.offset <= info.size
        && (old!.ino === undefined || old!.ino === info.ino)
        && await prefixFingerprint(handle, old!.offset) === old!.fingerprint;
      const start = cursorIsValid ? old!.offset : 0;
      const buffer = Buffer.alloc(Math.max(0, info.size - start));
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, start + bytesRead);
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      // Find the last newline in bytes, not by measuring a decoded UTF-8 tail; the last
      // character may be incomplete while Claude is still appending a multibyte line.
      const completeBytes = buffer.subarray(0, bytesRead).lastIndexOf(0x0a) + 1;
      const lines = buffer.subarray(0, completeBytes).toString('utf8').split('\n');
      for (const line of lines) {
        if (!line) continue;
        const parsed = parseUsageLine(line, cutoffMs);
        if (!parsed || seen.has(parsed.id)) continue;
        seen.add(parsed.id);
        const total = accountState.tokensByModel[parsed.model] ?? { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, requests: 0, cacheCreation5m: 0, cacheCreation1h: 0, cacheMisses: 0 };
        addTokens(total, parsed.tokens);
        accountState.tokensByModel[parsed.model] = total;
      }
      const offset = start + completeBytes;
      state.files[file] = { size: start + bytesRead, offset, ino: info.ino, fingerprint: await prefixFingerprint(handle, offset) };
    } finally { await handle.close(); }
  }
  state.seen = [...seen];
  state.accountUuid = accountUuid as string;
  state.tokensByModel = structuredClone(accountState.tokensByModel);
  return {
    payload: {
      accountUuid,
      ...(accountEmail ? { accountEmail } : {}),
      ...(trackingWasConfigured ? { trackingSinceMs } : {}),
      weekResetsAt: weekKey,
      utilization: {
        weeklyPercent,
        fetchedAtMs: utilizationFetchedAt,
        fiveHourPercent: useLiveRateLimits && typeof live?.fiveHour?.usedPercentage === 'number' ? live.fiveHour.usedPercentage : typeof cached?.utilization?.five_hour?.utilization === 'number' ? cached.utilization.five_hour.utilization : null,
        accountResetsAt: accountResetAt,
      },
      tokensByModel: accountState.tokensByModel,
    },
    state,
  };
}
