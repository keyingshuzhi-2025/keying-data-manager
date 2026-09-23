import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HubDatabase } from '../src/db/database.js';
import {
  listBackups,
  pruneBackups,
  runBackup,
} from '../../../scripts/backup.js';
describe('备份脚本（SQLite 在线备份 + 对象归档 + 保留策略）', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'local-file-hub-backup-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('生成一致性快照与对象归档，快照可独立打开且为 v6 schema', async () => {
    const dbPath = join(directory, 'db', 'hub.sqlite');
    const objectDir = join(directory, 'objects');
    const backupDir = join(directory, 'backups');

    // 造一个真实库 + 一个对象文件
    const hub = new HubDatabase(dbPath);
    hub.sqlite.prepare(
      `INSERT INTO users (id, username, password_hash, role, created_at)
       VALUES ('u1', 'u1', 'x', 'user', ?)`,
    ).run(new Date().toISOString());
    hub.close();
    await mkdir(join(objectDir, 'ab'), { recursive: true });
    await mkdir(join(objectDir, 'bb'), { recursive: true });
    await writeFile(join(objectDir, 'ab', 'blob1.blob'), 'object-content-1');
    await writeFile(join(objectDir, 'bb', 'blob2.blob'), 'object-content-2');

    const result = await runBackup({ dbPath, objectDir, backupDir, keep: 7 });
    expect(result.integrityOk).toBe(true);
    expect(result.copiedObjects).toBe(2);
    expect(result.pruned).toEqual([]);

    // 快照可独立打开且 schema 完整
    const snapshot = new Database(result.dbSnapshot, { readonly: true });
    const version = snapshot.pragma('user_version', { simple: true });
    const userCount = (snapshot.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
    snapshot.close();
    expect(version).toBe(6);
    expect(userCount).toBe(1);

    // 备份目录结构
    const backups = await listBackups(backupDir);
    expect(backups.length).toBe(1);
    expect(backups[0]).toMatch(/^backup-\d{14}$/);
  });

  it('保留策略：超过 keep 份时清理最旧备份', async () => {
    const dbPath = join(directory, 'db', 'hub.sqlite');
    const objectDir = join(directory, 'objects');
    const backupDir = join(directory, 'backups');
    const hub = new HubDatabase(dbPath);
    hub.close();
    await mkdir(objectDir, { recursive: true });

    // 预置两份更旧备份
    await mkdir(join(backupDir, 'backup-20250101000000'), { recursive: true });
    await mkdir(join(backupDir, 'backup-20250102000000'), { recursive: true });

    const result = await runBackup({ dbPath, objectDir, backupDir, keep: 2 });
    expect(result.pruned.length).toBe(1);
    expect(result.pruned[0]).toBe('backup-20250101000000');
    const remaining = await listBackups(backupDir);
    expect(remaining.length).toBe(2);
  });

  it('pruneBackups 保留最新 keep 份', async () => {
    const backupDir = join(directory, 'backups');
    for (const name of ['backup-20250101000000', 'backup-20250102000000', 'backup-20250103000000']) {
      await mkdir(join(backupDir, name), { recursive: true });
    }
    const pruned = await pruneBackups(backupDir, 1);
    expect(pruned).toEqual(['backup-20250101000000', 'backup-20250102000000']);
    expect(await listBackups(backupDir)).toEqual(['backup-20250103000000']);
  });

  it('数据库不存在时抛错', async () => {
    await expect(runBackup({
      dbPath: join(directory, 'missing.sqlite'),
      objectDir: join(directory, 'objects'),
      backupDir: join(directory, 'backups'),
    })).rejects.toThrow(/数据库不存在/);
  });
});
