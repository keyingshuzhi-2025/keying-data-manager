import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

/** node:sqlite 的 .run() 返回 shape（等价 better-sqlite3）。 */
type RunResult = { changes: number; lastInsertRowid: number | bigint };

export interface AppSqliteStatement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/**
 * 本应用实际用到的 SQLite 访问面（better-sqlite3 / node:sqlite 兼容的最小接口）。
 *
 * 提供 prepare/exec/transaction/pragma/close/open，行为与 better-sqlite3 一致，
 * 底层改用 Node 内置的 node:sqlite（DatabaseSync），彻底绕开 better-sqlite3
 * 与 Node 24 ABI 不兼容导致的启动崩溃（Assertion `(env) != nullptr` → exit 134）。
 */
export interface AppSqliteDatabase {
  prepare(sql: string): AppSqliteStatement;
  exec(sql: string): void;
  transaction<R>(fn: () => R): () => R;
  pragma(sql: string, options?: { simple?: boolean }): unknown;
  close(): void;
  readonly open: boolean;
}

class NodeSqliteDatabase implements AppSqliteDatabase {
  private readonly db: DatabaseSync;
  private _open = true;

  constructor(path: string) {
    // node:sqlite 默认即以读写打开文件（DB 文件由数据库.ts 在构造前确保目录存在）
    this.db = new DatabaseSync(path, { readOnly: false });
  }

  prepare(sql: string): AppSqliteStatement {
    const stmt: StatementSync = this.db.prepare(sql);
    return {
      run(...params: unknown[]): RunResult {
        const out = stmt.run(...(params as SQLInputValue[]));
        return { changes: Number(out.changes), lastInsertRowid: Number(out.lastInsertRowid) };
      },
      get(...params: unknown[]): unknown {
        return stmt.get(...(params as SQLInputValue[]));
      },
      all(...params: unknown[]): unknown[] {
        return stmt.all(...(params as SQLInputValue[]));
      },
    };
  }

  exec(sql: string): void {
    // node:sqlite 顶层 exec() 支持多条语句（schema / 迁移脚本场景）
    if (!/^\s*$/.test(sql)) {
      this.db.exec(sql);
    }
  }

  transaction<R>(fn: () => R): () => R {
    const wrapped = (): R => {
      this.db.prepare('BEGIN').run();
      try {
        const result = fn();
        this.db.prepare('COMMIT').run();
        return result;
      } catch (error) {
        try {
          this.db.prepare('ROLLBACK').run();
        } catch {
          // 连接已坏或已关闭时忽略回滚失败，原错误优先抛出
        }
        throw error;
      }
    };
    return wrapped;
  }

  pragma(sql: string, options?: { simple?: boolean }): unknown {
    const simple = !!options?.simple;
    const trimmed = sql.trim();
    // 兼容 better-sqlite3：调用方传入不含 `PRAGMA` 前缀的语句，node:sqlite 需要前缀
    const statement = /^PRAGMA\s/i.test(trimmed) ? trimmed : `PRAGMA ${trimmed}`;
    const isSet = /=\s*'?[^'"]*'?\s*$/i.test(statement);

    if (isSet) {
      // SET pragma（foreign_keys / journal_mode / synchronous / busy_timeout / user_version …）
      this.db.prepare(statement).run();
      return [];
    }

    // QUERY pragma（table_info / journal_mode 读取等）→ 返回行数组
    const rows = this.db.prepare(statement).all() as unknown[];
    if (simple && rows.length > 0 && typeof rows[0] === 'object' && rows[0] !== null) {
      const obj = rows[0] as Record<string, unknown>;
      return Object.values(obj)[0];
    }
    return rows;
  }

  close(): void {
    if (this._open) {
      this.db.close();
      this._open = false;
    }
  }

  get open(): boolean {
    return this._open;
  }
}

export { NodeSqliteDatabase };