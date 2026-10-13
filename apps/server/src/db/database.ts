import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { NodeSqliteDatabase } from './node-sqlite.js';
import type { AppSqliteDatabase } from './node-sqlite.js';
import { schema } from './schema.js';
import { ROOT_FOLDER_ID } from '../types.js';

export class HubDatabase {
  readonly sqlite: AppSqliteDatabase;

  get open(): boolean { return this.sqlite.open; }

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.sqlite = new NodeSqliteDatabase(dbPath);
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('synchronous = NORMAL');
    this.sqlite.pragma('busy_timeout = 5000');
    this.sqlite.exec(schema);
    this.migrateUsers();
    this.migrateSessions();
    this.migrateFiles();
    this.migrateFolderPermissions();
    this.migrateShares();
    this.sqlite.pragma('user_version = 8');
  }

  private migrateUsers(): void {
    const columns = this.sqlite.pragma('table_info(users)') as Array<{ name: string }>;
    const existing = new Set(columns.map((column) => column.name));
    const additions = [
      ['role', "TEXT NOT NULL DEFAULT 'user'"],
      ['is_enabled', 'INTEGER NOT NULL DEFAULT 1'],
      ['can_read', 'INTEGER NOT NULL DEFAULT 0'],
      ['can_upload', 'INTEGER NOT NULL DEFAULT 0'],
      ['can_edit', 'INTEGER NOT NULL DEFAULT 0'],
      ['can_manage_permissions', 'INTEGER NOT NULL DEFAULT 0'],
      ['storage_quota_bytes', 'INTEGER NOT NULL DEFAULT 0'],
      ['last_login_at', 'TEXT'],
    ] as const;

    for (const [name, definition] of additions) {
      if (!existing.has(name)) {
        this.sqlite.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
      }
    }
  }

  private migrateSessions(): void {
    const columns = this.sqlite.pragma('table_info(sessions)') as Array<{ name: string }>;
    const existing = new Set(columns.map((column) => column.name));
    const additions = [
      ['ip', 'TEXT'],
      ['user_agent', 'TEXT'],
    ] as const;

    for (const [name, definition] of additions) {
      if (!existing.has(name)) {
        this.sqlite.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${definition}`);
      }
    }
  }

  private migrateFiles(): void {
    const columns = this.sqlite.pragma('table_info(files)') as Array<{ name: string }>;
    const existing = new Set(columns.map((column) => column.name));
    if (!existing.has('uploaded_by')) {
      this.sqlite.exec('ALTER TABLE files ADD COLUMN uploaded_by TEXT');
    }
    if (!existing.has('is_shared')) {
      this.sqlite.exec('ALTER TABLE files ADD COLUMN is_shared INTEGER NOT NULL DEFAULT 0');
    }
  }

  /** v7：迁移文件夹级 ACL 默认策略。 */
  private migrateFolderPermissions(): void {
    // 每次启动都幂等校验关键种子，修复历史上 user_version 已是 7 但 ROOT 行缺失的数据库。
    // 确保 folder_permissions 表存在（v6 已建表；对更早的旧库兜底创建）。
    const tableRows = this.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get('folder_permissions') as { name: string } | undefined;
    if (!tableRows) {
      this.sqlite.exec(`CREATE TABLE IF NOT EXISTS folder_permissions (
        folder_id TEXT PRIMARY KEY,
        can_read INTEGER NOT NULL DEFAULT 0,
        can_download INTEGER NOT NULL DEFAULT 0,
        can_upload INTEGER NOT NULL DEFAULT 0,
        can_edit INTEGER NOT NULL DEFAULT 0,
        can_edit_md INTEGER NOT NULL DEFAULT 0,
        can_share INTEGER NOT NULL DEFAULT 0,
        updated_by TEXT,
        updated_at TEXT NOT NULL
      )`);
    }

    // 站点配置：ROOT 默认策略模式（open 为全开策略矩阵，但 authz 会与账号基线取交集）。
    this.sqlite.prepare(
      `INSERT INTO app_config (key, value, updated_by, updated_at)
       VALUES ('folder_permissions_default_mode', 'open', NULL, ?)
       ON CONFLICT(key) DO UPDATE SET value = 'open' WHERE value IS NULL`,
    ).run(new Date().toISOString());

    // 按模式种子化 ROOT 默认策略（幂等：仅缺失时插入，保留管理员已有配置）。
    const mode = this.sqlite.prepare(
      'SELECT value FROM app_config WHERE key = ?',
    ).get('folder_permissions_default_mode') as { value: string } | undefined;
    const modeValue = mode?.value === 'tighten' ? 'tighten' : 'open';
    const now = new Date().toISOString();
    const perms = modeValue === 'open'
      ? '1, 1, 1, 1, 1, 1' // open：允许账号基线授予的权限；目录显式 ACL 可覆盖
      : '1, 1, 0, 0, 0, 0'; // tighten：ROOT 仅允许读 + 下载，仍受账号基线约束
    this.sqlite.prepare(
      `INSERT INTO folder_permissions
         (folder_id, can_read, can_download, can_upload, can_edit, can_edit_md, can_share, updated_by, updated_at)
       VALUES ('ROOT', ${perms}, NULL, ?)
       ON CONFLICT(folder_id) DO NOTHING`,
    ).run(now);

    // 5) 版本 bump。
    this.sqlite.pragma('user_version = 7');
  }

  /**
   * v6：shares 令牌列规范化。schema 对新库直接以 `token_hash TEXT NOT NULL UNIQUE`
   * 建表；本方法处理 v5 旧库与并行实现遗留的明文 `token` 列：
   * 1. 表缺失时由 schema 创建（无需处理）；
   * 2. 存在明文 `token` 列且无 `token_hash` 时：补列并回填 sha256，随后建立唯一索引；
   * 3. `token` 明文列保留为迁移残留（新写入一律不落明文），以保证唯一约束下可安全回滚。
   */
  private migrateShares(): void {
    const columns = this.sqlite.pragma('table_info(shares)') as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has('token_hash')) {
      this.sqlite.exec('ALTER TABLE shares ADD COLUMN token_hash TEXT');
      const rows = this.sqlite.prepare(
        'SELECT id, token FROM shares WHERE token IS NOT NULL AND token_hash IS NULL',
      ).all() as Array<{ id: string; token: string }>;
      const update = this.sqlite.prepare('UPDATE shares SET token_hash = ? WHERE id = ?');
      for (const row of rows) {
        update.run(createHash('sha256').update(row.token).digest('hex'), row.id);
      }
    }
    this.sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_shares_token_hash ON shares(token_hash)');
  }

  close(): void {
    if (this.sqlite.open) {
      this.sqlite.close();
    }
  }
}
