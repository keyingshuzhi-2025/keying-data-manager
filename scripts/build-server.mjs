/**
 * 用 esbuild 原生二进制把 apps/server 打包为单文件 ESM（dist/server-bundle.mjs）。
 *
 * 背景：tsx 依赖 esbuild 的 JS API，而 JS API 会通过 stdio 管道 spawn 一个
 * 常驻服务子进程；在受限环境（如 DSH 沙箱）下该 spawn 会被拒绝（EPERM）。
 * esbuild 的原生 CLI 二进制（esbuild.exe）不经过任何子进程，因此本脚本
 * 在受限环境下可用。
 *
 * 导出 buildServer() 供 watch-server.mjs 复用；直接运行本文件时执行一次构建。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();

/** 在 node_modules/@esbuild 下定位当前平台的原生二进制（Windows 为包根 esbuild.exe，其余为 bin/esbuild） */
export function findEsbuildBinary() {
  const base = join(root, 'node_modules', '@esbuild');
  if (!existsSync(base)) {
    throw new Error('未找到 node_modules/@esbuild，请先安装依赖（npm install）。');
  }
  for (const entry of readdirSync(base)) {
    const exe = join(base, entry, 'esbuild.exe');
    if (existsSync(exe)) return exe;
    const bin = join(base, entry, 'bin', 'esbuild');
    if (existsSync(bin)) return bin;
  }
  throw new Error('未找到 esbuild 原生二进制，请重装依赖（npm rebuild esbuild）。');
}

/** 打包 apps/server → dist/server-bundle.mjs（构建失败时抛错）。 */
export function buildServer() {
  const esbuild = findEsbuildBinary();
  const result = spawnSync(esbuild, [
    'apps/server/src/index.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--packages=external',
    '--outfile=dist/server-bundle.mjs',
    '--log-level=warning',
  ], { stdio: 'inherit', cwd: root });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`esbuild 退出码 ${result.status ?? '未知'}`);
  }
}

const isDirectRun = process.argv[1]
  && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href;

if (isDirectRun) {
  const esbuild = findEsbuildBinary();
  console.log(`[build-server] esbuild: ${esbuild}`);
  buildServer();
  console.log('[build-server] dist/server-bundle.mjs 已生成');
}
