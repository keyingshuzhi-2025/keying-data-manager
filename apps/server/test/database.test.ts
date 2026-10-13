import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { HubDatabase } from '../src/db/database.js';

describe('database migrations', () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('adds permission columns to an existing v1 users table', async () => {
    directory = await mkdtemp(join(tmpdir(), 'local-file-hub-migration-'));
    const dbPath = join(directory, 'hub.sqlite');
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    legacy.prepare(
      'INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)',
    ).run('legacy', 'legacy-user', 'unused', new Date().toISOString());
    legacy.close();

    const migrated = new HubDatabase(dbPath);
    const columns = migrated.sqlite.pragma('table_info(users)') as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'role',
      'is_enabled',
      'can_read',
      'can_upload',
      'can_edit',
    ]));
    // v0.1.2：schema 迁移至 user_version 8（条目 ACL + ROOT 默认策略）
    expect(migrated.sqlite.pragma('user_version', { simple: true })).toBe(8);
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'storage_quota_bytes',
    ]));
    const sessionColumns = migrated.sqlite.pragma('table_info(sessions)') as Array<{ name: string }>;
    expect(sessionColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'ip',
      'user_agent',
    ]));
    const fileColumns = migrated.sqlite.pragma('table_info(files)') as Array<{ name: string }>;
    expect(fileColumns.map((column) => column.name)).toContain('uploaded_by');
    expect(fileColumns.map((column) => column.name)).toContain('is_shared');
    const tableNames = migrated.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all() as Array<{ name: string }>;
    expect(tableNames.map((row) => row.name)).toEqual(expect.arrayContaining([
      'folder_permissions',
      'shares',
      'app_config',
    ]));
    expect(migrated.sqlite.prepare(
      'SELECT role, can_read FROM users WHERE id = ?',
    ).get('legacy')).toMatchObject({ role: 'user', can_read: 0 });
    migrated.close();
  });
});
