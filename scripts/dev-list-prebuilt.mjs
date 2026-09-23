// dev-list-prebuilt.mjs — 列出 better-sqlite3 各 release 中 node-v137(及其他) 的 win32-x64 资产
const wanted = process.argv[2] ?? 'node-v137-win32-x64';
let page = 1;
const found = [];
while (page <= 6) {
  const url = `https://api.github.com/repos/WiseLibs/better-sqlite3/releases?per_page=30&page=${page}`;
  const res = await fetch(url, { headers: { 'user-agent': 'dev-list-prebuilt', accept: 'application/vnd.github+json' } });
  if (!res.ok) { console.error(`page ${page}: HTTP ${res.status}`); break; }
  const releases = await res.json();
  if (!Array.isArray(releases) || releases.length === 0) break;
  for (const rel of releases) {
    const hit = (rel.assets ?? []).map((a) => a.browser_download_url).filter((u) => u.includes(`-${wanted}.tar.gz`));
    if (hit.length > 0) found.push({ tag: rel.tag_name, url: hit[0] });
  }
  page += 1;
}
console.log(JSON.stringify(found, null, 2));
