import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { HubConfig } from './config.ts';
import type { ReportPayload } from '../shared/types.ts';
import { redact, redactDeep } from '../server/redact.ts';
import { isReport, normalizeWeekKey, USERNAME_RE, UUID_RE } from './validate.ts';
import { computeState, updateQuotas } from './usage.ts';
import { createInstallScript } from './install.ts';

const MAX_BODY_BYTES = 64 * 1024;

export type AlertCheck = (weekKey: string) => Promise<void>;

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(redactDeep(value));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function sendText(response: ServerResponse, status: number, value: string, contentType = 'text/plain; charset=utf-8'): void {
  const body = redact(value);
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-disposition': 'inline',
  });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const declared = Number(request.headers['content-length'] ?? 0);
  if (declared > MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE');
    chunks.push(buffer);
  }
  if (size === 0) throw new Error('EMPTY_BODY');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('INVALID_JSON'); }
}

function registerMachine(db: DatabaseSync, body: Record<string, unknown>): string {
  const username = String(body.username ?? '');
  const machineId = String(body.machineId ?? '');
  const hostname = String(body.hostname ?? '');
  if (!USERNAME_RE.test(username) || !UUID_RE.test(machineId) || hostname.length < 1 || hostname.length > 253) {
    throw new Error('INVALID_REGISTER');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const existingUser = db.prepare('SELECT username FROM users WHERE username = ?').get(username);
    if (!existingUser) {
      const count = Number((db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count);
      const hasManual = Boolean(db.prepare('SELECT 1 FROM users WHERE quota_manual = 1 LIMIT 1').get());
      if (!hasManual) db.prepare('UPDATE users SET quota_percent = ?, quota_manual = 0').run(100 / (count + 1));
      db.prepare('INSERT INTO users(username, quota_percent, quota_manual, created_at) VALUES (?, ?, 0, ?)')
        .run(username, hasManual ? 0 : 100 / (count + 1), Date.now());
    }
    const token = randomBytes(32).toString('hex');
    db.prepare(`
      INSERT INTO machines(machine_id, username, hostname, token_hash, last_seen_ms, agent_version)
      VALUES (?, ?, ?, ?, 0, '')
      ON CONFLICT(machine_id) DO UPDATE SET
        username = excluded.username,
        hostname = excluded.hostname,
        token_hash = excluded.token_hash,
        last_seen_ms = 0,
        agent_version = ''
    `).run(machineId, username, hostname, tokenHash(token));
    db.prepare('DELETE FROM reports WHERE machine_id = ?').run(machineId);
    db.exec('COMMIT');
    return token;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function authorizeMachine(db: DatabaseSync, request: IncomingMessage): { machineId: string } | undefined {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) return undefined;
  const hash = tokenHash(authorization.slice(7));
  return db.prepare('SELECT machine_id AS machineId FROM machines WHERE token_hash = ?').get(hash) as { machineId: string } | undefined;
}

function saveReport(db: DatabaseSync, report: ReportPayload, now: number): string {
  const weekKey = normalizeWeekKey(report.weekResetsAt);
  const existingAccount = db.prepare("SELECT value FROM settings WHERE key = 'accountUuid'").get() as { value: string } | undefined;
  if (existingAccount && existingAccount.value !== report.accountUuid) throw new Error('ACCOUNT_CONFLICT');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!existingAccount) db.prepare("INSERT INTO settings(key, value) VALUES ('accountUuid', ?)").run(report.accountUuid);
    db.prepare(`
      INSERT INTO reports(machine_id, week_key, tokens_json, utilization_json, account_uuid, received_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(machine_id) DO UPDATE SET
        week_key = excluded.week_key,
        tokens_json = excluded.tokens_json,
        utilization_json = excluded.utilization_json,
        account_uuid = excluded.account_uuid,
        received_ms = excluded.received_ms
    `).run(report.machineId, weekKey, JSON.stringify(report.tokensByModel), JSON.stringify(report.utilization), report.accountUuid, now);
    db.prepare('UPDATE machines SET last_seen_ms = ?, agent_version = ? WHERE machine_id = ?')
      .run(now, report.agentVersion, report.machineId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return weekKey;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8',
};

function serveStatic(response: ServerResponse, distDir: string, pathname: string): void {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const safe = normalize(relative).replace(/^(\.\.(\/|\\|$))+/, '');
  const path = join(distDir, safe);
  const selected = existsSync(path) && statSync(path).isFile() ? path : join(distDir, 'index.html');
  if (!existsSync(selected)) return sendJson(response, 404, { error: 'Dashboard chưa được build.' });
  const body = readFileSync(selected);
  response.writeHead(200, {
    'content-type': MIME[extname(selected)] ?? 'application/octet-stream',
    'content-length': body.length,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
  });
  response.end(body);
}

export function createHandler(db: DatabaseSync, config: HubConfig, options: { distDir?: string; checkAlerts?: AlertCheck; now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const distDir = options.distDir ?? join(process.cwd(), 'dist');
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    try {
      if (request.method === 'POST' && url.pathname === '/api/register') {
        const body = await readJson(request) as Record<string, unknown>;
        return sendJson(response, 201, { machineToken: registerMachine(db, body) });
      }
      if (request.method === 'POST' && url.pathname === '/api/report') {
        const machine = authorizeMachine(db, request);
        if (!machine) return sendJson(response, 401, { error: 'Token máy không hợp lệ.' });
        const body = await readJson(request);
        if (!isReport(body) || body.machineId !== machine.machineId) return sendJson(response, 400, { error: 'Báo cáo không hợp lệ.' });
        const weekKey = saveReport(db, body, now());
        sendJson(response, 202, { ok: true });
        void options.checkAlerts?.(weekKey).catch((error: unknown) => console.error(redact(`Không thể kiểm tra cảnh báo: ${error instanceof Error ? error.message : String(error)}`)));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/install/ubuntu.sh') {
        return sendText(response, 200, createInstallScript('ubuntu', config));
      }
      if (request.method === 'GET' && url.pathname === '/install/macos.sh') {
        return sendText(response, 200, createInstallScript('macos', config));
      }
      if (request.method === 'GET' && url.pathname === '/api/state') {
        return sendJson(response, 200, computeState(db, config.weights, Boolean(config.telegramToken && config.telegramChatId), now()));
      }
      if (request.method === 'PUT' && url.pathname === '/api/quota') {
        updateQuotas(db, await readJson(request));
        return sendJson(response, 200, { ok: true });
      }
      const machineMatch = request.method === 'DELETE' ? url.pathname.match(/^\/api\/machines\/([^/]+)$/) : null;
      if (machineMatch) {
        const result = db.prepare('DELETE FROM machines WHERE machine_id = ?').run(decodeURIComponent(machineMatch[1]));
        if (result.changes === 0) return sendJson(response, 404, { error: 'Không tìm thấy máy.' });
        return sendJson(response, 200, { ok: true });
      }
      if (url.pathname.startsWith('/api/')) return sendJson(response, 404, { error: 'API không tồn tại.' });
      if (request.method !== 'GET' && request.method !== 'HEAD') return sendJson(response, 405, { error: 'Phương thức không được hỗ trợ.' });
      return serveStatic(response, distDir, url.pathname);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'BODY_TOO_LARGE') return sendJson(response, 413, { error: 'Dữ liệu vượt quá 64 KB.' });
      if (code === 'ACCOUNT_CONFLICT') return sendJson(response, 409, { error: 'Báo cáo thuộc tài khoản Claude khác.' });
      if (['QUOTA_TOTAL', 'QUOTA_USERS_MISMATCH', 'INVALID_QUOTA'].includes(code)) {
        const message = code === 'QUOTA_TOTAL' ? 'Tổng quota phải bằng 100%.' : code === 'QUOTA_USERS_MISMATCH' ? 'Danh sách người không khớp.' : 'Quota không hợp lệ.';
        return sendJson(response, 422, { error: message });
      }
      if (['INVALID_JSON', 'EMPTY_BODY', 'INVALID_REGISTER'].includes(code)) return sendJson(response, 400, { error: 'Dữ liệu không hợp lệ.' });
      console.error(redact(`Lỗi hub: ${error instanceof Error ? error.message : String(error)}`));
      return sendJson(response, 500, { error: 'Hub gặp lỗi nội bộ.' });
    }
  };
}
