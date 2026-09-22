import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  clearSessionCookie,
  createSession,
  deleteExpiredSessions,
  deleteSession,
  getSessionUser,
  hashPassword,
  hashSessionToken,
  initializeAdmin,
  mapUser,
  recordLastLogin,
  requireUser,
  setSessionCookie,
  verifyPassword,
  type UserRow,
} from '../auth.js';
import type { AppConfig } from '../config.js';
import type { HubDatabase } from '../db/database.js';
import { recordActivity } from '../activity-log.js';
import { badRequest, conflict, forbidden, unauthorized } from '../errors.js';

const usernameSchema = z.string()
  .trim()
  .min(3, '用户名至少 3 个字符')
  .max(50, '用户名最多 50 个字符')
  .regex(/^[\p{L}\p{N}_.-]+$/u, '用户名只能包含文字、数字、下划线、点和连字符');

const loginSchema = z.object({
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(1024),
});

const registerSchema = z.object({
  username: usernameSchema,
  password: z.string().min(8, '密码至少 8 个字符').max(1024),
  inviteCode: z.string().trim().min(1).max(128).optional(),
});

const userSchema = z.object({
  id: z.string(),
  username: z.string(),
  role: z.enum(['admin', 'user']),
  isEnabled: z.boolean(),
  permissions: z.object({
    read: z.boolean(),
    download: z.boolean(),
    upload: z.boolean(),
    edit: z.boolean(),
    editMd: z.boolean(),
    share: z.boolean(),
  }),
  storageQuotaBytes: z.number().int().min(0),
  storageUsedBytes: z.number().int().min(0).optional(),
  createdAt: z.string(),
  lastLoginAt: z.string().nullable(),
});

const sessionSchema = z.object({
  user: userSchema,
  expiresAt: z.string(),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(8, '新密码至少 8 个字符').max(1024),
});

interface RouteContext {
  config: AppConfig;
  db: HubDatabase;
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw badRequest(message, result.error.flatten());
  return result.data;
}

function findLoginUser(context: RouteContext, username: string): (UserRow & { password_hash: string }) | undefined {
  return context.db.sqlite.prepare(
    `SELECT id, username, password_hash, role, is_enabled,
            can_read, can_upload, can_edit, storage_quota_bytes, created_at, last_login_at
     FROM users WHERE username = ? COLLATE NOCASE LIMIT 1`,
  ).get(username) as (UserRow & { password_hash: string }) | undefined;
}

function getClientIp(request: FastifyRequest): string | undefined {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim().slice(0, 100) || undefined;
  }
  return typeof request.ip === 'string' ? request.ip.slice(0, 100) : undefined;
}

function startSession(context: RouteContext, reply: FastifyReply, user: UserRow, request: FastifyRequest) {
  const session = createSession(
    context.db.sqlite,
    user.id,
    context.config.sessionTtlMs,
    { ip: getClientIp(request), userAgent: request.headers['user-agent'] },
  );
  setSessionCookie(reply, session.token, context.config);
  return sessionSchema.parse({ user: mapUser(user), expiresAt: session.expiresAt });
}

