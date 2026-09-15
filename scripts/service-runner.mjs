/**
 * Windows 服务启动器（service-runner）
 * sc 创建的服务默认工作目录是 System32，此脚本先切换到项目根目录，
 * 再启动编译后的服务端，保证 .env、DATA_DIR、WEB_DIST_DIR 等相对路径正确。
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const { startServer } = await import('../dist/apps/server/src/index.js');
await startServer();
