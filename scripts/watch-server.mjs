/**
 * server 开发热重载（受限环境兼容版），替代 `node --watch` 与 `tsx watch`。
 *
 * 为什么不用 node --watch / tsx watch：
 * - tsx watch：esbuild JS API 通过 stdio 管道 spawn 常驻子进程，受限环境下 EPERM；
 * - node --watch：以带 IPC 管道的子进程运行目标脚本，受限环境下子进程启动即被终止
 *   （better-sqlite3 在进程被粗暴终止时留下原生断言，表现为 "Failed running ... Waiting
 *   for file changes"）。
 *
 * 本脚本自身即 node 顶层进程，用 stdio: 'inherit' 直接 spawn 服务子进程
 * （该 spawn 方式在受限环境下可用），并通过 fs.watch 递归监听源码变更：
 * 变更 → esbuild 原生二进制重建 → 重启服务。被终止的旧进程可能打印
 * better-sqlite3 原生断言（非优雅终止的正常现象），不影响新进程运行。
 */
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { join } from 'node:path';
import { buildServer } from './build-server.mjs';

const root = process.cwd();
const entry = 'dist/server-bundle.mjs';
const sourceDir = join(root, 'apps', 'server', 'src');

let child = null;
let restarting = false;

function startServer() {
  const proc = spawn(process.execPath, [entry], { stdio: 'inherit', cwd: root });
  child = proc;
  proc.on('exit', (code, signal) => {
    if (child === proc) child = null;
    if (!restarting) {
      console.log(`[watch-server] 服务已退出（code=${code ?? ''}${signal ? ` signal=${signal}` : ''}），等待文件变更…`);
    }
  });
}

let restartTimer = null;

function restartServer() {
  if (restarting) return;
  restarting = true;

  console.log('[watch-server] 检测到源码变更，重新构建…');
  try {
    buildServer();
  } catch (error) {
    console.error(`[watch-server] 构建失败：${error?.message ?? error}（保留旧进程继续运行）`);
    restarting = false;
    return;
  }

  const old = child;
  child = null;
  if (old) {
    old.removeAllListeners('exit');
    old.kill();
  }
  setTimeout(() => {
    startServer();
    restarting = false;
    console.log('[watch-server] 服务已重启');
  }, 400);
}

buildServer();
console.log('[watch-server] 启动服务（监听 apps/server/src 变更，自动重建重启）…');
startServer();

watch(sourceDir, { recursive: true }, (_event, filename) => {
  if (!filename || !/\.(ts|mts|cts|js|mjs|cjs|json)$/.test(filename)) return;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(restartServer, 200);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (child) child.kill();
    process.exit(0);
  });
}
