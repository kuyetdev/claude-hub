import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase } from '../hub/db.ts';
import { TelegramAlerts } from '../hub/telegram.ts';
import { TEST_CONFIG } from './helpers.ts';

const WEEK = '2026-11-05T17:00:00.000Z';

function fixture(percent = 82) {
  const db = openDatabase(':memory:');
  db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run('alice', 20, 1, 1);
  db.prepare('INSERT INTO machines VALUES (?, ?, ?, ?, ?, ?)').run('m1', 'alice', 'may-a', 'hash', 1, '0.1.0');
  db.prepare('INSERT INTO reports VALUES (?, ?, ?, ?, ?, ?)').run(
    'm1', WEEK, JSON.stringify({ x: { input: 1, output: 0, cacheCreation: 0, cacheRead: 0 } }),
    JSON.stringify({ weeklyPercent: percent, fetchedAtMs: Date.parse('2026-11-04T10:00:00Z'), fiveHourPercent: null }), 'account', 1,
  );
  return db;
}

function mockFetch(statuses: number[] = []) {
  const messages: string[] = [];
  const fn = (async (_url: string | URL | Request, init?: RequestInit) => {
    messages.push((JSON.parse(String(init?.body)) as { text: string }).text);
    return new Response('{}', { status: statuses.shift() ?? 200 });
  }) as typeof fetch;
  return { fn, messages };
}

test('gửi các mốc 80, 100, 110 và không gửi trùng', async () => {
  const db = fixture(22); // quota 20 => 110%
  const mock = mockFetch();
  const config = { ...TEST_CONFIG, telegramToken: 'telegram-test-token', telegramChatId: '1' };
  try {
    const alerts = new TelegramAlerts(db, config, mock.fn, () => Date.parse('2026-11-04T10:00:00Z'));
    await alerts.check(WEEK);
    await alerts.check(WEEK);
    const userRows = db.prepare("SELECT threshold FROM alerts_sent WHERE scope = 'user:alice' ORDER BY threshold").all() as unknown as Array<{ threshold: string }>;
    assert.deepEqual(userRows.map((row) => row.threshold), ['100', '110', '80']);
    assert.equal(mock.messages.filter((text) => text.includes('alice')).length, 3);
  } finally { db.close(); }
});

test('gửi lỗi không đánh dấu và thử lại lần sau', async () => {
  const db = fixture(16); // 80% quota
  const mock = mockFetch([500, 200]);
  const config = { ...TEST_CONFIG, telegramToken: 'telegram-test-token', telegramChatId: '1' };
  try {
    const alerts = new TelegramAlerts(db, config, mock.fn, () => 1);
    await alerts.check(WEEK);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM alerts_sent WHERE scope = 'user:alice'").get() as { count: number }).count, 0);
    await alerts.check(WEEK);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM alerts_sent WHERE scope = 'user:alice'").get() as { count: number }).count, 1);
  } finally { db.close(); }
});

test('nhắc hằng ngày theo HUB_TZ, bỏ qua ngày vừa có mốc và khi đã xuống dưới 100%', async () => {
  const db = fixture(22);
  const mock = mockFetch();
  const config = { ...TEST_CONFIG, telegramToken: 'telegram-test-token', telegramChatId: '1' };
  let now = Date.parse('2026-11-04T16:30:00Z'); // 23:30 Việt Nam
  try {
    const alerts = new TelegramAlerts(db, config, mock.fn, () => now);
    await alerts.check(WEEK);
    assert.equal(mock.messages.some((text) => text.startsWith('🔁 alice')), false);
    now = Date.parse('2026-11-04T17:30:00Z'); // 00:30 ngày kế
    await alerts.check(WEEK);
    await alerts.check(WEEK);
    assert.equal(mock.messages.filter((text) => text.startsWith('🔁 alice')).length, 1);
    db.prepare('UPDATE reports SET utilization_json = ?').run(JSON.stringify({ weeklyPercent: 10, fetchedAtMs: now, fiveHourPercent: null }));
    now += 24 * 60 * 60_000;
    await alerts.check(WEEK);
    assert.equal(mock.messages.filter((text) => text.startsWith('🔁 alice')).length, 1);
  } finally { db.close(); }
});

test('tuần mới có thể gửi lại cùng ngưỡng', async () => {
  const db = fixture(16);
  const mock = mockFetch();
  const config = { ...TEST_CONFIG, telegramToken: 'telegram-test-token', telegramChatId: '1' };
  try {
    const alerts = new TelegramAlerts(db, config, mock.fn, () => 1);
    await alerts.check(WEEK);
    const next = '2026-11-12T17:00:00.000Z';
    db.prepare('UPDATE reports SET week_key = ?').run(next);
    await alerts.check(next);
    assert.equal(mock.messages.filter((text) => text.includes('alice')).length, 2);
  } finally { db.close(); }
});
