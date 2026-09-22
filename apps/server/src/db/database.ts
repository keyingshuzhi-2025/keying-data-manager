import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { schema } from './schema.js';
import { ROOT_FOLDER_ID } from '../types.js';

export class HubDatabase {
  readonly sqlite: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.sqlite = new Database(dbPath);
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
    this.sqlite.pragma('user_version = 6');
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

    /** v6：不预置 ROOT 策略；未配置时回退到用户遗留权限，符合最小权限原则。 */
    private migrateFolderPermissions(): void {
      // 管理员可通过 /api/admin/permissions 显式设置根目录默认策略。
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
