import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  hashPassword,
  mapUser,
  requireAdmin,
  requireUser,
  type UserRow,
} from '../auth.js';
import type { HubDatabase } from '../db/database.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';

const userParamsSchema = z.object({ id: z.string().min(1).max(128) });
const updatePermissionsSchema = z.object({
  isEnabled: z.boolean().optional(),
  permissions: z.object({
    read: z.boolean(),
    upload: z.boolean(),
    edit: z.boolean(),
  }).optional(),
}).refine((value) => value.isEnabled !== undefined || value.permissions !== undefined, {
  message: '至少需要更新一项设置',
});

const createUserSchema = z.object({
  username: z.string()
    .trim()
    .min(3, '用户名至少 3 个字符')
    .max(50, '用户名最多 50 个字符')
    .regex(/^[\p{L}\p{N}_.-]+$/u, '用户名只能包含文字、数字、下划线、点和连字符'),
  password: z.string().min(8, '密码至少 8 个字符').max(1024),
  isEnabled: z.boolean(),
  permissions: z.object({
    read: z.boolean(),
    upload: z.boolean(),
    edit: z.boolean(),
  }),
});

const resetPasswordSchema = z.object({
  newPassword: z.string().min(8, '新密码至少 8 个字符').max(1024),
});

interface RouteContext {
  db: HubDatabase;
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw badRequest(message, result.error.flatten());
  return result.data;
}

function getUser(context: RouteContext, id: string): UserRow {
  const user = context.db.sqlite.prepare(
    `SELECT id, username, role, is_enabled, can_read, can_upload, can_edit, created_at, last_login_at
     FROM users WHERE id = ? LIMIT 1`,
  ).get(id) as UserRow | undefined;
  if (!user) throw notFound('用户');
  return user;
}

export function registerAdminRoutes(app: FastifyInstance, context: RouteContext): void {
  const adminOnly = async (request: FastifyRequest) => {
    await requireAdmin(context.db.sqlite, request);
  };

  app.get('/api/admin/users', { preHandler: adminOnly }, async () => {
    const rows = context.db.sqlite.prepare(
      `SELECT id, username, role, is_enabled, can_read, can_upload, can_edit, created_at, last_login_at
       FROM users ORDER BY role ASC, created_at ASC`,
    ).all() as UserRow[];
    return { users: rows.map(mapUser) };
  });

  app.patch('/api/admin/users/:id', { preHandler: adminOnly }, async (request) => {
    const { id } = parseOrThrow(userParamsSchema, request.params, '用户 ID 无效');
    const input = parseOrThrow(updatePermissionsSchema, request.body, '权限设置无效');
    const current = getUser(context, id);
    if (current.role === 'admin') throw forbidden('管理员账号的权限不可修改');

    const requestedPermissions = input.permissions ?? {
      read: Boolean(current.can_read),
      upload: Boolean(current.can_upload),
      edit: Boolean(current.can_edit),
    };
    // The web interface uses read access as the entry point to every file operation.
    // Keep the stored policy coherent even if an API client submits an inconsistent set.
    const permissions = requestedPermissions.read
      ? requestedPermissions
      : { read: false, upload: false, edit: false };
    const isEnabled = input.isEnabled ?? Boolean(current.is_enabled);
    const transaction = context.db.sqlite.transaction(() => {
      context.db.sqlite.prepare(
        `UPDATE users
         SET is_enabled = ?, can_read = ?, can_upload = ?, can_edit = ?
         WHERE id = ?`,
      ).run(
        Number(isEnabled),
        Number(permissions.read),
        Number(permissions.upload),
        Number(permissions.edit),
        id,
      );
      if (!isEnabled) {
        context.db.sqlite.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      }
    });
    transaction();
    return { user: mapUser(getUser(context, id)) };
  });

  // ----- 创建用户 -----
  app.post('/api/admin/users', { preHandler: adminOnly }, async (request, reply) => {
    const input = parseOrThrow(createUserSchema, request.body, '创建用户参数无效');
    const exists = context.db.sqlite.prepare(
      'SELECT 1 FROM users WHERE username = ? COLLATE NOCASE LIMIT 1',
    ).get(input.username);
    if (exists) throw conflict('该用户名已被使用');

    const permissions = input.permissions.read
      ? input.permissions
      : { read: false, upload: false, edit: false };
    const isEnabled = input.isEnabled;
    const now = new Date().toISOString();
    const id = randomBytes(16).toString('hex');
    context.db.sqlite.prepare(
      `INSERT INTO users
        (id, username, password_hash, role, is_enabled, can_read, can_upload, can_edit, created_at)
       VALUES (?, ?, ?, 'user', ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.username,
      hashPassword(input.password),
      Number(isEnabled),
      Number(permissions.read),
      Number(permissions.upload),
      Number(permissions.edit),
      now,
    );
    return reply.code(201).send({ user: mapUser(getUser(context, id)) });
  });

  // ----- 删除用户（级联清理会话） -----
  app.delete('/api/admin/users/:id', { preHandler: adminOnly }, async (request, reply) => {
    const { id } = parseOrThrow(userParamsSchema, request.params, '用户 ID 无效');
    const current = getUser(context, id);
    if (current.role === 'admin') throw forbidden('管理员账号不可删除');
    const me = await requireUser(context.db.sqlite, request);
    if (me.id === id) throw forbidden('不能删除自己的账号');
    const transaction = context.db.sqlite.transaction(() => {
      context.db.sqlite.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      context.db.sqlite.prepare('DELETE FROM users WHERE id = ?').run(id);
    });
    transaction();
    return reply.code(200).send({ ok: true });
  });

  // ----- 重置密码 -----
  app.post('/api/admin/users/:id/reset-password', { preHandler: adminOnly }, async (request) => {
    const { id } = parseOrThrow(userParamsSchema, request.params, '用户 ID 无效');
    const input = parseOrThrow(resetPasswordSchema, request.body, '重置密码参数无效');
    const current = getUser(context, id);
    if (current.role === 'admin') throw forbidden('管理员密码请直接在登录账号中修改');

    const transaction = context.db.sqlite.transaction(() => {
      context.db.sqlite.prepare(
        'UPDATE users SET password_hash = ? WHERE id = ?',
      ).run(hashPassword(input.newPassword), id);
      context.db.sqlite.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    });
    transaction();
    return { ok: true };
  });

  // ----- 用户详情 + 统计 -----
  app.get('/api/admin/users/:id', { preHandler: adminOnly }, async (request) => {
    const { id } = parseOrThrow(userParamsSchema, request.params, '用户 ID 无效');
    const user = getUser(context, id);
    const sessionCount = (context.db.sqlite.prepare(
      'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?',
    ).get(id, new Date().toISOString()) as { n: number }).n;
    // 文件库为全站共享，因此统计为全局数据
    const fileStats = context.db.sqlite.prepare(
      `SELECT
        COUNT(*) AS fileCount,
        COALESCE(SUM(size_bytes), 0) AS totalBytes
       FROM files WHERE deleted_at IS NULL AND kind = 'file'`,
    ).get() as { fileCount: number; totalBytes: number };
    return {
      user: mapUser(user),
      stats: {
        activeSessionCount: sessionCount,
        globalFileCount: fileStats.fileCount,
        globalTotalBytes: fileStats.totalBytes,
      },
    };
  });
}
