/**
 * 重置/同步管理员密码脚本（生产环境用，纯 Node 运行）
 * 依赖：先执行 npm run build 生成 dist
 * 用法：
 *   node scripts/set-admin-password.mjs [新密码]
 * 不传密码时使用 .env 中的 ADMIN_PASSWORD
 */
import 'dotenv/config';
import Database from 'better-sqlite3';
import { hashPassword } from '../dist/apps/server/src/auth.js';

const password = process.argv[2] ?? process.env.ADMIN_PASSWORD;
if (!password) {
  console.error('错误：未提供密码，且 .env 中未配置 ADMIN_PASSWORD');
  process.exit(1);
}
if (Buffer.byteLength(password, 'utf8') < 12) {
  console.error('错误：密码长度必须至少 12 字节');
  process.exit(1);
}

const db = new Database('data/db/local-file-hub.sqlite');
try {
  const username = process.env.ADMIN_USERNAME ?? 'admin';
  const result = db
    .prepare('UPDATE users SET password_hash = ? WHERE username = ? COLLATE NOCASE')
    .run(hashPassword(password), username);
  if (result.changes === 0) {
    console.error(`错误：用户 "${username}" 不存在，无法重置密码`);
    process.exit(1);
  }
  console.log(`✔ 已重置用户 "${username}" 的密码`);
} finally {
  db.close();
}
