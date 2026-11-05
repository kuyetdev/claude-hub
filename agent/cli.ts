#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { chmod, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { spawn } from 'node:child_process';
import { emptyState, scanClaudeHome, type AgentState } from './scan.ts';
import type { ReportPayload } from '../shared/types.ts';
import { USERNAME_RE } from '../hub/validate.ts';
import { installClaudeHook } from './hook.ts';

const VERSION = '0.2.0';
const CONFIG_PATH = join(homedir(), '.claude-storage-agent.json');
const STATE_PATH = join(homedir(), '.claude-storage-agent.state.json');
const RATE_LIMIT_PATH = join(homedir(), '.claude-storage-agent.rate-limits.json');
const STATUS_LINE_CONFIG_PATH = join(homedir(), '.claude-storage-agent.statusline.json');
const REPORT_LOCK_PATH = `${STATE_PATH}.lock`;

interface AgentConfig { hub: string; username: string; machineId: string; machineToken: string; accountTrackingSince?: Record<string, number> }

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

async function acquireReportLock(): Promise<() => Promise<void>> {
  const deadline = Date.now() + 15_000;
  while (true) {
    try {
      const handle = await open(REPORT_LOCK_PATH, 'wx', 0o600);
      await handle.writeFile(`${process.pid}\n${Date.now()}\n`);
      const owner = await handle.stat();
      return async () => {
        await handle.close();
        try {
          const current = await stat(REPORT_LOCK_PATH);
          if (current.ino === owner.ino && current.dev === owner.dev) await unlink(REPORT_LOCK_PATH);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const lock = await stat(REPORT_LOCK_PATH);
        if (Date.now() - lock.mtimeMs > 5 * 60_000) {
          await unlink(REPORT_LOCK_PATH).catch(() => undefined);
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw statError;
      }
      if (Date.now() >= deadline) throw new Error('Một lượt báo cáo khác đang chạy quá lâu; lượt này sẽ được thử lại ở lần chat tiếp theo.');
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
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
  if (existing?.hub === hub) {
    console.info(`Máy đã đăng ký cho ${existing.username}; giữ nguyên đăng ký hiện tại.`);
    return;
  }
  let username = existing?.username ?? '';
  while (!existing && !USERNAME_RE.test(username)) {
    username = (await question('Username (2–32 ký tự: a-z, 0-9, - hoặc _): ')).toLowerCase();
    if (!USERNAME_RE.test(username)) console.info('Username không hợp lệ, vui lòng nhập lại.');
  }
  const machineId = existing?.machineId ?? randomUUID();
  const accountTrackingSince = { ...(existing?.accountTrackingSince ?? {}) };
  let response: Response;
  try {
    response = await fetch(`${hub}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, machineId, hostname: hostname() }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : '';
    throw new Error(`Không kết nối được Claude Hub tại ${hub}. Kiểm tra DNS, Cloudflare Tunnel và kết nối mạng.${cause}`);
  }
  if (!response.ok) throw new Error(`Hub từ chối đăng ký (HTTP ${response.status}).`);
  const result = await response.json() as { machineToken?: unknown };
  if (typeof result.machineToken !== 'string' || result.machineToken.length < 32) throw new Error('Hub trả về dữ liệu không hợp lệ.');
  await writePrivateJson(CONFIG_PATH, { hub, username, machineId, machineToken: result.machineToken, accountTrackingSince });
  console.info(`Đã đăng ký máy cho ${username}.`);
}

export async function buildReport(config: AgentConfig, state: AgentState, claudeHome = join(homedir(), '.claude'), now = Date.now(), rateLimitCachePath = RATE_LIMIT_PATH) {
  const scanned = await scanClaudeHome(claudeHome, state, now, undefined, rateLimitCachePath, config.accountTrackingSince ?? 0);
  return {
    payload: { machineId: config.machineId, ...scanned.payload, agentVersion: VERSION, sentAtMs: now },
    state: scanned.state,
  };
}

async function report(args: string[] = []): Promise<void> {
  const settleIndex = args.indexOf('--settle-ms');
  const settleMs = settleIndex >= 0 ? Number(args[settleIndex + 1]) : 0;
  if (Number.isFinite(settleMs) && settleMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(settleMs, 10_000)));
  // Stop hooks are async and can overlap, so serialize the entire state/report transaction.
  const releaseLock = await acquireReportLock();
  try {
    const config = await readJson<AgentConfig>(CONFIG_PATH);
    if (!config) throw new Error('Máy chưa đăng ký. Hãy chạy lệnh register trước.');
    let state = await readJson<AgentState>(STATE_PATH) ?? emptyState();

    const sendReport = async (payload: ReportPayload) => {
      const response = await fetch(config.hub + '/api/report', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + config.machineToken },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error('Hub từ chối báo cáo (HTTP ' + response.status + ').');
    };

    // A server may save the report while its response gets lost. Retry the exact same snapshot.
    if (state.pendingReport) {
      await sendReport(state.pendingReport);
      const { pendingReport: _sent, ...committed } = state;
      state = committed;
      await writePrivateJson(STATE_PATH, state);
    }

    const now = Date.now();
    const claudeConfig = await readJson<{ oauthAccount?: { accountUuid?: unknown; email?: unknown; emailAddress?: unknown } }>(join(homedir(), '.claude.json'));
    const accountUuid = claudeConfig?.oauthAccount?.accountUuid;
    if (typeof accountUuid !== 'string' || accountUuid.length < 3) throw new Error('Không tìm thấy accountUuid trong ~/.claude.json.');
    const rawEmail = claudeConfig?.oauthAccount?.email ?? claudeConfig?.oauthAccount?.emailAddress;
    const trackingResponse = await fetch(config.hub + '/api/account-tracking', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + config.machineToken },
      body: JSON.stringify({ accountUuid, ...(typeof rawEmail === 'string' ? { accountEmail: rawEmail } : {}) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!trackingResponse.ok) throw new Error('Hub từ chối cập nhật account (HTTP ' + trackingResponse.status + ').');
    const tracking = await trackingResponse.json() as { trackingSinceMs?: unknown };
    if (typeof tracking.trackingSinceMs !== 'number' || !Number.isFinite(tracking.trackingSinceMs)) throw new Error('Hub trả về mốc theo dõi không hợp lệ.');
    config.accountTrackingSince = { ...(config.accountTrackingSince ?? {}), [accountUuid]: tracking.trackingSinceMs };
    await writePrivateJson(CONFIG_PATH, config);
    const result = await buildReport(config, state, join(homedir(), '.claude'), now);

    // Save cursor and immutable report before posting. Retries won't rescan and add the same
    // JSONL usage to the previous total a second time.
    await writePrivateJson(STATE_PATH, { ...result.state, pendingReport: result.payload });
    await sendReport(result.payload);
    await writePrivateJson(STATE_PATH, result.state);
    console.info('Đã gửi số liệu tổng hợp lên hub.');
  } finally {
    await releaseLock();
  }
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
  const reportCommand = `${command} --settle-ms 2500`;
  await installClaudeHook(join(homedir(), '.claude', 'settings.json'), reportCommand, { command: statusLineCommand, configPath: STATUS_LINE_CONFIG_PATH });
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
  if (command === 'report') return report(args);
  if (command === 'print-hook') return printHook();
  if (command === 'install-hook') return installHook(args);
  if (command === 'statusline') return statusline();
  throw new Error('Cách dùng: node agent/cli.ts <register|report|print-hook|install-hook|statusline>');
}

if (resolve(process.argv[1] ?? '') === resolve(new URL(import.meta.url).pathname)) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
