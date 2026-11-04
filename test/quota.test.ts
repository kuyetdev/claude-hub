import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase } from '../hub/db.ts';
import { computeState, updateQuotas, weightedTokens } from '../hub/usage.ts';
import { register, testServer, TEST_CONFIG } from './helpers.ts';

test('trọng số và phân bổ mức dùng theo bảng giá trị', () => {
  assert.equal(weightedTokens({ x: { input: 100, output: 10, cacheCreation: 20, cacheRead: 50 } }, TEST_CONFIG.weights), 180);
  const db = openDatabase(':memory:');
  try {
    db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run('alice', 60, 1, 1);
    db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run('bob', 40, 1, 1);
    db.prepare('INSERT INTO machines VALUES (?, ?, ?, ?, ?, ?)').run('m1', 'alice', 'a', 'h1', 100, '0.1.0');
    db.prepare('INSERT INTO machines VALUES (?, ?, ?, ?, ?, ?)').run('m2', 'bob', 'b', 'h2', 100, '0.1.0');
    const utilization = JSON.stringify({ weeklyPercent: 60, fetchedAtMs: 1000, fiveHourPercent: null });
    db.prepare('INSERT INTO reports VALUES (?, ?, ?, ?, ?, ?)').run('m1', '2026-11-05T17:00:00.000Z', JSON.stringify({ x: { input: 3, output: 0, cacheCreation: 0, cacheRead: 0 } }), utilization, 'a', 100);
    db.prepare('INSERT INTO reports VALUES (?, ?, ?, ?, ?, ?)').run('m2', '2026-11-05T17:00:00.000Z', JSON.stringify({ x: { input: 1, output: 0, cacheCreation: 0, cacheRead: 0 } }), utilization, 'a', 100);
    const state = computeState(db, TEST_CONFIG.weights, false, 1000);
    assert.equal(state.users[0].usedPercent, 45);
    assert.equal(state.users[1].usedPercent, 15);
    assert.equal(state.users[0].quotaRatioPercent, 75);
    assert.equal(state.users[0].machines[0].usedPercent, 45);
    assert.equal(state.users[1].machines[0].observedSharePercent, 25);
  } finally { db.close(); }
});

test('quota phải đủ người và tổng bằng 100', () => {
  const db = openDatabase(':memory:');
  try {
    db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run('alice', 50, 0, 1);
    db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run('bob', 50, 0, 1);
    assert.throws(() => updateQuotas(db, { alice: 60, bob: 30 }), /QUOTA_TOTAL/);
    assert.throws(() => updateQuotas(db, { alice: 100 }), /QUOTA_USERS_MISMATCH/);
    updateQuotas(db, { alice: 60, bob: 40 });
    assert.deepEqual((db.prepare('SELECT quota_percent AS quota FROM users ORDER BY username').all() as unknown as Array<{ quota: number }>).map((x) => x.quota), [60, 40]);
  } finally { db.close(); }
});

test('người mới được chia đều nếu chưa chỉnh tay, hoặc nhận 0 sau khi chỉnh tay', async () => {
  const app = await testServer();
  try {
    await register(app.baseUrl, 'alice', '7f19d0d8-8c54-4ee3-a463-8cc45f632b14');
    await register(app.baseUrl, 'bob', '84ce552b-2ac6-4d12-b552-e67f09f64612');
    let quotas = app.db.prepare('SELECT quota_percent AS quota FROM users ORDER BY username').all() as unknown as Array<{ quota: number }>;
    assert.deepEqual(quotas.map((x) => x.quota), [50, 50]);
    updateQuotas(app.db, { alice: 70, bob: 30 });
    await register(app.baseUrl, 'carol', '9b9e10c5-44f7-4e6f-90d1-385f025f18bf');
    quotas = app.db.prepare('SELECT quota_percent AS quota FROM users ORDER BY username').all() as unknown as Array<{ quota: number }>;
    assert.deepEqual(quotas.map((x) => x.quota), [70, 30, 0]);
  } finally { await app.close(); }
});
