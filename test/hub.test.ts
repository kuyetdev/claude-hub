import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register, testServer } from './helpers.ts';
import { spawnSync } from 'node:child_process';

test('đăng ký không cần khóa và thu hồi token cũ khi đăng ký lại', async () => {
  const app = await testServer();
  try {
    const first = await register(app.baseUrl);
    const second = await register(app.baseUrl);
    assert.equal(first.response.status, 201);
    assert.equal(second.response.status, 201);
    assert.notEqual(first.body.machineToken, second.body.machineToken);
  } finally { await app.close(); }
});

test('báo cáo kiểm tra schema, token máy và nhận mỗi lượt chat', async () => {
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
    assert.equal((await fetch(`${app.baseUrl}/api/report`, { method: 'POST', headers, body: JSON.stringify(payload) })).status, 202);
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

test('API quota từ chối tổng khác 100', async () => {
  const app = await testServer();
  try {
    await register(app.baseUrl);
    const call = (quota: number) => fetch(`${app.baseUrl}/api/quota`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ alice: quota }),
    });
    assert.equal((await call(90)).status, 422);
    assert.equal((await call(100)).status, 200);
  } finally { await app.close(); }
});

test('script cài agent hỗ trợ Ubuntu và macOS mà không chứa secret', async () => {
  const app = await testServer();
  try {
    for (const platform of ['ubuntu', 'macos']) {
      const response = await fetch(`${app.baseUrl}/install/${platform}.sh`);
      const script = await response.text();
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /text\/plain/);
      assert.match(script, /claude-hub-agent/);
      assert.match(script, /register --hub/);
      assert.match(script, /install-hook/);
      assert.doesNotMatch(script, /OnUnitActiveSec|StartInterval/);
      assert.doesNotMatch(script, /HUB_ENROLL_KEY|x-enroll-key/);
      assert.equal(spawnSync('bash', ['-n'], { input: script }).status, 0);
    }
  } finally { await app.close(); }
});
