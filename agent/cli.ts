#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { emptyState, scanClaudeHome, type AgentState } from './scan.ts';
import { USERNAME_RE } from '../hub/validate.ts';
import { nextWeeklyReset } from '../hub/schedule.ts';
import type { ResetSchedule } from '../shared/types.ts';

const VERSION = '0.1.0';
const CONFIG_PATH = join(homedir(), '.claude-storage-agent.json');
const STATE_PATH = join(homedir(), '.claude-storage-agent.state.json');

interface AgentConfig { hub: string; username: string; machineId: string; machineToken: string }

async function readJson<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

async function question(label: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try { return (await rl.question(label)).trim(); } finally { rl.close(); }
}

async function secretQuestion(label: string): Promise<string> {
  if (!stdin.isTTY || !stdin.setRawMode) throw new Error('Cần chạy trong terminal tương tác để nhập khóa đăng ký an toàn.');
  stdout.write(label);
  stdin.setRawMode(true);
  stdin.resume();
  let value = '';
  try {
    for await (const chunk of stdin) {
      const text = String(chunk);
      for (const character of text) {
        if (character === '\u0003') throw new Error('Đã hủy.');
        if (character === '\r' || character === '\n') { stdout.write('\n'); return value; }
        if (character === '\u007f') { value = value.slice(0, -1); continue; }
        if (character >= ' ') value += character;
      }
    }
  } finally { stdin.setRawMode(false); stdin.pause(); }
  return value;
}

function normalizeHub(raw: string): string {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Địa chỉ hub phải là URL HTTP(S) không chứa tài khoản hoặc mật khẩu.');
  return url.href.replace(/\/$/, '');
}

async function register(args: string[]): Promise<void> {
  const hubIndex = args.indexOf('--hub');
  if (hubIndex < 0 || !args[hubIndex + 1]) throw new Error('Cách dùng: register --hub http://100.x.y.z:4318');
  const hub = normalizeHub(args[hubIndex + 1]);
  const existing = await readJson<AgentConfig>(CONFIG_PATH);
  if (existing) {
    const answer = (await question('Máy đã đăng ký. Đăng ký lại và thu hồi token cũ? [y/N] ')).toLowerCase();
    if (!['y', 'yes', 'c', 'co', 'có'].includes(answer)) { console.info('Giữ nguyên đăng ký hiện tại.'); return; }
  }
  let username = '';
  while (!USERNAME_RE.test(username)) {
    username = (await question('Username (2–32 ký tự: a-z, 0-9, - hoặc _): ')).toLowerCase();
    if (!USERNAME_RE.test(username)) console.info('Username không hợp lệ, vui lòng nhập lại.');
  }
  const enrollKey = await secretQuestion('HUB_ENROLL_KEY: ');
  const machineId = existing?.machineId ?? randomUUID();
  const response = await fetch(`${hub}/api/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-enroll-key': enrollKey },
    body: JSON.stringify({ username, machineId, hostname: hostname() }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Hub từ chối đăng ký (HTTP ${response.status}).`);
  const result = await response.json() as { machineToken?: unknown };
  if (typeof result.machineToken !== 'string' || result.machineToken.length < 32) throw new Error('Hub trả về dữ liệu không hợp lệ.');
  await writePrivateJson(CONFIG_PATH, { hub, username, machineId, machineToken: result.machineToken });
  console.info(`Đã đăng ký máy cho ${username}.`);
}

export async function buildReport(config: AgentConfig, state: AgentState, claudeHome = join(homedir(), '.claude'), now = Date.now(), schedule: ResetSchedule | null = null) {
  const scanned = await scanClaudeHome(claudeHome, state, now, schedule ? nextWeeklyReset(now, schedule) : undefined);
  return {
    payload: { machineId: config.machineId, ...scanned.payload, agentVersion: VERSION, sentAtMs: now },
    state: scanned.state,
  };
}

async function report(): Promise<void> {
  const config = await readJson<AgentConfig>(CONFIG_PATH);
  if (!config) throw new Error('Máy chưa đăng ký. Hãy chạy lệnh register trước.');
  const state = await readJson<AgentState>(STATE_PATH) ?? emptyState();
  const now = Date.now();
  if (state.lastSentMs && now - state.lastSentMs < 60_000) { console.info('Bỏ qua: lần báo trước chưa đủ 60 giây.'); return; }
  const settingsResponse = await fetch(`${config.hub}/api/agent-settings`, {
    headers: { authorization: `Bearer ${config.machineToken}` }, signal: AbortSignal.timeout(10_000),
  });
  if (!settingsResponse.ok) throw new Error(`Không lấy được lịch reset từ hub (HTTP ${settingsResponse.status}).`);
  const settings = await settingsResponse.json() as { resetSchedule: ResetSchedule | null };
  const result = await buildReport(config, state, join(homedir(), '.claude'), now, settings.resetSchedule);
  const response = await fetch(`${config.hub}/api/report`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.machineToken}` },
    body: JSON.stringify(result.payload), signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Hub từ chối báo cáo (HTTP ${response.status}).`);
  result.state.lastSentMs = now;
  await writePrivateJson(STATE_PATH, result.state);
  console.info('Đã gửi số liệu tổng hợp lên hub.');
}

function printHook(): void {
  const cli = resolve(process.argv[1]);
  console.info(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `node ${JSON.stringify(cli)} report` }] }] } }, null, 2));
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'register') return register(args);
  if (command === 'report') return report();
  if (command === 'print-hook') return printHook();
  throw new Error('Cách dùng: node agent/cli.ts <register|report|print-hook>');
}

if (resolve(process.argv[1] ?? '') === resolve(new URL(import.meta.url).pathname)) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
