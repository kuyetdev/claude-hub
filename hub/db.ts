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
    CREATE TABLE IF NOT EXISTS alerts_sent (
      week_key TEXT NOT NULL,
      scope TEXT NOT NULL,
      threshold TEXT NOT NULL,
      sent_ms INTEGER NOT NULL,
      PRIMARY KEY (week_key, scope, threshold)
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  return db;
}
