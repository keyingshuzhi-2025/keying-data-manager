import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { HubDatabase } from '../src/db/database.js';
import { FOLDER_PERMISSIONS_DEFAULT_MODE_KEY } from '../src/authz.js';

describe('migration v7：文件夹级 ACL 默认策略（ROOT 种子 + 模式配置；最终 schema v8）', () => {
  let directory: string | undefined;

  it('新建数据库：user_version=8，预置 folder_permissions 与 ROOT 行（open 模式）', async () => {
    directory = await mkdtemp(join(tmpdir(), 'local-file-hub-migration-v7-'));
    const dbPath = join(directory, 'hub.sqlite');
    const db = new HubDatabase(dbPath);
    try {
      const version = db.sqlite.pragma('user_version', { simple: true }) as number;
      expect(version).toBe(8);

      const rows = db.sqlite.prepare(
        'SELECT folder_id, can_read, can_download, can_upload, can_edit, can_edit_md, can_share FROM folder_permissions',
      ).all() as Array<{ folder_id: string } & Record<string, number>>;
      const root = rows.find((r) => r.folder_id === 'ROOT');
      expect(root).toBeDefined();
      expect(root!.can_read).toBe(1);
      expect(root!.can_download).toBe(1);
      expect(root!.can_upload).toBe(1);
      expect(root!.can_edit).toBe(1);
      expect(root!.can_edit_md).toBe(1);
      expect(root!.can_share).toBe(1);

      const mode = db.sqlite.prepare('SELECT value FROM app_config WHERE key = ?').get(
        FOLDER_PERMISSIONS_DEFAULT_MODE_KEY,
      ) as { value: string } | undefined;
      expect(mode?.value).toBe('open');
    } finally {
      db.close();
    }
  });

  it('二次构造数据库（user_version 已达 8）：静默通过，不重复种子 ROOT 行', async () => {
    directory = await mkdtemp(join(tmpdir(), 'local-file-hub-migration-v7-'));
    const dbPath = join(directory, 'hub.sqlite');
    const db1 = new HubDatabase(dbPath);
    db1.close();
    const db2 = new HubDatabase(dbPath); // 再次构造应幂等
    try {
      const version = db2.sqlite.pragma('user_version', { simple: true }) as number;
      expect(version).toBe(8);
      const rootCount = db2.sqlite.prepare(
        'SELECT COUNT(*) AS n FROM folder_permissions WHERE folder_id = ?',
      ).get('ROOT') as { n: number };
      expect(rootCount.n).toBe(1); // 未重复插入
      const mode = db2.sqlite.prepare('SELECT value FROM app_config WHERE key = ?').get(
        FOLDER_PERMISSIONS_DEFAULT_MODE_KEY,
      ) as { value: string } | undefined;
      expect(mode?.value).toBe('open');
    } finally {
      db2.close();
    }
  });

  it('对 v6 旧库（folder_permissions 已存在但无 ROOT）：补全 ROOT + app_config', async () => {
    directory = await mkdtemp(join(tmpdir(), 'local-file-hub-migration-v7-'));
    const dbPath = join(directory, 'hub.sqlite');
    const legacy = new Database(dbPath);
    const nowStr = new Date().toISOString();
    legacy.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user',
        is_enabled INTEGER NOT NULL DEFAULT 1, can_read INTEGER NOT NULL DEFAULT 0,
        can_upload INTEGER NOT NULL DEFAULT 0, can_edit INTEGER NOT NULL DEFAULT 0,
        storage_quota_bytes INTEGER NOT NULL DEFAULT 0, last_login_at TEXT
      );
      CREATE TABLE folder_permissions (folder_id TEXT PRIMARY KEY,
        can_read INTEGER NOT NULL DEFAULT 0, can_download INTEGER NOT NULL DEFAULT 0,
        can_upload INTEGER NOT NULL DEFAULT 0, can_edit INTEGER NOT NULL DEFAULT 0,
        can_edit_md INTEGER NOT NULL DEFAULT 0, can_share INTEGER NOT NULL DEFAULT 0,
        updated_by TEXT, updated_at TEXT NOT NULL);
      CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT, updated_by TEXT, updated_at TEXT);
      INSERT INTO folder_permissions VALUES ('sub1', 1, 0, 0, 0, 0, 0, NULL, '${nowStr}');
      INSERT INTO app_config (key, value) VALUES ('some_other_key', 'v1');
    `);
    legacy.close();

    const db = new HubDatabase(dbPath);
    try {
      expect(db.sqlite.pragma('user_version', { simple: true }) as number).toBe(8);
      const root = db.sqlite.prepare(
        'SELECT * FROM folder_permissions WHERE folder_id = ?',
      ).get('ROOT') as Record<string, unknown> | undefined;
      expect(root).toBeDefined();
      expect((root!.can_read as number)).toBe(1);
      const mode = db.sqlite.prepare('SELECT value FROM app_config WHERE key = ?').get(
        FOLDER_PERMISSIONS_DEFAULT_MODE_KEY,
      ) as { value: string } | undefined;
      expect(mode?.value).toBe('open');
      const other = db.sqlite.prepare('SELECT value FROM app_config WHERE key = ?').get('some_other_key') as { value: string } | undefined;
      expect(other?.value).toBe('v1'); // 未破坏既有配置
    } finally {
      db.close();
    }
  });

  it('对 folder_permissions 表完全缺失的极旧库：建表 + 种子 ROOT', async () => {
    directory = await mkdtemp(join(tmpdir(), 'local-file-hub-migration-v7-'));
    const dbPath = join(directory, 'hub.sqlite');
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL);
    `);
    legacy.close();

    const db = new HubDatabase(dbPath);
    try {
      expect(db.sqlite.pragma('user_version', { simple: true }) as number).toBe(8);
      const exists = db.sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get('folder_permissions') as { name: string } | undefined;
      expect(exists?.name).toBe('folder_permissions');
      const root = db.sqlite.prepare(
        'SELECT * FROM folder_permissions WHERE folder_id = ?',
      ).get('ROOT') as Record<string, unknown> | undefined;
      expect(root).toBeDefined();
      expect((root!.can_read as number)).toBe(1);
    } finally {
      db.close();
    }
  });

  it('mode 配置可切换为 tighten：迁移保留既有值', async () => {
    directory = await mkdtemp(join(tmpdir(), 'local-file-hub-migration-v7-'));
    const dbPath = join(directory, 'hub.sqlite');
    const legacy = new Database(dbPath);
    const nowStr = new Date().toISOString();
    legacy.exec(`
      CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT, updated_by TEXT, updated_at TEXT);
      INSERT INTO app_config (key, value, updated_by, updated_at) VALUES ('folder_permissions_default_mode', 'tighten', NULL, '${nowStr}');
      INSERT INTO app_config (key, value, updated_by, updated_at) VALUES ('some_other_key', 'v1', NULL, '${nowStr}');
    `);
    legacy.close();

    const db = new HubDatabase(dbPath);
    try {
      expect(db.sqlite.pragma('user_version', { simple: true }) as number).toBe(8);
      const mode = db.sqlite.prepare('SELECT value FROM app_config WHERE key = ?').get(
        FOLDER_PERMISSIONS_DEFAULT_MODE_KEY,
      ) as { value: string } | undefined;
      expect(mode?.value).toBe('tighten');
      const rootUpload = db.sqlite.prepare(
        'SELECT can_upload FROM folder_permissions WHERE folder_id = ?',
      ).get('ROOT') as Record<string, unknown>;
      expect(rootUpload.can_upload).toBe(0);
      const rootRead = db.sqlite.prepare(
        'SELECT can_read, can_download FROM folder_permissions WHERE folder_id = ?',
      ).get('ROOT') as Record<string, unknown>;
      expect(rootRead.can_read).toBe(1);
      expect(rootRead.can_download).toBe(1);
      const other = db.sqlite.prepare('SELECT value FROM app_config WHERE key = ?').get('some_other_key') as { value: string } | undefined;
      expect(other?.value).toBe('v1'); // 未破坏既有配置
    } finally {
      db.close();
    }
  });

  it('迁移不触碰用户遗留权限列（users.can_read/can_upload/can_edit 仍保留）', async () => {
    directory = await mkdtemp(join(tmpdir(), 'local-file-hub-migration-v7-'));
    const dbPath = join(directory, 'hub.sqlite');
    const legacy = new Database(dbPath);
    const nowStr = new Date().toISOString();
    legacy.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL, can_read INTEGER NOT NULL DEFAULT 0,
        can_upload INTEGER NOT NULL DEFAULT 0, can_edit INTEGER NOT NULL DEFAULT 0);
      INSERT INTO users VALUES ('u1', 'alice', 'x', '${nowStr}', 1, 0, 0);
    `);
    legacy.close();

    const db = new HubDatabase(dbPath);
    try {
      const alice = db.sqlite.prepare(
        'SELECT can_read, can_upload, can_edit FROM users WHERE username = ?',
      ).get('alice') as { can_read: number; can_upload: number; can_edit: number };
      expect(alice.can_read).toBe(1);
      expect(alice.can_upload).toBe(0);
      expect(alice.can_edit).toBe(0);
      const columns = db.sqlite.pragma('table_info(users)') as Array<{ name: string }>;
      expect(columns.map((c) => c.name)).toContain('can_read');
      expect(columns.map((c) => c.name)).toContain('can_upload');
      expect(columns.map((c) => c.name)).toContain('can_edit');
    } finally {
      db.close();
    }
  });
});
