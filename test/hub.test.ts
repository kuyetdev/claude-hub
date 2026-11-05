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

test('một máy theo dõi được nhiều tài khoản Claude và mốc mới lấy lịch sử trong kỳ', async () => {
  let clock = 1_000_000;
  const app = await testServer({ now: () => clock });
  try {
    const first = await register(app.baseUrl, 'alice', '7f19d0d8-8c54-4ee3-a463-8cc45f632b14');
    const makePayload = (accountUuid: string, input = 1) => ({
      machineId: '7f19d0d8-8c54-4ee3-a463-8cc45f632b14', accountUuid, weekResetsAt: '2026-11-05T17:00:00Z',
      utilization: { weeklyPercent: 10, fetchedAtMs: clock, fiveHourPercent: null },
      tokensByModel: { 'claude-test': { input, output: 0, cacheCreation: 0, cacheRead: 0 } }, agentVersion: '0.1.0', sentAtMs: clock,
    });
    const post = (payload: unknown) => fetch(`${app.baseUrl}/api/report`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${first.body.machineToken}` }, body: JSON.stringify(payload),
    });
    assert.equal((await post(makePayload('account-one'))).status, 202);
    const tracking = await fetch(`${app.baseUrl}/api/account-tracking`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${first.body.machineToken}` },
      body: JSON.stringify({ accountUuid: 'account-two' }),
    });
    assert.equal(tracking.status, 200);
    assert.equal((await tracking.json() as { trackingSinceMs: number }).trackingSinceMs, 0);
    clock += 31_000;
    assert.equal((await post(makePayload('account-two', 5))).status, 202);
    assert.equal((app.db.prepare('SELECT COUNT(*) AS count FROM accounts').get() as { count: number }).count, 2);
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

test('chế độ chỉ cộng giữ số đã lưu, cho phép tắt và ghi lịch sử theo từng report', async () => {
  let clock = Date.parse('2026-11-05T16:00:00Z');
  const app = await testServer({ now: () => clock });
  try {
    const { body } = await register(app.baseUrl);
    const payload = (input: number) => ({
      machineId: '7f19d0d8-8c54-4ee3-a463-8cc45f632b14', accountUuid: 'account-one',
      weekResetsAt: '2026-11-05T17:00:00Z',
      utilization: { weeklyPercent: 50, fetchedAtMs: clock, fiveHourPercent: null },
      tokensByModel: { 'claude-test': { input, output: 0, cacheCreation: 0, cacheRead: 0 } },
      agentVersion: '0.1.0', sentAtMs: clock,
    });
    const post = (input: number) => fetch(`${app.baseUrl}/api/report`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${body.machineToken}` }, body: JSON.stringify(payload(input)),
    });
    await post(10);
    const olderMachine = await register(app.baseUrl, 'bob', '84ce552b-2ac6-4d12-b552-e67f09f64612');
    const stalePayload = { ...payload(500), machineId: '84ce552b-2ac6-4d12-b552-e67f09f64612', weekResetsAt: '2026-10-29T17:00:00Z' };
    await fetch(`${app.baseUrl}/api/report`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${olderMachine.body.machineToken}` }, body: JSON.stringify(stalePayload),
    });
    assert.equal((app.db.prepare('SELECT COUNT(*) AS count FROM reports').get() as { count: number }).count, 1, 'report kỳ cũ không được đưa ngược account về kỳ trước');
    clock += 61_000;
    await post(5);
    let stored = JSON.parse((app.db.prepare('SELECT tokens_json AS tokens FROM reports').get() as { tokens: string }).tokens) as Record<string, { input: number }>;
    assert.equal(stored['claude-test']!.input, 10, 'mặc định chỉ cộng, không giảm snapshot');
    const history = await fetch(`${app.baseUrl}/api/history?account=account-one`).then((response) => response.json()) as { points: Array<{ weightedTokensByUser: Record<string, number> }> };
    assert.equal(history.points.length, 2);
    assert.equal(history.points[1]!.weightedTokensByUser.alice, 10);

    await fetch(`${app.baseUrl}/api/settings/usage-append-only`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }),
    });
    clock += 61_000;
    await post(5);
    stored = JSON.parse((app.db.prepare('SELECT tokens_json AS tokens FROM reports').get() as { tokens: string }).tokens);
    assert.equal(stored['claude-test']!.input, 5, 'tắt chế độ thì report thay thế snapshot');
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
