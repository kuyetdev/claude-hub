import { glob, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReportPayload, TokenTotals } from '../shared/types.ts';

export interface AgentFileState { size: number; offset: number; ino?: number }
export interface AgentState {
  weekKey?: string;
  files: Record<string, AgentFileState>;
  seen: string[];
  tokensByModel: Record<string, TokenTotals>;
}

interface ClaudeConfig {
  oauthAccount?: { accountUuid?: unknown };
  cachedUsageUtilization?: {
    fetchedAtMs?: unknown;
    utilization?: {
      seven_day?: { utilization?: unknown; resets_at?: unknown };
      five_hour?: { utilization?: unknown } | null;
    };
  };
}

export function emptyState(): AgentState {
  return { files: {}, seen: [], tokensByModel: {} };
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function parseUsageLine(line: string, cutoffMs: number): { id: string; model: string; tokens: TokenTotals } | undefined {
  try {
    const item = JSON.parse(line) as Record<string, unknown>;
    const message = item.message as Record<string, unknown> | undefined;
    const usage = message?.usage as Record<string, unknown> | undefined;
    const timestamp = Date.parse(String(item.timestamp ?? ''));
    if (!message || !usage || !Number.isFinite(timestamp) || timestamp < cutoffMs) return undefined;
    const messageId = typeof message.id === 'string' ? message.id : '';
    const requestId = typeof item.requestId === 'string' ? item.requestId : '';
    if (!messageId || !requestId || typeof message.model !== 'string' || !message.model) return undefined;
    return {
      id: `${messageId}\u0000${requestId}`,
      model: message.model.slice(0, 128),
      tokens: {
        input: numberOrZero(usage.input_tokens),
        output: numberOrZero(usage.output_tokens),
        cacheCreation: numberOrZero(usage.cache_creation_input_tokens),
        cacheRead: numberOrZero(usage.cache_read_input_tokens),
      },
    };
  } catch { return undefined; }
}

function addTokens(target: TokenTotals, source: TokenTotals): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheCreation += source.cacheCreation;
  target.cacheRead += source.cacheRead;
}

export async function scanClaudeHome(claudeHome: string, previous: AgentState = emptyState(), now = Date.now(), tokenResetAt?: string): Promise<{ payload: Omit<ReportPayload, 'machineId' | 'agentVersion' | 'sentAtMs'>; state: AgentState }> {
  const rawConfig = await readFile(join(claudeHome, '..', '.claude.json'), 'utf8');
  const config = JSON.parse(rawConfig) as ClaudeConfig;
  const accountUuid = config.oauthAccount?.accountUuid;
  const cached = config.cachedUsageUtilization;
  const week = cached?.utilization?.seven_day;
  if (typeof accountUuid !== 'string' || accountUuid.length < 3) throw new Error('Không tìm thấy accountUuid trong ~/.claude.json.');
  if (typeof week?.resets_at !== 'string' || !Number.isFinite(Date.parse(week.resets_at))) throw new Error('Không tìm thấy giờ reset tuần trong ~/.claude.json.');
  if (typeof week.utilization !== 'number' || typeof cached?.fetchedAtMs !== 'number') throw new Error('Không tìm thấy số liệu usage tuần trong ~/.claude.json.');

  const accountResetAt = new Date(week.resets_at).toISOString();
  const weekKey = tokenResetAt ? new Date(tokenResetAt).toISOString() : accountResetAt;
  const state = previous.weekKey === weekKey ? structuredClone(previous) : emptyState();
  state.weekKey = weekKey;
  const seen = new Set(state.seen);
  const cutoffMs = Date.parse(weekKey) - 7 * 24 * 60 * 60 * 1000;

  for await (const file of glob(join(claudeHome, 'projects', '**', '*.jsonl'))) {
    const info = await stat(file);
    const old = state.files[file];
    const start = old && info.size >= old.size && (old.ino === undefined || old.ino === info.ino) ? old.offset : 0;
    if (start >= info.size) {
      state.files[file] = { size: info.size, offset: info.size, ino: info.ino };
      continue;
    }
    const buffer = await readFile(file);
    const addition = buffer.subarray(start).toString('utf8');
    const hasTrailingLine = addition.endsWith('\n');
    const lines = addition.split('\n');
    const trailing = hasTrailingLine ? '' : (lines.pop() ?? '');
    for (const line of lines) {
      if (!line) continue;
      const parsed = parseUsageLine(line, cutoffMs);
      if (!parsed || seen.has(parsed.id)) continue;
      seen.add(parsed.id);
      const total = state.tokensByModel[parsed.model] ?? { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
      addTokens(total, parsed.tokens);
      state.tokensByModel[parsed.model] = total;
    }
    state.files[file] = { size: info.size, offset: info.size - Buffer.byteLength(trailing), ino: info.ino };
  }
  state.seen = [...seen];
  return {
    payload: {
      accountUuid,
      weekResetsAt: weekKey,
      utilization: {
        weeklyPercent: week.utilization,
        fetchedAtMs: cached.fetchedAtMs,
        fiveHourPercent: typeof cached.utilization?.five_hour?.utilization === 'number' ? cached.utilization.five_hour.utilization : null,
        accountResetsAt: accountResetAt,
      },
      tokensByModel: state.tokensByModel,
    },
    state,
  };
}
