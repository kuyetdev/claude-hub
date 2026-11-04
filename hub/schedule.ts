import type { DatabaseSync } from 'node:sqlite';
import type { ResetSchedule } from '../shared/types.ts';

function localParts(timestamp: number, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(timestamp);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { year: Number(value('year')), month: Number(value('month')), day: Number(value('day')), hour: Number(value('hour')), minute: Number(value('minute')), second: Number(value('second')), dayOfWeek: weekdays[value('weekday')] };
}

function localToUtc(year: number, month: number, day: number, hour: number, minute: number, timezone: string): number {
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  let guess = desired;
  for (let index = 0; index < 3; index += 1) {
    const actual = localParts(guess, timezone);
    const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    guess += desired - represented;
  }
  return guess;
}

export function nextWeeklyReset(timestamp: number, schedule: ResetSchedule): string {
  const current = localParts(timestamp, schedule.timezone);
  const [targetHour, targetMinute] = schedule.time.split(':').map(Number);
  let daysAhead = (schedule.dayOfWeek - current.dayOfWeek + 7) % 7;
  if (daysAhead === 0 && (current.hour > targetHour || (current.hour === targetHour && current.minute >= targetMinute))) daysAhead = 7;
  const localDate = new Date(Date.UTC(current.year, current.month - 1, current.day + daysAhead));
  return new Date(localToUtc(localDate.getUTCFullYear(), localDate.getUTCMonth() + 1, localDate.getUTCDate(), targetHour, targetMinute, schedule.timezone)).toISOString();
}

export function getResetSchedule(db: DatabaseSync): ResetSchedule | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'resetSchedule'").get() as { value: string } | undefined;
  if (!row) return null;
  try { return JSON.parse(row.value) as ResetSchedule; } catch { return null; }
}

export function saveResetSchedule(db: DatabaseSync, value: unknown, timezone: string): ResetSchedule {
  if (!value || typeof value !== 'object') throw new Error('INVALID_SCHEDULE');
  const item = value as Record<string, unknown>;
  if (!Number.isInteger(item.dayOfWeek) || Number(item.dayOfWeek) < 0 || Number(item.dayOfWeek) > 6 || typeof item.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(item.time)) throw new Error('INVALID_SCHEDULE');
  const schedule = { dayOfWeek: Number(item.dayOfWeek), time: item.time, timezone };
  db.prepare("INSERT INTO settings(key, value) VALUES ('resetSchedule', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(schedule));
  return schedule;
}
