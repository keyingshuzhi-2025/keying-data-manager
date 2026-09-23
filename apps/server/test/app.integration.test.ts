import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { HubDatabase } from '../src/db/database.js';
import type { AppConfig } from '../src/config.js';

interface TestContext {
  app: FastifyInstance;
  db: HubDatabase;
  directory: string;
  config: AppConfig;
}

function createMultipart(
  filename: string,
  content: string,
  fields: Record<string, string>,
): { boundary: string; payload: Buffer } {
  const boundary = `----local-file-hub-${Date.now()}`;
  const chunks: Buffer[] = [Buffer.from(
    `--${boundary}\r\n`
    + `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`
    + 'Content-Type: text/plain\r\n\r\n',
  ), Buffer.from(content), Buffer.from('\r\n')];

  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="${name}"\r\n\r\n`
      + `${value}\r\n`,
    ));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, payload: Buffer.concat(chunks) };
}

async function makeContext(maxUploadBytes = 1024 * 1024): Promise<TestContext> {
  const directory = await mkdtemp(join(tmpdir(), 'local-file-hub-'));
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
    maxUploadBytes,
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
  return { app: hub.app, db: hub.db, directory, config };
}

async function login(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'user-agent': 'local-file-hub-vitest' },
    payload: { username: 'admin', password: 'test-password' },
  });
  expect(response.statusCode).toBe(200);
  const header = response.headers['set-cookie'];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new Error('Missing session cookie');
  return value.split(';', 1)[0];
}

function sessionCookie(response: { headers: Record<string, string | string[] | undefined> }): string {
  const header = response.headers['set-cookie'];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new Error('Missing session cookie');
  return value.split(';', 1)[0];
}

describe('Local File Hub API', () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await makeContext();
  });

  afterEach(async () => {
    await context.app.close();
    await rm(context.directory, { recursive: true, force: true });
  });

  it('exposes health publicly and protects file APIs', async () => {
    const health = await context.app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: 'ok', service: 'local-file-hub' });

    const files = await context.app.inject({ method: 'GET', url: '/api/files' });
    expect(files.statusCode).toBe(401);
    expect(files.json().error.code).toBe('UNAUTHORIZED');
  });

  it('stores session metadata for login requests', async () => {
    const cookie = await login(context.app);
    expect(cookie).toBeTruthy();

    const row = context.db.sqlite.prepare(
      'SELECT ip, user_agent FROM sessions ORDER BY created_at DESC LIMIT 1',
    ).get() as { ip: string | null; user_agent: string | null };
    expect(row.ip).toBe('127.0.0.1');
    expect(row.user_agent).toBe('local-file-hub-vitest');
  });

  it('logs in, manages folders, uploads after-file fields, streams, copies and deletes', async () => {
    const cookie = await login(context.app);
    const authHeaders = { cookie };

    const folderResponse = await context.app.inject({
      method: 'POST',
      url: '/api/files',
      headers: authHeaders,
      payload: { name: '资料', kind: 'folder' },
    });
    expect(folderResponse.statusCode).toBe(200);
    const folder = folderResponse.json().file as { id: string };

    const duplicate = await context.app.inject({
      method: 'POST',
      url: '/api/files',
      headers: authHeaders,
      payload: { name: '资料', kind: 'folder' },
    });
    expect(duplicate.statusCode).toBe(409);

    const multipart = createMultipart('original.txt', 'hello world', {
      parentId: folder.id,
      name: '问候.txt',
    });
    const upload = await context.app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: {
        ...authHeaders,
        'content-type': `multipart/form-data; boundary=${multipart.boundary}`,
      },
      payload: multipart.payload,
    });
    expect(upload.statusCode).toBe(201);
    const uploaded = upload.json().file as { id: string; name: string; sha256: string };
    expect(uploaded.name).toBe('问候.txt');
    expect(uploaded.sha256).toHaveLength(64);

    const listing = await context.app.inject({
      method: 'GET',
      url: `/api/files?parentId=${folder.id}&q=${encodeURIComponent('问候')}&type=document`,
      headers: authHeaders,
    });
    expect(listing.statusCode).toBe(200);
    expect(listing.json().items).toHaveLength(1);

    const path = await context.app.inject({
      method: 'GET',
      url: `/api/files/${uploaded.id}/path`,
      headers: authHeaders,
    });
    expect(path.json().path.map((item: { name: string }) => item.name)).toEqual(['资料', '问候.txt']);

    const range = await context.app.inject({
      method: 'GET',
      url: `/api/files/${uploaded.id}/stream`,
      headers: { ...authHeaders, range: 'bytes=0-4' },
    });
    expect(range.statusCode).toBe(206);
    expect(range.headers['content-range']).toBe('bytes 0-4/11');
    expect(range.body).toBe('hello');

    const copiedResponse = await context.app.inject({
      method: 'POST',
      url: `/api/files/${uploaded.id}/copy`,
      headers: authHeaders,
      payload: { parentId: null, name: 'copy.txt' },
    });
    expect(copiedResponse.statusCode).toBe(200);
    const copied = copiedResponse.json().file as { id: string };

    expect((await context.app.inject({
      method: 'DELETE',
      url: `/api/files/${uploaded.id}`,
      headers: authHeaders,
    })).statusCode).toBe(200);

    const copiedDownload = await context.app.inject({
      method: 'GET',
      url: `/api/files/${copied.id}/download`,
      headers: authHeaders,
    });
    expect(copiedDownload.statusCode).toBe(200);
    expect(copiedDownload.body).toBe('hello world');
  });

  it('registers users and applies admin-managed permissions immediately', async () => {
    const registration = await context.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: '访客_01', password: 'visitor-password' },
    });
    expect(registration.statusCode).toBe(201);
    expect(registration.json().user).toMatchObject({
      username: '访客_01',
      role: 'user',
      isEnabled: true,
      permissions: {
        read: false,
        download: false,
        upload: false,
        edit: false,
        editMd: false,
        share: false,
      },
    });
    const userCookie = sessionCookie(registration);

    const initialRead = await context.app.inject({
      method: 'GET',
      url: '/api/files',
      headers: { cookie: userCookie },
    });
    expect(initialRead.statusCode).toBe(403);

    const adminCookie = await login(context.app);
    const usersResponse = await context.app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { cookie: adminCookie },
    });
    expect(usersResponse.statusCode).toBe(200);
    const users = usersResponse.json().users as Array<{ id: string; username: string }>;
    const user = users.find((candidate) => candidate.username === '访客_01');
    expect(user).toBeDefined();

    const grantRead = await context.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${user!.id}`,
      headers: { cookie: adminCookie },
      payload: {
        permissions: { read: true, upload: false, edit: false },
      },
    });
    expect(grantRead.statusCode).toBe(200);

    const inconsistentGrant = await context.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${user!.id}`,
      headers: { cookie: adminCookie },
      payload: {
        permissions: { read: false, upload: true, edit: true },
      },
    });
    expect(inconsistentGrant.json().user.permissions).toEqual({
      read: false,
      download: false,
      upload: true,
      edit: true,
      editMd: false,
      share: false,
    });

    await context.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${user!.id}`,
      headers: { cookie: adminCookie },
      payload: {
        permissions: { read: true, upload: false, edit: false },
      },
    });

    const allowedRead = await context.app.inject({
      method: 'GET',
      url: '/api/files',
      headers: { cookie: userCookie },
    });
    expect(allowedRead.statusCode).toBe(200);

    const deniedCreate = await context.app.inject({
      method: 'POST',
      url: '/api/files',
      headers: { cookie: userCookie },
      payload: { name: '只读用户不能创建', kind: 'folder' },
    });
    expect(deniedCreate.statusCode).toBe(403);

    await context.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${user!.id}`,
      headers: { cookie: adminCookie },
      payload: {
        permissions: { read: true, upload: true, edit: false },
      },
    });
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/files',
      headers: { cookie: userCookie },
      payload: { name: '获授权目录', kind: 'folder' },
    });
    expect(created.statusCode).toBe(200);
    const folderId = created.json().file.id as string;

    expect((await context.app.inject({
      method: 'PATCH',
      url: `/api/files/${folderId}`,
      headers: { cookie: userCookie },
      payload: { name: '更名被拒绝' },
    })).statusCode).toBe(403);

    await context.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${user!.id}`,
      headers: { cookie: adminCookie },
      payload: {
        permissions: { read: true, upload: true, edit: true },
      },
    });
    expect((await context.app.inject({
      method: 'PATCH',
      url: `/api/files/${folderId}`,
      headers: { cookie: userCookie },
      payload: { name: '可更名目录' },
    })).statusCode).toBe(200);

    const disabled = await context.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${user!.id}`,
      headers: { cookie: adminCookie },
      payload: { isEnabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().user.isEnabled).toBe(false);

    expect((await context.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: userCookie },
    })).statusCode).toBe(401);
    expect((await context.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: '访客_01', password: 'visitor-password' },
    })).statusCode).toBe(403);
  });

  it('keeps admin permissions immutable and rejects duplicate usernames case-insensitively', async () => {
    const adminCookie = await login(context.app);
    const users = (await context.app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { cookie: adminCookie },
    })).json().users as Array<{ id: string; role: string }>;
    const admin = users.find((user) => user.role === 'admin');

    expect((await context.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${admin!.id}`,
      headers: { cookie: adminCookie },
      payload: { isEnabled: false },
    })).statusCode).toBe(403);

    expect((await context.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'NewUser', password: 'password-123' },
    })).statusCode).toBe(201);
    expect((await context.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'newuser', password: 'password-456' },
    })).statusCode).toBe(409);
  });

  it('rejects uploads above the configured limit', async () => {
    await context.app.close();
    await rm(context.directory, { recursive: true, force: true });
    context = await makeContext(4);
    const cookie = await login(context.app);
    const multipart = createMultipart('large.txt', 'too large', {});
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: {
        cookie,
        'content-type': `multipart/form-data; boundary=${multipart.boundary}`,
      },
      payload: multipart.payload,
    });
    expect(response.statusCode).toBe(413);
  });

  it('enforces a non-admin user storage quota', async () => {
    const registration = await context.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'quota_user', password: 'quota-password' },
    });
    expect(registration.statusCode).toBe(201);
    const userCookie = sessionCookie(registration);

    const adminCookie = await login(context.app);
    const users = (await context.app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { cookie: adminCookie },
    })).json().users as Array<{ id: string; username: string }>;
    const user = users.find((candidate) => candidate.username === 'quota_user');
    expect(user).toBeDefined();
    const grant = await context.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${user!.id}`,
      headers: { cookie: adminCookie },
      payload: { permissions: { read: true, upload: true, edit: false } },
    });
    expect(grant.statusCode).toBe(200);

    context.db.sqlite.prepare(
      'UPDATE users SET storage_quota_bytes = ? WHERE id = ?',
    ).run(5, user!.id);

    const withinQuota = createMultipart('small.txt', '1234', {});
    const accepted = await context.app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: {
        cookie: userCookie,
        'content-type': `multipart/form-data; boundary=${withinQuota.boundary}`,
      },
      payload: withinQuota.payload,
    });
    expect(accepted.statusCode).toBe(201);

    const overQuota = createMultipart('too-large.txt', '123456', {});
    const rejected = await context.app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: {
        cookie: userCookie,
        'content-type': `multipart/form-data; boundary=${overQuota.boundary}`,
      },
      payload: overQuota.payload,
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error.code).toBe('CONFLICT');
  });
});
