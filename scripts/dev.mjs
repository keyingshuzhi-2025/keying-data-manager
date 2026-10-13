/**
 * 一键开发启动脚本（server + web），绕过 npm / concurrently 的子进程编排。
 *
 * 为什么需要它：在受限环境（DSH 沙箱）下，`npm run dev`（concurrently → npm →
 * cmd shim → node）等**带管道 stdio 的子进程链**会被拒绝 / 提前终止，导致服务
 * 起不来。本脚本自身即 node 顶层进程，用 `stdio: 'inherit'` 直接派生 server 与
 * web 两个子进程（该方式在受限环境下已验证可靠），日志直接打到终端。
 *
 * 用法：node scripts/dev.mjs
 * 停用：Ctrl+C（同时终止两个子进程）。
 */
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { join } from 'node:path';
import { buildServer } from './build-server.mjs';

const root = process.cwd();
const webEntry = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const webArgs = ['--config', 'apps/web/vite.config.ts', '--configLoader', 'native'];

// 监听 server 源码，变更时重建并重启（热重载），避免频繁 Alt+R
const sourceDir = join(root, 'apps', 'server', 'src');

let serverProc = null;
let webProc = null;
let restarting = false;

function startServer() {
  const proc = spawn(process.execPath, ['scripts/run-server.mjs'], { stdio: 'inherit', cwd: root });
  serverProc = proc;
  proc.on('exit', (code, signal) => {
    if (serverProc === proc) serverProc = null;
    if (signal === 'SIGTERM' || signal === 'SIGINT') return;
    console.log(`[server] 已退出（code=${code ?? ''}${signal ? ` signal=${signal}` : ''}）`);
  });
}

function startWeb() {
  const proc = spawn(process.execPath, [webEntry, ...webArgs], { stdio: 'inherit', cwd: root });
  webProc = proc;
}

function restartServer() {
  if (restarting) return;
  restarting = true;
  console.log('[server] 检测到源码变更，重新构建…');
  try {
    buildServer();
  } catch (error) {
    console.error(`[server] 构建失败：${error?.message ?? error}`);
    restarting = false;
    return;
  }
  const old = serverProc;
  serverProc = null;
  if (old) {
    old.removeAllListeners('exit');
    old.kill();
  }
  setTimeout(() => {
    startServer();
    restarting = false;
  }, 400);
}

let restartTimer = null;

function shutdown() {
  for (const proc of [webProc, serverProc]) {
    if (proc) proc.kill();
  }
  process.exit(0);
}

console.log('[dev] 构建 server…');
try {
  buildServer();
} catch (error) {
  console.error('[dev] server 构建失败：', error?.message ?? error);
}

startWeb();
startServer();
watch(sourceDir, { recursive: true }, (_event, filename) => {
  if (!filename || !/\.(ts|mts|cts|js|mjs|cjs|json)$/.test(filename)) return;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(restartServer, 200);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, shutdown);
}