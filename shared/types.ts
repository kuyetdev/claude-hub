export interface TokenTotals {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
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
}

export interface UserState {
  username: string;
  quotaPercent: number;
  usedPercent: number;
  quotaRatioPercent: number;
  weightedTokens: number;
  machines: MachineState[];
}

export interface HubState {
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
