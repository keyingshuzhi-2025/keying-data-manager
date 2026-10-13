import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  listActivity,
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
import {
  noPermissions,
  getFolderAcls,
  getPermissionsHealth,
  getPermissionChain,
  resolveConfiguredPermissionSource,
  resolvePermissionSource,
  ROOT_FOLDER_ID,
  type AuthzPermission,
  type PermissionSet,
  type PermissionChainInfo,
  type HealthFinding,
} from '../authz.js';
import type { HubDatabase } from '../db/database.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { clientIp, enforceRateLimit, type RateLimiter } from '../rate-limit.js';
import {
  loadWatermarkConfig,
  saveWatermarkConfig,
  watermarkConfigSchema,
} from '../watermark-config.js';

const userParamsSchema = z.object({ id: z.string().min(1).max(128) });
const updatePermissionsSchema = z.object({
  isEnabled: z.boolean().optional(),
  canManagePermissions: z.boolean().optional(),
  permissions: z.object({
    read: z.boolean(),
    download: z.boolean(),
    upload: z.boolean(),
    edit: z.boolean(),
    editMd: z.boolean(),
    share: z.boolean(),
  }).partial().optional(),
  /** v0.1.2：存储配额上限字节数；>=0，0 表示不限制；不能低于已用空间（409） */
  storageQuotaBytes: z.number().int().min(0).optional(),
}).refine((value) => {
  return value.isEnabled !== undefined
    || value.permissions !== undefined
    || value.canManagePermissions !== undefined
    || value.storageQuotaBytes !== undefined;
}, {
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
    download: z.boolean().optional(),
    editMd: z.boolean().optional(),
    share: z.boolean().optional(),
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
    download: z.boolean().optional(),
    editMd: z.boolean().optional(),
    share: z.boolean().optional(),
  }),
  expiresInHours: z.number().int().min(1).max(24 * 365).optional(),
});

const inviteParamsSchema = z.object({ id: z.string().min(1).max(128) });

// ----- v0.1.2：全局活动审计 / 文件夹级 ACL -----

