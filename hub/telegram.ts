import type { DatabaseSync } from 'node:sqlite';
import type { HubConfig } from './config.ts';
import type { HubState, UserState } from '../shared/types.ts';
import { computeState } from './usage.ts';
import { redact } from '../server/redact.ts';

type FetchLike = typeof fetch;

function localDate(timestamp: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(timestamp);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 }).format(value);
}

function formatReset(resetAt: string | null, timezone: string): string {
  if (!resetAt) return 'chưa rõ';
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: timezone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(resetAt));
}

function thresholdsForUser(ratio: number): number[] {
  const thresholds: number[] = [];
  if (ratio >= 80) thresholds.push(80);
  if (ratio >= 100) for (let value = 100; value <= Math.floor(ratio / 10) * 10; value += 10) thresholds.push(value);
  return thresholds;
}

export class TelegramAlerts {
  private readonly db: DatabaseSync;
  private readonly config: HubConfig;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  constructor(
    db: DatabaseSync,
    config: HubConfig,
    fetchImpl: FetchLike = fetch,
    now: () => number = Date.now,
  ) {
    this.db = db;
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  private wasSent(weekKey: string, scope: string, threshold: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM alerts_sent WHERE week_key = ? AND scope = ? AND threshold = ?').get(weekKey, scope, threshold));
  }

  private markSent(weekKey: string, scope: string, threshold: string, timestamp: number): void {
    this.db.prepare('INSERT OR IGNORE INTO alerts_sent(week_key, scope, threshold, sent_ms) VALUES (?, ?, ?, ?)').run(weekKey, scope, threshold, timestamp);
  }

  private hasMilestoneToday(weekKey: string, scope: string, day: string): boolean {
    const rows = this.db.prepare("SELECT threshold, sent_ms AS sentMs FROM alerts_sent WHERE week_key = ? AND scope = ? AND threshold NOT LIKE 'daily:%'").all(weekKey, scope) as unknown as Array<{ threshold: string; sentMs: number }>;
    return rows.some((row) => Number(row.threshold) >= 100 && localDate(row.sentMs, this.config.timezone) === day);
  }

  private async send(text: string): Promise<boolean> {
    if (!this.config.telegramToken || !this.config.telegramChatId) return false;
    try {
      const response = await this.fetchImpl(`https://api.telegram.org/bot${this.config.telegramToken}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: this.config.telegramChatId, text }), signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) console.error(`Gửi cảnh báo Telegram thất bại (HTTP ${response.status}).`);
      return response.ok;
    } catch (error) {
      console.error(redact(`Gửi cảnh báo Telegram thất bại: ${error instanceof Error ? error.message : String(error)}`));
      return false;
    }
  }

  private async sendOnce(weekKey: string, scope: string, threshold: string, text: string, timestamp: number): Promise<void> {
    if (this.wasSent(weekKey, scope, threshold)) return;
    if (await this.send(text)) this.markSent(weekKey, scope, threshold, timestamp);
  }

  private userMilestoneText(user: UserState, state: HubState): string {
    return `⚠️ ${user.username} đã dùng ${formatNumber(user.quotaRatioPercent)}% quota tuần (${formatNumber(user.usedPercent)}% / ${formatNumber(user.quotaPercent)}%). Cả tài khoản: ${formatNumber(state.accountPercent)}%. Reset: ${formatReset(state.resetAt, this.config.timezone)} (${this.config.timezone}).`;
  }

  async check(weekKey: string): Promise<void> {
    if (!this.config.telegramToken || !this.config.telegramChatId) return;
    const timestamp = this.now();
    const state = computeState(this.db, this.config.weights, true, timestamp);
    if (state.weekKey !== weekKey) return;
    for (const user of state.users) {
      for (const threshold of thresholdsForUser(user.quotaRatioPercent)) {
        await this.sendOnce(weekKey, `user:${user.username}`, String(threshold), this.userMilestoneText(user, state), timestamp);
      }
    }
    for (const threshold of [80, 100]) {
      if (state.accountPercent >= threshold) {
        await this.sendOnce(weekKey, 'account', String(threshold), `⚠️ Cả tài khoản đã dùng ${formatNumber(state.accountPercent)}% hạn mức tuần. Reset: ${formatReset(state.resetAt, this.config.timezone)} (${this.config.timezone}).`, timestamp);
      }
    }
    const day = localDate(timestamp, this.config.timezone);
    for (const user of state.users) {
      const scope = `user:${user.username}`;
      if (user.quotaRatioPercent < 100 || this.hasMilestoneToday(weekKey, scope, day)) continue;
      await this.sendOnce(weekKey, scope, `daily:${day}`, `🔁 ${user.username} vẫn vượt quota: ${formatNumber(user.usedPercent)}% / ${formatNumber(user.quotaPercent)}%. Cả tài khoản: ${formatNumber(state.accountPercent)}%.`, timestamp);
    }
    if (state.accountPercent >= 100 && !this.hasMilestoneToday(weekKey, 'account', day)) {
      await this.sendOnce(weekKey, 'account', `daily:${day}`, `🔁 Cả tài khoản vẫn vượt hạn mức tuần: ${formatNumber(state.accountPercent)}%.`, timestamp);
    }
  }
}

export { localDate, thresholdsForUser };
