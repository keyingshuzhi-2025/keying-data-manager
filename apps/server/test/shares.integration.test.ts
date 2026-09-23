import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import type { HubDatabase } from '../src/db/database.js';

interface TestContext {
  app: FastifyInstance;
  db: HubDatabase;
  directory: string;
}

function multipart(
  filename: string,
  contentType: string,
  content: Buffer | string,
  fields: Record<string, string> = {},
): { boundary: string; payload: Buffer } {
  const boundary = `----local-file-hub-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const body: Buffer[] = [
    Buffer.from(
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`
      + `Content-Type: ${contentType}\r\n\r\n`,
    ),
    Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'),
    Buffer.from('\r\n'),
  ];
  for (const [name, value] of Object.entries(fields)) {
    body.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ));
  }
  body.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, payload: Buffer.concat(body) };
}

async function makeContext(): Promise<TestContext> {
  const directory = await mkdtemp(join(tmpdir(), 'local-file-hub-shares-'));
  const config: AppConfig = {
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 3000,
    dataDir: directory,
    dbPath: join(directory, 'db', 'hub.sqlite'),
    objectDir: join(directory, 'objects'),
    uploadDir: join(directory, 'uploads'),
    webDistDir: join(directory, 'web'),
    adminUsername: 'admin',
    adminPassword: 'test-password',
    maxUploadBytes: 1024 * 1024,
    sessionTtlMs: 60_000,
    cookieSecure: false,
    trustProxy: false,
    logLevel: 'silent',
    rateLimitEnabled: false,
    rateLimitMax: 5,
    rateLimitWindowMs: 60_000,
    registrationEnabled: true,
    backupDir: join(directory, 'backups'),
  };
  const hub = await buildApp(config);
  return { app: hub.app, db: hub.db, directory };
}

function cookieFrom(response: { headers: Record<string, string | string[] | undefined> }): string {
  const header = response.headers['set-cookie'];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new Error('Missing session cookie');
  return value.split(';', 1)[0];
}

async function adminLogin(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'user-agent': 'shares-vitest' },
    payload: { username: 'admin', password: 'test-password' },
  });
  expect(response.statusCode).toBe(200);
  return cookieFrom(response);
}

async function uploadFile(
  app: FastifyInstance,
  cookie: string,
  filename: string,
  contentType: string,
  content: Buffer | string,
  parentId?: string,
): Promise<{ id: string; name: string }> {
  const { boundary, payload } = multipart(filename, contentType, content, parentId ? { parentId } : {});
  const response = await app.inject({
    method: 'POST',
    url: '/api/uploads',
    headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
  expect(response.statusCode).toBe(201);
  const body = response.json();
  return { id: body.file.id, name: body.file.name };
}

async function createFolder(app: FastifyInstance, cookie: string, name: string, parentId?: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/files',
    headers: { cookie },
    payload: { name, kind: 'folder', ...(parentId ? { parentId } : {}) },
  });
  expect(response.statusCode).toBe(200); // 目录创建接口返回 200
  return response.json().file.id;
}

async function createShare(
  app: FastifyInstance,
  cookie: string,
  body: Record<string, unknown>,
): Promise<{ share: { id: string }; token: string; url: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/share-links',
    headers: { cookie },
    payload: body,
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

async function makePng(): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  return sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 210, g: 210, b: 210 } } })
    .png()
    .toBuffer();
}

