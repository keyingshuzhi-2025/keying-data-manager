import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  listActivityForUser,
  recordActivity,
} from '../activity-log.js';
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

const batchActionSchema = z.object({
  ids: z.array(z.string().min(1).max(128)).min(1).max(100),
  action: z.enum(['enable', 'disable', 'delete']),
});

const roleSchema = z.object({
  role: z.enum(['admin', 'user']),
});

const createInviteSchema = z.object({
  permissions: z.object({
    read: z.boolean(),
    upload: z.boolean(),
    edit: z.boolean(),
  }),
  expiresInHours: z.number().int().min(1).max(24 * 365).optional(),
});

const inviteParamsSchema = z.object({ id: z.string().min(1).max(128) });

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

function inviteRow(context: RouteContext, id: string) {
  const row = context.db.sqlite.prepare(
    `SELECT id, code, can_read, can_upload, can_edit, is_enabled, created_by,
            expires_at, created_at, used_by, used_at
     FROM invites WHERE id = ? LIMIT 1`,
  ).get(id) as InviteRow | undefined;
  if (!row) throw notFound('邀请');
  return row;
}

interface InviteRow {
  id: string;
  code: string;
  can_read: number;
  can_upload: number;
  can_edit: number;
  is_enabled: number;
  created_by: string;
  expires_at: string | null;
  created_at: string;
  used_by: string | null;
  used_at: string | null;
}

function mapInvite(row: InviteRow) {
  return {
    id: row.id,
    code: row.code,
    permissions: {
      read: Boolean(row.can_read),
      upload: Boolean(row.can_upload),
      edit: Boolean(row.can_edit),
    },
    isEnabled: Boolean(row.is_enabled),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedBy: row.used_by,
    usedAt: row.used_at,
    used: Boolean(row.used_by),
    expired: row.expires_at !== null && row.expires_at <= new Date().toISOString(),
  };
}

