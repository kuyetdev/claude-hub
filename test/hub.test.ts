import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register, testServer, TEST_CONFIG } from './helpers.ts';

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

test('hub từ chối tài khoản Claude thứ hai', async () => {
  let clock = 1_000_000;
  const app = await testServer({ now: () => clock });
  try {
    const first = await register(app.baseUrl, 'alice', '7f19d0d8-8c54-4ee3-a463-8cc45f632b14');
    const second = await register(app.baseUrl, 'bob', '84ce552b-2ac6-4d12-b552-e67f09f64612');
    const makePayload = (machineId: string, accountUuid: string) => ({
      machineId, accountUuid, weekResetsAt: '2026-11-05T17:00:00Z',
      utilization: { weeklyPercent: 10, fetchedAtMs: clock, fiveHourPercent: null },
      tokensByModel: {}, agentVersion: '0.1.0', sentAtMs: clock,
    });
    const post = (token: string, payload: unknown) => fetch(`${app.baseUrl}/api/report`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(payload),
    });
    assert.equal((await post(first.body.machineToken, makePayload('7f19d0d8-8c54-4ee3-a463-8cc45f632b14', 'account-one'))).status, 202);
    clock += 31_000;
    assert.equal((await post(second.body.machineToken, makePayload('84ce552b-2ac6-4d12-b552-e67f09f64612', 'account-two'))).status, 409);
  } finally { await app.close(); }
});

test('API quota cần admin key và từ chối tổng khác 100', async () => {
  const app = await testServer();
  try {
    await register(app.baseUrl);
    const call = (key: string, quota: number) => fetch(`${app.baseUrl}/api/quota`, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-admin-key': key }, body: JSON.stringify({ alice: quota }),
    });
    assert.equal((await call('sai', 100)).status, 401);
    assert.equal((await call('admin-test-value', 90)).status, 422);
    assert.equal((await call('admin-test-value', 100)).status, 200);
  } finally { await app.close(); }
});

test('API lịch reset cần admin key và agent đọc được lịch', async () => {
  const app = await testServer();
  try {
    const registered = await register(app.baseUrl);
    const save = await fetch(`${app.baseUrl}/api/reset-schedule`, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-admin-key': TEST_CONFIG.adminKey },
      body: JSON.stringify({ dayOfWeek: 5, time: '09:15' }),
    });
    assert.equal(save.status, 200);
    const settings = await fetch(`${app.baseUrl}/api/agent-settings`, { headers: { authorization: `Bearer ${registered.body.machineToken}` } });
    assert.equal(settings.status, 200);
    assert.deepEqual(await settings.json(), { resetSchedule: { dayOfWeek: 5, time: '09:15', timezone: 'Asia/Ho_Chi_Minh' } });
  } finally { await app.close(); }
});
