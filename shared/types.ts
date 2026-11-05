export interface TokenTotals {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  requests?: number;
  cacheCreation5m?: number;
  cacheCreation1h?: number;
  cacheMisses?: number;
  lastActivityMs?: number;
  lastActivityCacheRead?: number;
  lastCacheTtlMs?: number;
  lastCacheWriteMs?: number;
  metricsFromMs?: number;
}

export interface Utilization {
  weeklyPercent: number;
  fetchedAtMs: number;
  fiveHourPercent: number | null;
  accountResetsAt?: string;
}

export interface ReportPayload {
  machineId: string;
  accountUuid: string;
  accountEmail?: string;
  trackingSinceMs?: number;
  weekResetsAt: string;
  utilization: Utilization;
  tokensByModel: Record<string, TokenTotals>;
  agentVersion: string;
  sentAtMs: number;
}

export interface MachineState {
  machineId: string;
  hostname: string;
  lastSeenMs: number;
  agentVersion: string;
  offline: boolean;
  weightedTokens: number;
  usedPercent: number;
  observedSharePercent: number;
  trackingSinceMs: number;
}

export interface UserState {
  username: string;
  quotaPercent: number;
  usedPercent: number;
  quotaRatioPercent: number;
  weightedTokens: number;
  modelUsages: Array<{
    model: string; tokenCount: number; input: number; output: number; cacheRead: number; cacheCreation: number;
    cacheCreation5m: number; cacheCreation1h: number;
    requests: number | null; misses: number | null; cacheHitPercent: number; cacheStatus: string; cacheTtlMinutes: number | null;
    lastActivityMs: number | null; metricsFromMs: number | null; costUsd: number | null;
    weightedTokens: number; sharePercent: number;
  }>;
  machines: MachineState[];
}

export interface HubState {
  accounts: Array<{ accountUuid: string; email: string | null; label: string; resetAt: string | null }>;
  selectedAccountUuid: string | null;
  weekKey: string | null;
  accountPercent: number;
  fetchedAtMs: number | null;
  stale: boolean;
  resetAt: string | null;
  accountResetAt: string | null;
  quotaTotal: number;
  quotaValid: boolean;
  telegramConfigured: boolean;
  weights: WeightConfig;
  users: UserState[];
}

export interface WeightConfig {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}