describe('公开分享链接（匿名 · 限时 · 只读 · 可撤销）', () => {
  let context: TestContext;
  let cookie: string;
  let fileId: string;

  beforeEach(async () => {
    context = await makeContext();
    cookie = await adminLogin(context.app);
    fileId = (await uploadFile(context.app, cookie, 'readme.txt', 'text/plain', 'hello share')).id;
  });

  afterEach(async () => {
    await context.app.close();
    await rm(context.directory, { recursive: true, force: true });
  });

  it('创建分享返回一次性 token，匿名可访问 info', async () => {
    const { token, url } = await createShare(context.app, cookie, { fileId, expiresIn: '1d' });
    expect(token).toBeTruthy();
    expect(url).toBe(`/s/${token}`);

    const info = await context.app.inject({ method: 'GET', url: `/api/public/shares/${token}/info` });
    expect(info.statusCode).toBe(200);
    expect(info.json()).toMatchObject({
      file: { name: 'readme.txt', kind: 'file' },
      share: { hasPassword: false, isRevoked: false, expired: false },
    });
  });

  it('时效档位：forever 无过期时间，其余按档位计算', async () => {
    const before = Date.now();
    const forever = await createShare(context.app, cookie, { fileId, expiresIn: 'forever' });
    const list = await context.app.inject({ method: 'GET', url: '/api/share-links?mine=true', headers: { cookie } });
    const shares = list.json().shares as Array<{ id: string; expiresAt: string | null }>;
    const foreverShare = shares.find((share) => share.id === forever.share.id);
    expect(foreverShare?.expiresAt).toBeNull();

    const oneHour = await createShare(context.app, cookie, { fileId, expiresIn: '1h' });
    const shares2 = (await context.app.inject({
      method: 'GET', url: '/api/share-links?mine=true', headers: { cookie },
    })).json().shares as Array<{ id: string; expiresAt: string }>;
    const hourShare = shares2.find((share) => share.id === oneHour.share.id);
    const expires = new Date(hourShare!.expiresAt).getTime();
    expect(expires).toBeGreaterThan(before + 59 * 60 * 1000);
    expect(expires).toBeLessThanOrEqual(before + 60 * 60 * 1000 + 5000);
  });

  it('访问次数用尽后返回 403 SHARE_ACCESS_EXCEEDED', async () => {
    const { token } = await createShare(context.app, cookie, { fileId, expiresIn: '1d', maxAccesses: 1 });
    const first = await context.app.inject({ method: 'GET', url: `/api/public/shares/${token}/info` });
    expect(first.statusCode).toBe(200);

    const second = await context.app.inject({ method: 'GET', url: `/api/public/shares/${token}/info` });
    expect(second.statusCode).toBe(403);
    expect(second.json().error.code).toBe('SHARE_ACCESS_EXCEEDED');
  });

  it('访问密码：缺失/错误 401，正确可通过查询参数或请求头', async () => {
    const { token } = await createShare(context.app, cookie, { fileId, expiresIn: '7d', password: 's3cret' });

    const missing = await context.app.inject({ method: 'GET', url: `/api/public/shares/${token}/info` });
    expect(missing.statusCode).toBe(401);
    expect(missing.json().error.code).toBe('SHARE_PASSWORD_REQUIRED');

    const wrong = await context.app.inject({
      method: 'GET', url: `/api/public/shares/${token}/info?password=nope`,
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('SHARE_PASSWORD_INCORRECT');

    const byQuery = await context.app.inject({
      method: 'GET', url: `/api/public/shares/${token}/info?password=s3cret`,
    });
    expect(byQuery.statusCode).toBe(200);

    const byHeader = await context.app.inject({
      method: 'GET', url: `/api/public/shares/${token}/info`,
      headers: { 'x-share-password': 's3cret' },
    });
    expect(byHeader.statusCode).toBe(200);
  });

  it('撤销后匿名访问立即 403 SHARE_REVOKED', async () => {
    const { share, token } = await createShare(context.app, cookie, { fileId, expiresIn: '1d' });
    const revoke = await context.app.inject({
      method: 'POST', url: `/api/share-links/${share.id}/revoke`, headers: { cookie },
    });
    expect(revoke.statusCode).toBe(200);

    const info = await context.app.inject({ method: 'GET', url: `/api/public/shares/${token}/info` });
    expect(info.statusCode).toBe(403);
    expect(info.json().error.code).toBe('SHARE_REVOKED');
  });

  it('过期后匿名访问返回 410 SHARE_EXPIRED', async () => {
    const { share, token } = await createShare(context.app, cookie, { fileId, expiresIn: '1h' });
    // 直接改库模拟时间流逝（app 持有的同一连接，WAL 下即时可见）
    context.db.sqlite.prepare(
      'UPDATE shares SET expires_at = ? WHERE id = ?',
    ).run(new Date(Date.now() - 60_000).toISOString(), share.id);

    const info = await context.app.inject({ method: 'GET', url: `/api/public/shares/${token}/info` });
    expect(info.statusCode).toBe(410);
    expect(info.json().error.code).toBe('SHARE_EXPIRED');
  });

  it('文件夹分享隔离：无法访问子树外文件', async () => {
    const folderId = await createFolder(context.app, cookie, 'secret-folder');
    const insideId = (await uploadFile(
      context.app, cookie, 'inside.txt', 'text/plain', 'inside', folderId,
    )).id;
    const outsideId = (await uploadFile(
      context.app, cookie, 'outside.txt', 'text/plain', 'outside',
    )).id;

    const { token } = await createShare(context.app, cookie, {
      fileId: folderId, kind: 'folder', expiresIn: '7d',
    });

    const tree = await context.app.inject({ method: 'GET', url: `/api/public/shares/${token}/tree` });
    expect(tree.statusCode).toBe(200);

    const insideContent = await context.app.inject({
      method: 'GET', url: `/api/public/shares/${token}/files/${insideId}/content`,
    });
    expect(insideContent.statusCode).toBe(200);
    expect(insideContent.json().content).toBe('inside');

    const outsideContent = await context.app.inject({
      method: 'GET', url: `/api/public/shares/${token}/files/${outsideId}/content`,
    });
    expect(outsideContent.statusCode).toBe(400);
  });

  it('图片分享下载输出溯源水印版本（非原始字节）', async () => {
    const original = await makePng();
    const imageId = (await uploadFile(context.app, cookie, 'photo.png', 'image/png', original)).id;
    const { token } = await createShare(context.app, cookie, { fileId: imageId, expiresIn: '1d' });

    const download = await context.app.inject({
      method: 'GET', url: `/api/public/shares/${token}/download`,
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toContain('image/');
    expect(download.headers['cache-control']).toBe('private, no-store');
    const body = Buffer.from(download.rawPayload);
    expect(body.equals(original)).toBe(false); // 已叠加分享者溯源水印并重编码
    // 仍是合法 PNG
    expect(body.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  it('分享文件被删除后匿名访问 404', async () => {
    const { token } = await createShare(context.app, cookie, { fileId, expiresIn: '1d' });
    const del = await context.app.inject({
      method: 'DELETE', url: `/api/files/${fileId}`, headers: { cookie },
    });
    expect(del.statusCode).toBe(200);

    const info = await context.app.inject({ method: 'GET', url: `/api/public/shares/${token}/info` });
    expect(info.statusCode).toBe(404);
    expect(info.json().error.code).toBe('SHARE_NOT_FOUND');
  });
});
