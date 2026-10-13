import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import type { HubDatabase } from '../src/db/database.js';

interface TestContext {
  app: FastifyInstance;
  db: HubDatabase;
  directory: string;
}

interface MakeOptions {
  rateLimitEnabled?: boolean;
  rateLimitMax?: number;
  registrationEnabled?: boolean;
  nodeEnv?: 'test' | 'production';
}

function multipart(
  filename: string,
  contentType: string,
  content: Buffer | string,
  fields: Record<string, string> = {},
): { boundary: string; payload: Buffer } {
  const boundary = `----lfh-sec-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

async function makeContext(options: MakeOptions = {}): Promise<TestContext> {
  const directory = await mkdtemp(join(tmpdir(), 'local-file-hub-sec-'));
  const webDistDir = join(directory, 'web');
  if (options.nodeEnv === 'production') {
    await mkdir(webDistDir, { recursive: true });
    await writeFile(join(webDistDir, 'index.html'), '<!doctype html><title>hub</title>');
  }
  const config: AppConfig = {
    nodeEnv: options.nodeEnv ?? 'test',
    host: '127.0.0.1',
    port: 3000,
    dataDir: directory,
    dbPath: join(directory, 'db', 'hub.sqlite'),
    objectDir: join(directory, 'objects'),
    uploadDir: join(directory, 'uploads'),
    webDistDir,
    adminUsername: 'admin',
    adminPassword: 'test-password-ok',
    maxUploadBytes: 1024 * 1024,
    sessionTtlMs: 60_000,
    cookieSecure: false,
    trustProxy: false,
    logLevel: 'silent',
    rateLimitEnabled: options.rateLimitEnabled ?? false,
    rateLimitMax: options.rateLimitMax ?? 3,
    rateLimitWindowMs: 60_000,
    registrationEnabled: options.registrationEnabled ?? true,
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
    headers: { 'user-agent': 'sec-vitest' },
    payload: { username: 'admin', password: 'test-password-ok' },
  });
  expect(response.statusCode).toBe(200);
  return cookieFrom(response);
}

async function registerUser(app: FastifyInstance, username: string, inviteCode?: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'user-agent': 'sec-vitest' },
    payload: { username, password: 'password-123', ...(inviteCode ? { inviteCode } : {}) },
  });
  expect(response.statusCode).toBe(201);
  return cookieFrom(response);
}

describe('v0.1.2 安全加固（M2）', () => {
  let context: TestContext;
  let cookie: string;

  async function setup(options: MakeOptions = {}): Promise<void> {
    context = await makeContext(options);
    cookie = await adminLogin(context.app);
  }

  afterEach(async () => {
    await context.app.close();
    await rm(context.directory, { recursive: true, force: true });
  });

  it('上传白名单：禁用扩展名 415，合法类型 201', async () => {
    await setup();
    for (const name of ['evil.exe', 'page.html', 'run.sh', 'app.js', 'x.bat']) {
      const { boundary, payload } = multipart(name, 'application/octet-stream', 'MZ');
      const response = await context.app.inject({
        method: 'POST',
        url: '/api/uploads',
        headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload,
      });
      expect(response.statusCode).toBe(415);
      expect(response.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    }

    const { boundary, payload } = multipart('notes.txt', 'text/plain', 'ok');
    const accepted = await context.app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(accepted.statusCode).toBe(201);
  });

  it('只读不可下载：download=false 时下载/流式 403，但可读取内容', async () => {
    await setup();
    // 根目录默认策略：可读可上传，但不可下载
    const acl = await context.app.inject({
      method: 'PUT',
      url: '/api/admin/permissions',
      headers: { cookie },
      payload: { folderId: 'ROOT', permissions: { read: true, upload: true, download: false } },
    });
    expect(acl.statusCode).toBe(200);

    const userCookie = await registerUser(context.app, 'ro_user');
    const { boundary, payload } = multipart('doc.txt', 'text/plain', '可看不可拷');
    const upload = await context.app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: { cookie: userCookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(upload.statusCode).toBe(201);
    const fileId = upload.json().file.id;

    const content = await context.app.inject({
      method: 'GET', url: `/api/files/${fileId}/content`, headers: { cookie: userCookie },
    });
    expect(content.statusCode).toBe(200); // read 可看

    const download = await context.app.inject({
      method: 'GET', url: `/api/files/${fileId}/download`, headers: { cookie: userCookie },
    });
    expect(download.statusCode).toBe(403);
    expect(download.json().error.code).toBe('FORBIDDEN');

    const stream = await context.app.inject({
      method: 'GET', url: `/api/files/${fileId}/stream`, headers: { cookie: userCookie },
    });
    expect(stream.statusCode).toBe(403);
  });

  it('登录限流：超出固定窗口返回 429 与 Retry-After', async () => {
    await setup({ rateLimitEnabled: true, rateLimitMax: 3 });
    let blocked: Awaited<ReturnType<FastifyInstance['inject']>> | undefined;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      blocked = await context.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'wrong-password' },
      });
    }
    expect(blocked!.statusCode).toBe(429);
    expect(blocked!.headers['retry-after']).toBeDefined();
    const retryAfter = Number(blocked!.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(blocked!.json().error.code).toBe('TOO_MANY_REQUESTS');
  });

  it('注册保护：关闭开放注册后仅邀请码可注册', async () => {
    await setup({ registrationEnabled: false });

    const denied = await context.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'no_invite', password: 'password-123' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('FORBIDDEN');

    const invite = await context.app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      headers: { cookie },
      payload: { permissions: { read: true, upload: false, edit: false } },
    });
    expect(invite.statusCode).toBe(201);
    const code = invite.json().invite.code;

    const accepted = await context.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'with_invite', password: 'password-123', inviteCode: code },
    });
    expect(accepted.statusCode).toBe(201);
  });

  it('全局审计：按动作与时间范围筛选', async () => {
    await setup();
    // 创建用户产生 create_user 动作
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { cookie },
      payload: {
        username: 'audit_target',
        password: 'password-123',
        isEnabled: true,
        permissions: { read: true, upload: false, edit: false },
      },
    });
    expect(created.statusCode).toBe(201);

    const all = await context.app.inject({
      method: 'GET', url: '/api/admin/activity?limit=200', headers: { cookie },
    });
    expect(all.statusCode).toBe(200);
    const activities = all.json().activities as Array<{ action: string; targetName: string | null }>;
    expect(activities.some((item) => item.action === 'create_user' && item.targetName === 'audit_target')).toBe(true);

    const filtered = await context.app.inject({
      method: 'GET', url: '/api/admin/activity?action=create_user', headers: { cookie },
    });
    expect(filtered.statusCode).toBe(200);
    const onlyCreate = filtered.json().activities as Array<{ action: string }>;
    expect(onlyCreate.length).toBeGreaterThan(0);
    expect(onlyCreate.every((item) => item.action === 'create_user')).toBe(true);

    // 时间范围筛选：from 取未来时间 → 无结果
    const future = new Date(Date.now() + 3600_000).toISOString();
    const fromFuture = await context.app.inject({
      method: 'GET', url: `/api/admin/activity?from=${encodeURIComponent(future)}`, headers: { cookie },
    });
    expect(fromFuture.json().activities.length).toBe(0);
  });

  it('水印配置 API：默认值 → 更新 → 生效并记录审计', async () => {
    await setup();
    const initial = await context.app.inject({
      method: 'GET', url: '/api/admin/watermark-config', headers: { cookie },
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().config.enabled).toBe(true);

    const updated = await context.app.inject({
      method: 'PUT',
      url: '/api/admin/watermark-config',
      headers: { cookie },
      payload: {
        enabled: false,
        text: '机密 {username} {datetime}',
        position: 'corner',
        opacity: 0.5,
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().config).toMatchObject({ enabled: false, position: 'corner', opacity: 0.5 });

    const reread = await context.app.inject({
      method: 'GET', url: '/api/admin/watermark-config', headers: { cookie },
    });
    expect(reread.json().config.text).toBe('机密 {username} {datetime}');

    const activity = await context.app.inject({
      method: 'GET', url: '/api/admin/activity?action=watermark_config_change', headers: { cookie },
    });
    expect(activity.statusCode).toBe(200);
    expect(activity.json().activities.length).toBe(1);
  });

  it('生产模式输出安全响应头（含 HSTS）', async () => {
    await setup({ nodeEnv: 'production' });
    const health = await context.app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    expect(health.headers['x-content-type-options']).toBe('nosniff');
    expect(health.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(health.headers['referrer-policy']).toBe('no-referrer');
    expect(health.headers['content-security-policy']).toContain("default-src 'self'");

    // 静态 SPA 由生产服务提供
    const index = await context.app.inject({ method: 'GET', url: '/' });
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain('<title>hub</title>');
  });
});
