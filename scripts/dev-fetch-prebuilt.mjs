// dev-fetch-prebuilt.mjs
// 开发辅助：从 GitHub Releases 下载 better-sqlite3 指定 ABI 的预编译二进制，
// 用于本地无 MSVC 工具链时恢复 node_modules 中原生模块。
// 用法：node dev-fetch-prebuilt.mjs <version> <abi...> <outDir>
// 例：node dev-fetch-prebuilt.mjs 11.10.0 127 137 "$env:TEMP\bs3"
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const [version, ...rest] = process.argv.slice(2);
const abis = rest.slice(0, -1);
const outDir = rest[rest.length - 1];
if (!version || abis.length === 0 || !outDir) {
  console.error('usage: node dev-fetch-prebuilt.mjs <version> <abi...> <outDir>');
  process.exit(1);
}

const apiUrl = `https://api.github.com/repos/WiseLibs/better-sqlite3/releases/tags/v${version}`;
const headers = { 'user-agent': 'dev-fetch-prebuilt', accept: 'application/vnd.github+json' };
const res = await fetch(apiUrl, { headers });
if (!res.ok) {
  console.error(`GET ${apiUrl} -> ${res.status}`);
  process.exit(1);
}
const release = await res.json();
const assets = (release.assets ?? []).map((a) => a.browser_download_url);
console.log('release assets:', assets.length);
for (const abi of abis) {
  const wanted = assets.find((u) => u.includes(`-node-v${abi}-win32-x64.tar.gz`));
  if (!wanted) {
    console.error(`no asset for abi ${abi} in v${version}; available:`, assets);
    continue;
  }
  const filename = wanted.split('/').pop();
  const filePath = join(outDir, filename);
  await mkdir(outDir, { recursive: true });
  const r = await fetch(wanted, { redirect: 'follow' });
  if (!r.ok) {
    console.error(`download ${wanted} -> ${r.status}`);
    continue;
  }
  const buf = Buffer.from(await r.arrayBuffer());
  await writeFile(filePath, buf);
  console.log(`saved ${filename} (${buf.length} bytes)`);
}
