import type { ReportPayload, TokenTotals } from '../shared/types.ts';

export const USERNAME_RE = /^[a-z0-9_-]{2,32}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function finite(value: unknown, min = 0): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min;
}

function validTokens(value: unknown): value is TokenTotals {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return finite(item.input) && finite(item.output) && finite(item.cacheCreation) && finite(item.cacheRead);
}

export function isReport(value: unknown): value is ReportPayload {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  const utilization = item.utilization as Record<string, unknown> | undefined;
  if (!UUID_RE.test(String(item.machineId)) || typeof item.accountUuid !== 'string' || item.accountUuid.length < 3 || item.accountUuid.length > 128) return false;
  if (typeof item.weekResetsAt !== 'string' || !Number.isFinite(Date.parse(item.weekResetsAt))) return false;
  if (!utilization || !finite(utilization.weeklyPercent) || !finite(utilization.fetchedAtMs) || !(utilization.fiveHourPercent === null || finite(utilization.fiveHourPercent))) return false;
  if (!item.tokensByModel || typeof item.tokensByModel !== 'object' || Array.isArray(item.tokensByModel)) return false;
  if (Object.keys(item.tokensByModel).length > 100 || !Object.values(item.tokensByModel).every(validTokens)) return false;
  return typeof item.agentVersion === 'string' && item.agentVersion.length <= 32 && finite(item.sentAtMs);
}

export function normalizeWeekKey(value: string): string {
  return new Date(value).toISOString();
}
