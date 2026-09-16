import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { schema } from './schema.js';

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
    this.sqlite.pragma('user_version = 4');
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
      ['last_login_at', 'TEXT'],
    ] as const;

    for (const [name, definition] of additions) {
      if (!existing.has(name)) {
        this.sqlite.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
      }
    }
  }

  close(): void {
    if (this.sqlite.open) {
      this.sqlite.close();
    }
  }
}
