/**
 * v0.1.2 §8：SQLite 在线一致性备份 + 对象存储归档脚本。
 *
 * 用法：`npm run backup`（或 `node --import tsx scripts/backup.ts`）。
 *
 * 行为：
 * 1. 对主数据库执行 PRAGMA integrity_check，通过后调用 better-sqlite3 在线
 *    backup() 生成一致性快照（WAL 安全，无需停机）；
 * 2. 将 `objects/` 目录（文件内容）归档到同一次备份目录；
 * 3. 不包含 `uploads/`（视为临时目录）；
 * 4. 保留最近 7 份备份，自动清理更早的目录。
 *
 * 配置（环境变量，与 apps/server/src/config.ts 一致）：
 *   DATA_DIR / DB_PATH / OBJECT_DIR / BACKUP_DIR（默认 ./backups）
 */
import 'dotenv/config';
import { existsSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  readdir,
  rm,
} from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, sep } from 'node:path';
import Database from 'better-sqlite3';

const join = (...segments: string[]): string => segments.join(sep);

const resolveDir = (envValue: string | undefined, fallback: string): string =>
  resolve(envValue ?? fallback);

const DEFAULT_KEEP = 7;

export interface BackupOptions {
  dbPath: string;
  objectDir: string;
  backupDir: string;
  /** 保留最近份数，默认 7 */
  keep?: number;
}

export interface BackupResult {
  /** 本次备份目录（时间戳命名） */
  target: string;
  dbSnapshot: string;
  integrityOk: boolean;
  copiedObjects: number;
  pruned: string[];
}

function timestamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
}

/** 递归复制目录（保留目录结构，跳过符号链接） */
async function copyDir(src: string, dest: string): Promise<number> {
  if (!existsSync(src)) return 0;
  let copied = 0;
  const entries = await readdir(src, { withFileTypes: true });
  await mkdir(dest, { recursive: true });
  for (const entry of entries) {
    const from = `${src}${sep}${entry.name}`;
    const to = `${dest}${sep}${entry.name}`;
    if (entry.isDirectory()) {
      copied += await copyDir(from, to);
    } else if (entry.isFile()) {
      await copyFile(from, to);
      copied += 1;
    }
  }
  return copied;
}

/** 列出 backup-<14位时间戳> 目录（已排序） */
export async function listBackups(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  return (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^backup-\d{14}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/** 清理旧备份：仅保留最近 keep 份，返回被删除的目录名 */
export async function pruneBackups(root: string, keep: number): Promise<string[]> {
  const entries = await listBackups(root);
  const toRemove = entries.slice(0, Math.max(0, entries.length - keep));
  for (const name of toRemove) {
    await rm(join(root, name), { recursive: true, force: true });
  }
  return toRemove;
}

/** 执行一次完整备份，返回结果摘要 */
export async function runBackup(options: BackupOptions): Promise<BackupResult> {
  const { dbPath, objectDir, backupDir } = options;
  const keep = options.keep ?? DEFAULT_KEEP;
  if (!existsSync(dbPath)) {
    throw new Error(`数据库不存在: ${dbPath}（请先启动服务完成初始化）`);
  }

  const target = join(backupDir, `backup-${timestamp()}`);
  await mkdir(target, { recursive: true });

  // 1) 一致性检查 + 在线备份
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  let integrityOk = false;
  try {
    const integrity = db.pragma('integrity_check', { simple: true }) as string;
    if (integrity !== 'ok') {
      throw new Error(`数据库完整性检查失败: ${integrity}`);
    }
    integrityOk = true;
    const backupPath = join(target, 'local-file-hub.sqlite');
    await db.backup(backupPath);
    return {
      target,
      dbSnapshot: backupPath,
      integrityOk,
      copiedObjects: await copyDir(objectDir, join(target, 'objects')),
      pruned: await pruneBackups(backupDir, keep),
    };
  } finally {
    db.close();
  }
}

/** 仅当直接执行（npm run backup）时读取环境变量运行 */
async function mainFromEnv(): Promise<void> {
  const dataDir = resolveDir(process.env.DATA_DIR, './data');
  const dbPath = resolveDir(process.env.DB_PATH, resolve(dataDir, 'db/local-file-hub.sqlite'));
  const objectDir = resolveDir(process.env.OBJECT_DIR, resolve(dataDir, 'objects'));
  const backupDir = resolveDir(process.env.BACKUP_DIR, './backups');

  console.log(`备份目录: ${backupDir}`);
  const result = await runBackup({ dbPath, objectDir, backupDir });
  console.log(`  integrity_check: ${result.integrityOk ? 'ok' : 'failed'}`);
  console.log(`  SQLite 快照: ${result.dbSnapshot}`);
  console.log(`  objects/ 归档文件数: ${result.copiedObjects}`);
  for (const name of result.pruned) console.log(`  清理旧备份: ${name}`);
  console.log('备份完成。');
}

const executedDirectly = (): boolean => {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
  } catch {
    return false;
  }
};

if (executedDirectly()) {
  mainFromEnv().catch((error) => {
    console.error('备份失败:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