const activityQuerySchema = z.object({
  userId: z.string().min(1).max(128).optional(),
  action: z.string().min(1).max(64).optional(),
  q: z.string().max(200).optional(),
  from: z.string().min(1).max(64).optional(),
  to: z.string().min(1).max(64).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

type ActivityQuery = z.output<typeof activityQuerySchema>;

const aclQuerySchema = z.object({
  itemId: z.string().min(1).max(128),
  userId: z.string().min(1).max(128),
});

const aclPermissionsSchema = z.object({
  read: z.boolean().optional(),
  download: z.boolean().optional(),
  upload: z.boolean().optional(),
  edit: z.boolean().optional(),
  editMd: z.boolean().optional(),
  share: z.boolean().optional(),
});

const aclUpdateSchema = z.object({
  itemId: z.string().min(1).max(128),
  userId: z.string().min(1).max(128),
  permissions: aclPermissionsSchema.optional(),
  /** true = 恢复继承父级（清空当前条目的显式设置） */
  inheritParent: z.boolean().optional(),
}).refine((value) => value.permissions !== undefined || value.inheritParent !== undefined, {
  message: '至少需要设置权限或恢复继承',
});

/** 六维权限 → folder_permissions 列名（与 authz.PermissionSet 键一致，camelCase） */
const ACL_COLUMN: Record<AuthzPermission, string> = {
  read: 'can_read',
  download: 'can_download',
  upload: 'can_upload',
  edit: 'can_edit',
  editMd: 'can_edit_md',
  share: 'can_share',
};

interface FolderAclRow {
  folder_id: string;
  can_read: number;
  can_download: number;
  can_upload: number;
  can_edit: number;
  can_edit_md: number;
  can_share: number;
  updated_by: string | null;
  updated_at: string;
}

function rowToPermissionSet(row: FolderAclRow): PermissionSet {
  return {
    read: Boolean(row.can_read),
    download: Boolean(row.can_download),
    upload: Boolean(row.can_upload),
    edit: Boolean(row.can_edit),
    editMd: Boolean(row.can_edit_md),
    share: Boolean(row.can_share),
  };
}

/** itemId 必须是 'ROOT' 或现存未删除的文件/文件夹，否则 404 */
function assertAclItem(context: RouteContext, itemId: string): { kind: 'file' | 'folder' } | null {
  if (itemId === ROOT_FOLDER_ID) return null;
  const row = context.db.sqlite.prepare(
    "SELECT kind FROM files WHERE id = ? AND deleted_at IS NULL AND kind IN ('file', 'folder')",
  ).get(itemId) as { kind: 'file' | 'folder' } | undefined;
  if (!row) throw notFound('文件或文件夹');
  return row;
}

/** 读取某条目的显式 ACL 行（未设置时返回 null） */
function explicitAclRow(context: RouteContext, itemId: string): FolderAclRow | null {
  const row = context.db.sqlite.prepare(
    `SELECT folder_id, can_read, can_download, can_upload, can_edit, can_edit_md, can_share,
            updated_by, updated_at
     FROM folder_permissions WHERE folder_id = ? LIMIT 1`,
  ).get(itemId) as FolderAclRow | undefined;
  return row ?? null;
}

/** 构造 ACL 读取响应（显式设置 + 继承解析后的生效权限） */
function aclInfo(context: RouteContext, itemId: string, userId: string) {
  const item = assertAclItem(context, itemId);
  const explicit = context.db.sqlite.prepare(
    `SELECT item_id AS folder_id, can_read, can_download, can_upload, can_edit, can_edit_md, can_share,
            updated_by, updated_at
     FROM item_permissions WHERE item_id = ? AND user_id = ? LIMIT 1`,
  ).get(itemId, userId) as FolderAclRow | undefined;
  const resolved = itemId === ROOT_FOLDER_ID
    ? resolveConfiguredPermissionSource(context.db.sqlite, { kind: 'root' })
    : resolvePermissionSource(context.db.sqlite, mapUser(getUser(context, userId)), {
      kind: item?.kind ?? 'folder', id: itemId,
    });
  return {
    itemId,
    userId,
    username: getUser(context, userId).username,
    permissions: explicit ? rowToPermissionSet(explicit) : null,
    effective: resolved.permissions,
    source: resolved.source,
    sourceItemId: 'folderId' in resolved ? resolved.folderId : null,
    inheritParent: explicit === null,
    updatedAt: explicit?.updated_at ?? null,
  };
}

function usedBytes(context: RouteContext, userId: string): number {
  const row = context.db.sqlite.prepare(
    `SELECT COALESCE(SUM(size_bytes), 0) AS total
     FROM files WHERE uploaded_by = ? AND kind = 'file' AND deleted_at IS NULL`,
  ).get(userId) as { total: number } | undefined;
  return row?.total ?? 0;
}

function mapUserWithUsage(context: RouteContext, row: UserRow) {
  return { ...mapUser(row), storageUsedBytes: usedBytes(context, row.id) };
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const activityCsv = (context: RouteContext, params: ActivityQuery) => {
  const result = listActivity(context.db.sqlite, {
    userId: params.userId,
    action: params.action,
    q: params.q,
    from: params.from,
    to: params.to,
    page: params.page ?? 1,
    limit: params.limit ?? 50,
  });
  const rows = [
    ['时间', '用户', '操作', '对象类型', '对象', '详情'],
    ...result.activities.map((record) => [
      record.createdAt,
      record.username ?? record.userId,
      record.action,
      record.targetType ?? '',
      record.targetName ?? '',
      record.detail ?? '',
    ]),
  ];
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
}

interface RouteContext {
  db: HubDatabase;
  rateLimiter: RateLimiter;
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw badRequest(message, result.error.flatten());
  return result.data;
}

function getUser(context: RouteContext, id: string): UserRow {
  const user = context.db.sqlite.prepare(
    `SELECT id, username, role, is_enabled, can_read, can_upload, can_edit, can_manage_permissions, storage_quota_bytes, created_at, last_login_at
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

  const aclManagerOnly = async (request: FastifyRequest) => {
    const user = await requireUser(context.db.sqlite, request);
    if (user.role !== 'admin' && !user.canManagePermissions) throw forbidden('无权管理条目权限');
  };

  app.get('/api/admin/permissions', { preHandler: aclManagerOnly }, async (request) => {
    const input = parseOrThrow(aclQuerySchema, request.query, '权限查询参数无效');
    assertAclItem(context, input.itemId);
    getUser(context, input.userId);
    return { acl: aclInfo(context, input.itemId, input.userId) };
  });

  app.put('/api/admin/permissions', { preHandler: aclManagerOnly }, async (request) => {
    const input = parseOrThrow(aclUpdateSchema, request.body, '权限设置无效');
    const item = assertAclItem(context, input.itemId);
    if (input.itemId === ROOT_FOLDER_ID) throw badRequest('请选择具体文件或文件夹设置员工权限');
    getUser(context, input.userId);
    const actor = await requireUser(context.db.sqlite, request);
    const now = new Date().toISOString();

    const transaction = context.db.sqlite.transaction(() => {
      if (input.inheritParent === true) {
        context.db.sqlite.prepare('DELETE FROM item_permissions WHERE item_id = ? AND user_id = ?').run(input.itemId, input.userId);
      } else if (input.permissions) {
        const current = context.db.sqlite.prepare(
          `SELECT item_id AS folder_id, can_read, can_download, can_upload, can_edit, can_edit_md, can_share,
                  updated_by, updated_at
           FROM item_permissions WHERE item_id = ? AND user_id = ? LIMIT 1`,
        ).get(input.itemId, input.userId) as FolderAclRow | undefined;
        const values = current
          ? rowToPermissionSet(current)
          : resolvePermissionSource(context.db.sqlite, mapUser(getUser(context, input.userId)), {
            kind: item?.kind ?? 'folder', id: input.itemId,
          }).permissions;
        const merged = { ...values, ...input.permissions };
        context.db.sqlite.prepare(
          `INSERT INTO item_permissions
             (item_id, user_id, can_read, can_download, can_upload, can_edit, can_edit_md, can_share, updated_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(item_id, user_id) DO UPDATE SET
             can_read = excluded.can_read,
             can_download = excluded.can_download,
             can_upload = excluded.can_upload,
             can_edit = excluded.can_edit,
             can_edit_md = excluded.can_edit_md,
             can_share = excluded.can_share,
             updated_by = excluded.updated_by,
             updated_at = excluded.updated_at`,
        ).run(
          input.itemId,
          input.userId,
          Number(merged.read),
          Number(merged.download),
          Number(merged.upload),
          Number(merged.edit),
          Number(merged.editMd),
          Number(merged.share),
          actor.id,
          now,
        );
      }
    });
    transaction();
    recordActivity(context.db.sqlite, {
      userId: actor.id,
      action: 'acl_change',
      targetType: item?.kind ?? 'folder',
      targetName: input.itemId,
      detail: `${input.inheritParent === true ? '恢复继承父级权限' : '更新条目权限'}；授权用户=${input.userId}`,
    });
    return { acl: aclInfo(context, input.itemId, input.userId) };
  });

  app.get('/api/permissions/acl-users', { preHandler: aclManagerOnly }, async () => {
    const users = context.db.sqlite.prepare(
      `SELECT id, username, role, is_enabled, can_read, can_upload, can_edit,
              can_manage_permissions, storage_quota_bytes, created_at, last_login_at
       FROM users WHERE role = 'user' ORDER BY username COLLATE NOCASE`,
    ).all() as UserRow[];
    return { users: users.map(mapUser) };
  });

  app.get('/api/admin/activity', { preHandler: adminOnly }, async (request) => {
    const input = parseOrThrow(activityQuerySchema, request.query, '审计查询参数无效') as ActivityQuery;
    return listActivity(context.db.sqlite, {
      userId: input.userId,
      action: input.action,
      q: input.q,
      from: input.from,
      to: input.to,
      page: input.page,
      limit: input.limit,
    });
  });

  app.get('/api/admin/activity/export', { preHandler: adminOnly }, async (request, reply) => {
    const input = parseOrThrow(activityQuerySchema, request.query, '审计查询参数无效') as ActivityQuery;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="activity-audit-${stamp}.csv"`)
      .header('Cache-Control', 'private, no-store');
    return activityCsv(context, input);
  });

  // ----- 动态水印配置（v0.1.2 §6.1，app_config 落库，即时生效） -----

  app.get('/api/admin/watermark-config', { preHandler: adminOnly }, async () => {
    return { config: loadWatermarkConfig(context.db) };
  });

  app.put('/api/admin/watermark-config', { preHandler: adminOnly }, async (request) => {
    const input = watermarkConfigSchema.safeParse(request.body);
    if (!input.success) {
      throw badRequest('水印配置无效', input.error.flatten());
    }
    const actor = await requireUser(context.db.sqlite, request);
    const config = saveWatermarkConfig(context.db, input.data, actor.id);
    recordActivity(context.db.sqlite, {
      userId: actor.id,
      action: 'watermark_config_change',
      targetType: 'config',
      targetName: '水印配置',
      detail: `更新动态水印配置（enabled=${config.enabled}）`,
    });
    return { config };
  });

  app.get('/api/admin/users', { preHandler: adminOnly }, async () => {
    const rows = context.db.sqlite.prepare(
      `SELECT id, username, role, is_enabled, can_read, can_upload, can_edit, can_manage_permissions, storage_quota_bytes, created_at, last_login_at
       FROM users ORDER BY role ASC, created_at ASC`,
    ).all() as UserRow[];
    return { users: rows.map((row) => mapUserWithUsage(context, row)) };
  });

  app.patch('/api/admin/users/:id', { preHandler: adminOnly }, async (request) => {
    const { id } = parseOrThrow(userParamsSchema, request.params, '用户 ID 无效');
    const input = parseOrThrow(updatePermissionsSchema, request.body, '权限设置无效');
    const current = getUser(context, id);
    if (current.role === 'admin') throw forbidden('管理员账号的权限不可修改');

    const requestedPermissions = input.permissions ?? {};
    const permissions = {
      read: requestedPermissions.read ?? Boolean(current.can_read),
      download: requestedPermissions.download ?? Boolean(current.can_read),
      upload: requestedPermissions.upload ?? Boolean(current.can_upload),
      edit: requestedPermissions.edit ?? Boolean(current.can_edit),
      editMd: requestedPermissions.editMd ?? false,
      share: requestedPermissions.share ?? false,
    };
    const isEnabled = input.isEnabled ?? Boolean(current.is_enabled);
    const used = usedBytes(context, id);
    if (input.storageQuotaBytes !== undefined && input.storageQuotaBytes > 0 && input.storageQuotaBytes < used) {
      throw conflict('存储配额不能低于当前已用空间');
    }
    const transaction = context.db.sqlite.transaction(() => {
      context.db.sqlite.prepare(
        `UPDATE users
         SET is_enabled = ?, can_read = ?, can_upload = ?, can_edit = ?, can_manage_permissions = ?, storage_quota_bytes = ?
         WHERE id = ?`,
      ).run(
        Number(isEnabled),
        Number(permissions.read),
        Number(permissions.upload),
        Number(permissions.edit),
        Number(input.canManagePermissions ?? Boolean(current.can_manage_permissions)),
        input.storageQuotaBytes ?? current.storage_quota_bytes,
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
    return { user: mapUserWithUsage(context, getUser(context, id)) };
  });

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
        (id, username, password_hash, role, is_enabled, can_read, can_upload, can_edit, storage_quota_bytes, created_at)
       VALUES (?, ?, ?, 'user', ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.username,
      hashPassword(input.password),
      Number(isEnabled),
      Number(permissions.read),
      Number(permissions.upload),
      Number(permissions.edit),
      0,
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
    enforceRateLimit(context.rateLimiter, `reset-password:${clientIp(request)}`);
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
      user: mapUserWithUsage(context, user),
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

  // ----- v0.1.2：文件夹级 ACL 管理扩展接口 -----

  /** 管理员只读：站点所有已配置 ACL（含目录名）。 */
  app.get('/api/admin/permissions/all', { preHandler: adminOnly }, async () => {
    return { acls: getFolderAcls(context.db.sqlite), totalCount: getFolderAcls(context.db.sqlite).length };
  });

  /** 管理员只读：文件夹 ACL 健康检查（表存在性、ROOT 策略、模式、计数、告警）。 */
  app.get('/api/admin/permissions-health', { preHandler: adminOnly }, async () => {
    return getPermissionsHealth(context.db.sqlite);
  });

  /** 管理员只读：指定用户-目标上的完整权限链（逐跳显式 ACL + 命中点 + 继承语义）。 */
  const chainQuerySchema = z.object({
    userId: z.string().min(1).max(128),
    itemId: z.string().min(1).max(128),
  });
  app.get('/api/admin/permissions-chain', { preHandler: adminOnly }, async (request, reply) => {
    const input = parseOrThrow(chainQuerySchema, request.query, '权限链查询参数无效');
    const itemId = input.itemId;
    const item = assertAclItem(context, itemId);
    const actor = await requireUser(context.db.sqlite, request);
    // 查表确认 userId 存在（不含管理员，避免暴露内部 id 枚举）
    const targetUser = context.db.sqlite.prepare(
      'SELECT id, username, role, is_enabled, can_read, can_upload, can_edit, can_manage_permissions, storage_quota_bytes, created_at, last_login_at FROM users WHERE id = ? LIMIT 1',
    ).get(input.userId) as UserRow | undefined;
    if (!targetUser) {
      throw notFound('用户');
    }
    // 管理员可以查看任何用户的权限链；非管理员只允许查看自己的。
    if (actor.role !== 'admin' && targetUser.id !== actor.id) {
      throw forbidden('无权查看其他用户的权限链');
    }
    const chain = getPermissionChain(context.db.sqlite, mapUser(targetUser), {
      kind: item?.kind ?? 'root',
      id: itemId,
    });
    recordActivity(context.db.sqlite, {
      userId: actor.id,
      action: 'permission_chain_view',
      targetType: 'user',
      targetName: targetUser.username,
      detail: `查看权限链：用户=${targetUser.username} 目标=${itemId === ROOT_FOLDER_ID ? '根目录' : itemId}`,
    });
    return reply.code(200).send({ chain });
  });
}
