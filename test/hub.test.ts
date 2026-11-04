import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register, testServer } from './helpers.ts';

test('đăng ký cần enroll key và thu hồi token cũ khi đăng ký lại', async () => {
  const app = await testServer();
  try {
    const denied = await fetch(`${app.baseUrl}/api/register`, { method: 'POST', body: '{}' });
    assert.equal(denied.status, 401);
    const first = await register(app.baseUrl);
    const second = await register(app.baseUrl);
    assert.equal(first.response.status, 201);
    assert.equal(second.response.status, 201);
    assert.notEqual(first.body.machineToken, second.body.machineToken);
  } finally { await app.close(); }
});

test('báo cáo kiểm tra schema, token máy, account và tần suất', async () => {
  const app = await testServer();
  try {
    const { body } = await register(app.baseUrl);
    const payload = {
      machineId: '7f19d0d8-8c54-4ee3-a463-8cc45f632b14', accountUuid: 'account-one',
      weekResetsAt: '2026-11-05T17:00:00.092989+00:00',
      utilization: { weeklyPercent: 71, fetchedAtMs: 1_793_688_982_149, fiveHourPercent: null },
      tokensByModel: { 'claude-test': { input: 1, output: 2, cacheCreation: 3, cacheRead: 4 } },
      agentVersion: '0.1.0', sentAtMs: 1_793_688_982_149,
    };
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${body.machineToken}` };
    assert.equal((await fetch(`${app.baseUrl}/api/report`, { method: 'POST', headers, body: '{}' })).status, 400);
    assert.equal((await fetch(`${app.baseUrl}/api/report`, { method: 'POST', headers, body: JSON.stringify(payload) })).status, 202);
    assert.equal((await fetch(`${app.baseUrl}/api/report`, { method: 'POST', headers, body: JSON.stringify(payload) })).status, 429);
  } finally { await app.close(); }
});
