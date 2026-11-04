import { resolve } from 'node:path';
import type { WeightConfig } from '../shared/types.ts';

function positiveNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} phải là số không âm.`);
  return value;
}

export interface HubConfig {
  host: string;
  port: number;
  publicUrl?: string;
  dbPath: string;
  timezone: string;
  telegramToken?: string;
  telegramChatId?: string;
  weights: WeightConfig;
}

export function loadConfig(env = process.env): HubConfig {
  const port = Number(env.HUB_PORT ?? 4318);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('HUB_PORT không hợp lệ.');
  const timezone = env.HUB_TZ ?? 'Asia/Ho_Chi_Minh';
  try { new Intl.DateTimeFormat('vi-VN', { timeZone: timezone }); } catch { throw new Error('HUB_TZ không hợp lệ.'); }
  return {
    host: env.HUB_HOST ?? '127.0.0.1',
    port,
    publicUrl: env.HUB_PUBLIC_URL || undefined,
    dbPath: resolve(env.HUB_DB_PATH ?? './data/hub.db'),
    timezone,
    telegramToken: env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: env.TELEGRAM_CHAT_ID || undefined,
    weights: {
      input: positiveNumber(env, 'HUB_WEIGHT_INPUT', 1),
      output: positiveNumber(env, 'HUB_WEIGHT_OUTPUT', 5),
      cacheCreation: positiveNumber(env, 'HUB_WEIGHT_CACHE_CREATION', 1.25),
      cacheRead: positiveNumber(env, 'HUB_WEIGHT_CACHE_READ', 0.1),
    },
  };
}