export function registerAuthRoutes(app: FastifyInstance, context: RouteContext): void {
  initializeAdmin(context.db.sqlite, context.config);
  deleteExpiredSessions(context.db.sqlite);

  app.post('/api/auth/register', async (request, reply) => {
    const input = parseOrThrow(registerSchema, request.body, '注册参数无效');
    if (findLoginUser(context, input.username)) throw conflict('该用户名已被使用');

    // 校验邀请码（可选）：未停用、未使用、未过期
    let invite: { id: string; can_read: number; can_upload: number; can_edit: number } | undefined;
    if (input.inviteCode) {
      const row = context.db.sqlite.prepare(
        `SELECT id, can_read, can_upload, can_edit, is_enabled, used_by, expires_at
         FROM invites WHERE code = ? LIMIT 1`,
      ).get(input.inviteCode) as {
        id: string;
        can_read: number;
        can_upload: number;
        can_edit: number;
        is_enabled: number;
        used_by: string | null;
        expires_at: string | null;
      } | undefined;
      if (!row || !row.is_enabled || row.used_by) throw badRequest('邀请码无效或已被使用');
      if (row.expires_at !== null && row.expires_at <= new Date().toISOString()) {
        throw badRequest('邀请码已过期');
      }
      invite = row;
    }

    const user: UserRow = {
      id: randomBytes(16).toString('hex'),
      username: input.username,
      role: 'user',
      is_enabled: 1,
      can_read: invite?.can_read ?? 0,
      can_upload: invite?.can_upload ?? 0,
      can_edit: invite?.can_edit ?? 0,
      storage_quota_bytes: 0,
      created_at: new Date().toISOString(),
      last_login_at: null,
    };
    try {
      const transaction = context.db.sqlite.transaction(() => {
        context.db.sqlite.prepare(
          `INSERT INTO users
            (id, username, password_hash, role, is_enabled, can_read, can_upload, can_edit, storage_quota_bytes, created_at)
           VALUES (?, ?, ?, 'user', ?, ?, ?, ?, ?, ?)`,
        ).run(
          user.id,
          user.username,
          hashPassword(input.password),
          user.is_enabled,
          user.can_read,
          user.can_upload,
          user.can_edit,
          user.storage_quota_bytes,
          user.created_at,
        );
        if (invite) {
          context.db.sqlite.prepare(
            `UPDATE invites SET used_by = ?, used_at = ?, is_enabled = 0 WHERE id = ?`,
          ).run(user.id, new Date().toISOString(), invite.id);
        }
      });
      transaction();
    } catch (error) {
      if (String((error as { code?: string }).code).startsWith('SQLITE_CONSTRAINT')) {
        throw conflict('该用户名已被使用');
      }
      throw error;
    }

    recordActivity(context.db.sqlite, { userId: user.id, action: 'register', targetName: user.username });
    return reply.code(201).send(startSession(context, reply, user, request));
  });

  app.post('/api/auth/login', async (request, reply) => {
    const input = parseOrThrow(loginSchema, request.body, '登录参数无效');
    const user = findLoginUser(context, input.username);

    if (!user || !verifyPassword(input.password, user.password_hash)) {
      throw unauthorized('用户名或密码错误');
    }
    if (!user.is_enabled) throw forbidden('账号已被管理员停用');

    const session = startSession(context, reply, user, request);
    recordLastLogin(context.db.sqlite, user.id);
    recordActivity(context.db.sqlite, { userId: user.id, action: 'login', targetName: user.username });
    return session;
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies?.lfh_session;
    if (token) {
      const row = context.db.sqlite.prepare(
        'SELECT user_id FROM sessions WHERE token_hash = ? LIMIT 1',
      ).get(hashSessionToken(token)) as { user_id: string } | undefined;
      if (row) recordActivity(context.db.sqlite, { userId: row.user_id, action: 'logout' });
    }
    deleteSession(context.db.sqlite, token);
    clearSessionCookie(reply, context.config);
    return { ok: true };
  });

  app.post('/api/auth/password', async (request, reply) => {
    const current = await requireUser(context.db.sqlite, request);
    const input = parseOrThrow(changePasswordSchema, request.body, '修改密码参数无效');
    const row = context.db.sqlite.prepare(
      'SELECT password_hash FROM users WHERE id = ? LIMIT 1',
    ).get(current.id) as { password_hash: string } | undefined;
    if (!row || !verifyPassword(input.currentPassword, row.password_hash)) {
      throw unauthorized('当前密码不正确');
    }
    if (input.currentPassword === input.newPassword) {
      throw badRequest('新密码不能与当前密码相同');
    }
    context.db.sqlite.prepare(
      'UPDATE users SET password_hash = ? WHERE id = ?',
    ).run(hashPassword(input.newPassword), current.id);
    // 主动结束其他会话，强制除当前外的所有设备重新登录
    context.db.sqlite.prepare(
      `DELETE FROM sessions WHERE user_id = ? AND token_hash != ?`,
    ).run(current.id, hashSessionToken(request.cookies?.lfh_session ?? ''));
    recordActivity(context.db.sqlite, { userId: current.id, action: 'change_password' });
    return reply.send({ ok: true });
  });

  app.get('/api/auth/session', async (request) => {
    const user = await getSessionUser(context.db.sqlite, request);
    if (!user) throw unauthorized();
    return { user };
  });

  app.get('/api/auth/me', async (request) => {
    const user = await requireUser(context.db.sqlite, request);
    return { user };
  });

  app.get('/api/auth/ping', async (request) => {
    const user = await requireUser(context.db.sqlite, request);
    return { ok: true, user: user.username };
  });
}

export type { RouteContext as AuthRouteContext };
