import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { installClaudeHook } from '../agent/hook.ts';

test('cài hook Stop giữ nguyên settings, tạo backup và không nhân đôi hook hub', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-hub-hook-'));
  const claude = join(home, '.claude');
  const settingsPath = join(claude, 'settings.json');
  await mkdir(claude);
  const original = { theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo existing' }] }] } };
  await writeFile(settingsPath, JSON.stringify(original));
  await installClaudeHook(settingsPath, '/home/test/.local/bin/claude-hub-agent report');
  await installClaudeHook(settingsPath, '/home/test/.local/bin/claude-hub-agent report');
  const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as { theme: string; hooks: { Stop: Array<{ hooks: Array<{ command: string; async?: boolean }> }> } };
  assert.equal(settings.theme, 'dark');
  assert.equal(settings.hooks.Stop.length, 2);
  assert.equal(settings.hooks.Stop[1].hooks[0].async, true);
  assert.match(await readFile(`${settingsPath}.claude-hub.bak`, 'utf8'), /claude-hub-agent/);
});
