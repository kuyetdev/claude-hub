#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { spawn } from 'node:child_process';
import { emptyState, scanClaudeHome, type AgentState } from './scan.ts';
import { USERNAME_RE } from '../hub/validate.ts';
import { installClaudeHook } from './hook.ts';

const VERSION = '0.1.0';
const CONFIG_PATH = join(homedir(), '.claude-storage-agent.json');
const STATE_PATH = join(homedir(), '.claude-storage-agent.state.json');
const RATE_LIMIT_PATH = join(homedir(), '.claude-storage-agent.rate-limits.json');
const STATUS_LINE_CONFIG_PATH = join(homedir(), '.claude-storage-agent.statusline.json');

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
  const machineId = existing?.machineId ?? randomUUID();
  const response = await fetch(`${hub}/api/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, machineId, hostname: hostname() }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Hub từ chối đăng ký (HTTP ${response.status}).`);
  const result = await response.json() as { machineToken?: unknown };
  if (typeof result.machineToken !== 'string' || result.machineToken.length < 32) throw new Error('Hub trả về dữ liệu không hợp lệ.');
  await writePrivateJson(CONFIG_PATH, { hub, username, machineId, machineToken: result.machineToken });
  console.info(`Đã đăng ký máy cho ${username}.`);
}

export async function buildReport(config: AgentConfig, state: AgentState, claudeHome = join(homedir(), '.claude'), now = Date.now(), rateLimitCachePath = RATE_LIMIT_PATH) {
  const scanned = await scanClaudeHome(claudeHome, state, now, undefined, rateLimitCachePath);
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
  const result = await buildReport(config, state, join(homedir(), '.claude'), now);
  const response = await fetch(`${config.hub}/api/report`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.machineToken}` },
    body: JSON.stringify(result.payload), signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Hub từ chối báo cáo (HTTP ${response.status}).`);
  await writePrivateJson(STATE_PATH, result.state);
  console.info('Đã gửi số liệu tổng hợp lên hub.');
}

function printHook(): void {
  const cli = resolve(process.argv[1]);
  console.info(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `node ${JSON.stringify(cli)} report` }] }] } }, null, 2));
}

async function installHook(args: string[]): Promise<void> {
  const commandIndex = args.indexOf('--command');
  const command = commandIndex >= 0 ? args[commandIndex + 1] : `node ${JSON.stringify(resolve(process.argv[1]))} report`;
  if (!command) throw new Error('Thiếu command cho hook.');
  const statusLineCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(resolve(process.argv[1]))} statusline`;
  await installClaudeHook(join(homedir(), '.claude', 'settings.json'), command, { command: statusLineCommand, configPath: STATUS_LINE_CONFIG_PATH });
  console.info('Đã cài statusLine + hook Stop. Quota được ghi từ response và gửi khi mỗi lượt chat hoàn tất.');
}

type LimitWindow = { used_percentage?: unknown; utilization?: unknown; resets_at?: unknown };

function safeWindow(value: unknown): { usedPercentage: number; resetsAt?: string | number } | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as LimitWindow;
  const percent = typeof raw.used_percentage === 'number' ? raw.used_percentage : typeof raw.utilization === 'number' ? raw.utilization : undefined;
  if (percent === undefined || !Number.isFinite(percent)) return null;
  const resetsAt = typeof raw.resets_at === 'string' || typeof raw.resets_at === 'number' ? raw.resets_at : undefined;
  return { usedPercentage: percent, ...(resetsAt === undefined ? {} : { resetsAt }) };
}

async function statusline(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  const input = Buffer.concat(chunks);
  try {
    const payload = JSON.parse(input.toString('utf8')) as { rate_limits?: { five_hour?: unknown; seven_day?: unknown } };
    const fiveHour = safeWindow(payload.rate_limits?.five_hour);
    const sevenDay = safeWindow(payload.rate_limits?.seven_day);
    if (fiveHour || sevenDay) await writePrivateJson(RATE_LIMIT_PATH, { fetchedAtMs: Date.now(), fiveHour, sevenDay });
  } catch { /* Claude may call statusLine before rate_limits are available. */ }

  const previous = await readJson<{ command?: unknown }>(STATUS_LINE_CONFIG_PATH);
  if (typeof previous?.command !== 'string' || !previous.command) return;
  await new Promise<void>((resolvePromise) => {
    const child = spawn('/bin/sh', ['-lc', previous.command as string], { stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', () => resolvePromise());
    child.on('close', () => resolvePromise());
    child.stdin.end(input);
  });
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'register') return register(args);
  if (command === 'report') return report();
  if (command === 'print-hook') return printHook();
  if (command === 'install-hook') return installHook(args);
  if (command === 'statusline') return statusline();
  throw new Error('Cách dùng: node agent/cli.ts <register|report|print-hook|install-hook|statusline>');
}

if (resolve(process.argv[1] ?? '') === resolve(new URL(import.meta.url).pathname)) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
