import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { mapUser, requireAdmin, type UserRow } from '../auth.js';
import type { HubDatabase } from '../db/database.js';
import { badRequest, forbidden, notFound } from '../errors.js';

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
    `SELECT id, username, role, is_enabled, can_read, can_upload, can_edit, created_at
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
      `SELECT id, username, role, is_enabled, can_read, can_upload, can_edit, created_at
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
}
