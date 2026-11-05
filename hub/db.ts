import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      quota_percent REAL NOT NULL,
      quota_manual INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS machines (
      machine_id TEXT PRIMARY KEY,
      username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      hostname TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      last_seen_ms INTEGER NOT NULL DEFAULT 0,
      agent_version TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS reports (
      machine_id TEXT PRIMARY KEY REFERENCES machines(machine_id) ON DELETE CASCADE,
      week_key TEXT NOT NULL,
      tokens_json TEXT NOT NULL,
      utilization_json TEXT NOT NULL,
      account_uuid TEXT NOT NULL,
      received_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS accounts (
      account_uuid TEXT PRIMARY KEY,
      email TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS account_machines (
      account_uuid TEXT NOT NULL REFERENCES accounts(account_uuid) ON DELETE CASCADE,
      machine_id TEXT NOT NULL REFERENCES machines(machine_id) ON DELETE CASCADE,
      tracking_since_ms INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (account_uuid, machine_id)
    );
    CREATE TABLE IF NOT EXISTS account_users (
      account_uuid TEXT NOT NULL REFERENCES accounts(account_uuid) ON DELETE CASCADE,
      username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      quota_percent REAL NOT NULL DEFAULT 0,
      quota_manual INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (account_uuid, username)
    );
    CREATE TABLE IF NOT EXISTS alerts_sent (
      week_key TEXT NOT NULL,
      scope TEXT NOT NULL,
      threshold TEXT NOT NULL,
      sent_ms INTEGER NOT NULL,
      PRIMARY KEY (week_key, scope, threshold)
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const reportColumns = db.prepare('PRAGMA table_info(reports)').all() as unknown as Array<{ name: string; pk: number }>;
  const reportPk = reportColumns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);
  if (reportPk.join(',') !== 'account_uuid,machine_id') {
    db.exec(`
      BEGIN IMMEDIATE;
      INSERT OR IGNORE INTO accounts(account_uuid, email, created_at)
        SELECT account_uuid, NULL, MIN(received_ms) FROM reports GROUP BY account_uuid;
      INSERT OR IGNORE INTO account_machines(account_uuid, machine_id, tracking_since_ms)
        SELECT account_uuid, machine_id, 0 FROM reports;
      CREATE TABLE reports_v2 (
        machine_id TEXT NOT NULL REFERENCES machines(machine_id) ON DELETE CASCADE,
        week_key TEXT NOT NULL,
        tokens_json TEXT NOT NULL,
        utilization_json TEXT NOT NULL,
        account_uuid TEXT NOT NULL REFERENCES accounts(account_uuid) ON DELETE CASCADE,
        received_ms INTEGER NOT NULL,
        PRIMARY KEY (account_uuid, machine_id)
      );
      INSERT OR REPLACE INTO reports_v2(machine_id, week_key, tokens_json, utilization_json, account_uuid, received_ms)
        SELECT machine_id, week_key, tokens_json, utilization_json, account_uuid, received_ms FROM reports;
      DROP TABLE reports;
      ALTER TABLE reports_v2 RENAME TO reports;
      INSERT OR IGNORE INTO account_users(account_uuid, username, quota_percent, quota_manual)
        SELECT am.account_uuid, m.username, u.quota_percent, u.quota_manual
        FROM account_machines am JOIN machines m ON m.machine_id = am.machine_id JOIN users u ON u.username = m.username;
      COMMIT;
    `);
  }
  return db;
}
