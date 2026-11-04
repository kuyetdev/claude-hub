import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { installClaudeHook } from '../agent/hook.ts';

test('cài hook Stop giữ nguyên settings, tạo backup và không nhân đôi hook hub', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-hub-hook-'));
  const claude = join(home, '.claude');
  const settingsPath = join(claude, 'settings.json');
  await mkdir(claude);
  const original = { theme: 'dark', statusLine: { type: 'command', command: 'echo existing-status' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo existing' }] }] } };
  await writeFile(settingsPath, JSON.stringify(original));
  const statusConfig = join(home, '.claude-storage-agent.statusline.json');
  await installClaudeHook(settingsPath, '/home/test/.local/bin/claude-hub-agent report', { command: '/home/test/.local/bin/claude-hub-agent statusline', configPath: statusConfig });
  await installClaudeHook(settingsPath, '/home/test/.local/bin/claude-hub-agent report', { command: '/home/test/.local/bin/claude-hub-agent statusline', configPath: statusConfig });
  const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as { theme: string; statusLine: { command: string }; hooks: { Stop: Array<{ hooks: Array<{ command: string; async?: boolean }> }> } };
  assert.equal(settings.theme, 'dark');
  assert.equal(settings.hooks.Stop.length, 2);
  assert.equal(settings.hooks.Stop[1].hooks[0].async, true);
  assert.match(settings.statusLine.command, /statusline/);
  assert.deepEqual(JSON.parse(await readFile(statusConfig, 'utf8')), { command: 'echo existing-status' });
  assert.match(await readFile(`${settingsPath}.claude-hub.bak`, 'utf8'), /claude-hub-agent/);
});

test('statusLine chỉ lưu quota tổng hợp từ response Claude', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-hub-statusline-'));
  await writeFile(join(home, '.claude-storage-agent.statusline.json'), JSON.stringify({ command: 'true' }));
  const child = spawn(process.execPath, [join(process.cwd(), 'agent', 'cli.ts'), 'statusline'], {
    env: { ...process.env, HOME: home }, stdio: ['pipe', 'ignore', 'pipe'],
  });
  child.stdin.end(JSON.stringify({
    model: { display_name: 'Claude' },
    transcript_path: '/secret/path',
    rate_limits: {
      five_hour: { used_percentage: 11, resets_at: 1772622000 },
      seven_day: { utilization: 37.5, resets_at: '2026-03-11T10:00:00Z' },
    },
  }));
  const exitCode = await new Promise<number | null>((resolveExit) => child.on('close', resolveExit));
  assert.equal(exitCode, 0);
  const cache = JSON.parse(await readFile(join(home, '.claude-storage-agent.rate-limits.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(JSON.stringify(cache).includes('secret'), false);
  assert.deepEqual(cache.fiveHour, { usedPercentage: 11, resetsAt: 1772622000 });
  assert.deepEqual(cache.sevenDay, { usedPercentage: 37.5, resetsAt: '2026-03-11T10:00:00Z' });
});