function generateInviteCode(db: HubDatabase): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = randomBytes(9).toString('base64url');
    const exists = db.sqlite.prepare('SELECT 1 FROM invites WHERE code = ? LIMIT 1').get(code);
    if (!exists) return code;
  }
  throw new Error('邀请码生成失败');
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
    if (isEnabled !== Boolean(current.is_enabled)) {
      recordActivity(context.db.sqlite, {
        userId: current.id,
        action: isEnabled ? 'enable_user' : 'disable_user',
        targetType: 'user',
        targetName: current.username,
      });
    }
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
    recordActivity(context.db.sqlite, {
      userId: id,
      action: 'create_user',
      targetType: 'user',
      targetName: input.username,
    });
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
    recordActivity(context.db.sqlite, {
      userId: me.id,
      action: 'delete_user',
      targetType: 'user',
      targetName: current.username,
    });
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
    recordActivity(context.db.sqlite, {
      userId: current.id,
      action: 'reset_password',
      targetType: 'user',
      targetName: current.username,
    });
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

  // ----- 用户活动日志 -----
  app.get('/api/admin/users/:id/activity', { preHandler: adminOnly }, async (request) => {
    const { id } = parseOrThrow(userParamsSchema, request.params, '用户 ID 无效');
    getUser(context, id);
    const activities = listActivityForUser(context.db.sqlite, id, 50);
    return { activities };
  });

  // ----- 批量操作（启用/停用/删除） -----
  app.post('/api/admin/users/batch', { preHandler: adminOnly }, async (request) => {
    const input = parseOrThrow(batchActionSchema, request.body, '批量操作参数无效');
    const me = await requireUser(context.db.sqlite, request);
    const targets = input.ids.map((id) => {
      try {
        return getUser(context, id);
      } catch {
        return null;
      }
    }).filter((row): row is UserRow => row !== null);

    let affected = 0;
    const transaction = context.db.sqlite.transaction(() => {
      for (const target of targets) {
        if (target.role === 'admin') continue; // 管理员不可批量操作
        if (input.action === 'delete' && target.id === me.id) continue; // 不可删除自己

        if (input.action === 'delete') {
          context.db.sqlite.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
          context.db.sqlite.prepare('DELETE FROM users WHERE id = ?').run(target.id);
          recordActivity(context.db.sqlite, {
            userId: me.id,
            action: 'delete_user',
            targetType: 'user',
            targetName: target.username,
          });
        } else {
          const isEnabled = input.action === 'enable';
          context.db.sqlite.prepare(
            'UPDATE users SET is_enabled = ? WHERE id = ?',
          ).run(Number(isEnabled), target.id);
          if (!isEnabled) {
            context.db.sqlite.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
          }
          recordActivity(context.db.sqlite, {
            userId: target.id,
            action: isEnabled ? 'enable_user' : 'disable_user',
            targetType: 'user',
            targetName: target.username,
          });
        }
        affected += 1;
      }
    });
    transaction();
    return { ok: true, affected };
  });

  // ----- 角色变更 -----
  app.patch('/api/admin/users/:id/role', { preHandler: adminOnly }, async (request) => {
    const { id } = parseOrThrow(userParamsSchema, request.params, '用户 ID 无效');
    const input = parseOrThrow(roleSchema, request.body, '角色参数无效');
    const current = getUser(context, id);
    const me = await requireUser(context.db.sqlite, request);
    if (current.id === me.id) throw forbidden('不能修改自己的角色');

    if (current.role === 'admin' && input.role === 'user') {
      const adminCount = (context.db.sqlite.prepare(
        'SELECT COUNT(*) AS n FROM users WHERE role = ?',
      ).get('admin') as { n: number }).n;
      if (adminCount <= 1) throw forbidden('至少需要保留一个管理员账号');
    }

    const transaction = context.db.sqlite.transaction(() => {
      if (input.role === 'admin') {
        // 提升为管理员：强制启用并授予全部权限
        context.db.sqlite.prepare(
          `UPDATE users SET role = 'admin', is_enabled = 1, can_read = 1, can_upload = 1, can_edit = 1
           WHERE id = ?`,
        ).run(id);
      } else {
        context.db.sqlite.prepare('UPDATE users SET role = ? WHERE id = ?').run('user', id);
      }
    });
    transaction();
    recordActivity(context.db.sqlite, {
      userId: current.id,
      action: 'role_change',
      targetType: 'user',
      targetName: current.username,
      detail: input.role === 'admin' ? '提升为管理员' : '降级为普通用户',
    });
    return { user: mapUser(getUser(context, id)) };
  });

  // ----- 邀请链接 -----
  app.post('/api/admin/invites', { preHandler: adminOnly }, async (request, reply) => {
    const input = parseOrThrow(createInviteSchema, request.body, '邀请参数无效');
    const me = await requireUser(context.db.sqlite, request);
    const permissions = input.permissions.read
      ? input.permissions
      : { read: false, upload: false, edit: false };
    const now = new Date();
    const expiresAt = input.expiresInHours === undefined
      ? null
      : new Date(now.getTime() + input.expiresInHours * 3600 * 1000).toISOString();
    const id = randomBytes(16).toString('hex');
    const code = generateInviteCode(context.db);

    context.db.sqlite.prepare(
      `INSERT INTO invites
        (id, code, can_read, can_upload, can_edit, is_enabled, created_by, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    ).run(
      id,
      code,
      Number(permissions.read),
      Number(permissions.upload),
      Number(permissions.edit),
      me.id,
      expiresAt,
      now.toISOString(),
    );
    recordActivity(context.db.sqlite, {
      userId: me.id,
      action: 'invite_create',
      targetType: 'invite',
      targetName: code,
      detail: `读取${permissions.read ? '✓' : '✗'} 上传${permissions.upload ? '✓' : '✗'} 编辑${permissions.edit ? '✓' : '✗'}`,
    });
    return reply.code(201).send({ invite: mapInvite(inviteRow(context, id)) });
  });

  app.get('/api/admin/invites', { preHandler: adminOnly }, async () => {
    const rows = context.db.sqlite.prepare(
      `SELECT id, code, can_read, can_upload, can_edit, is_enabled, created_by,
              expires_at, created_at, used_by, used_at
       FROM invites ORDER BY created_at DESC LIMIT 200`,
    ).all() as InviteRow[];
    return { invites: rows.map(mapInvite) };
  });

  app.delete('/api/admin/invites/:id', { preHandler: adminOnly }, async (request) => {
    const { id } = parseOrThrow(inviteParamsSchema, request.params, '邀请 ID 无效');
    const invite = inviteRow(context, id);
    const me = await requireUser(context.db.sqlite, request);
    context.db.sqlite.prepare(
      'UPDATE invites SET is_enabled = 0 WHERE id = ?',
    ).run(id);
    recordActivity(context.db.sqlite, {
      userId: me.id,
      action: 'invite_revoke',
      targetType: 'invite',
      targetName: invite.code,
    });
    return { ok: true };
  });
}
