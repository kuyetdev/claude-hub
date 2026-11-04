import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildReport } from '../agent/cli.ts';
import { emptyState, scanClaudeHome } from '../agent/scan.ts';

async function fakeClaudeHome() {
  const home = await mkdtemp(join(tmpdir(), 'claude-hub-agent-'));
  const claude = join(home, '.claude');
  const project = join(claude, 'projects', '-bi-mat', 'subagents');
  await mkdir(project, { recursive: true });
  await writeFile(join(home, '.claude.json'), JSON.stringify({
    oauthAccount: { accountUuid: 'account-test' },
    cachedUsageUtilization: { fetchedAtMs: 1000, utilization: { seven_day: { utilization: 25, resets_at: '2026-11-05T17:00:00Z' }, five_hour: null } },
    secretToken: 'khong-duoc-gui',
  }));
  return { home, claude, file: join(project, 'agent.jsonl') };
}

function line(id: string, requestId: string, input: number, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    ...extra, requestId, timestamp: '2026-11-04T10:00:00Z', cwd: '/duong/dan/bi-mat',
    message: { id, model: 'claude-test', content: 'prompt tuyệt mật', usage: { input_tokens: input, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 } },
  });
}

test('quét JSONL khử trùng, đọc tăng dần và không đưa dữ liệu nhạy cảm vào payload', async () => {
  const fixture = await fakeClaudeHome();
  await writeFile(fixture.file, `${line('m1', 'r1', 10)}\n${line('m1', 'r1', 10)}\n`);
  const first = await scanClaudeHome(fixture.claude, emptyState());
  assert.equal(first.payload.tokensByModel['claude-test'].input, 10);
  await appendFile(fixture.file, `${line('m2', 'r2', 7)}\n`);
  const second = await scanClaudeHome(fixture.claude, first.state);
  assert.equal(second.payload.tokensByModel['claude-test'].input, 17);
  const report = await buildReport({ hub: 'http://hub', username: 'alice', machineId: '7f19d0d8-8c54-4ee3-a463-8cc45f632b14', machineToken: 'token-bi-mat' }, second.state, fixture.claude, 1234);
  const serialized = JSON.stringify(report.payload);
  assert.equal(serialized.includes('prompt tuyệt mật'), false);
  assert.equal(serialized.includes('/duong/dan/bi-mat'), false);
  assert.equal(serialized.includes('khong-duoc-gui'), false);
  assert.equal(serialized.includes('token-bi-mat'), false);
});

test('sang tuần mới xóa tổng cũ', async () => {
  const fixture = await fakeClaudeHome();
  await writeFile(fixture.file, `${line('m1', 'r1', 10)}\n`);
  const first = await scanClaudeHome(fixture.claude, emptyState());
  await writeFile(join(fixture.home, '.claude.json'), JSON.stringify({
    oauthAccount: { accountUuid: 'account-test' },
    cachedUsageUtilization: { fetchedAtMs: 2000, utilization: { seven_day: { utilization: 0, resets_at: '2026-11-12T17:00:00Z' } } },
  }));
  const second = await scanClaudeHome(fixture.claude, first.state);
  assert.deepEqual(second.payload.tokensByModel, {});
});

test('quota statusLine mới nhất được ưu tiên hơn cache trong claude.json', async () => {
  const fixture = await fakeClaudeHome();
  const rateLimits = join(fixture.home, '.claude-storage-agent.rate-limits.json');
  await writeFile(rateLimits, JSON.stringify({
    fetchedAtMs: 1772618400000,
    fiveHour: { usedPercentage: 12.5, resetsAt: 1772622000 },
    sevenDay: { usedPercentage: 41.25, resetsAt: 1773223200 },
  }));
  const result = await scanClaudeHome(fixture.claude, emptyState(), 1772618400000, undefined, rateLimits);
  assert.equal(result.payload.utilization.weeklyPercent, 41.25);
  assert.equal(result.payload.utilization.fiveHourPercent, 12.5);
  assert.equal(result.payload.utilization.fetchedAtMs, 1772618400000);
  assert.equal(result.payload.utilization.accountResetsAt, '2026-03-11T10:00:00.000Z');
});

test('lịch hub thay ranh giới kỳ token nhưng giữ giờ reset hạn mức Claude', async () => {
  const fixture = await fakeClaudeHome();
  await writeFile(fixture.file, `${line('m1', 'r1', 10)}\n`);
  const report = await buildReport(
    { hub: 'http://hub', username: 'alice', machineId: '7f19d0d8-8c54-4ee3-a463-8cc45f632b14', machineToken: 'token' },
    emptyState(), fixture.claude, Date.parse('2026-11-04T10:00:00Z'),
    { dayOfWeek: 4, time: '00:00', timezone: 'Asia/Ho_Chi_Minh' },
  );
  assert.equal(report.payload.weekResetsAt, '2026-11-04T17:00:00.000Z');
  assert.equal(report.payload.utilization.accountResetsAt, '2026-11-05T17:00:00.000Z');
});
