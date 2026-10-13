/**
 * 公开分享链接 —— 站内（需登录）管理端路由与共享数据访问层。
 *
 * 设计说明：
 * - `shares` 表由 v6 schema（db/schema.ts）与 db/database.ts 的 migrateShares 统一管理，
 *   本文件不再自举建表，避免与 v6 schema 出现差异（表以 token_hash TEXT NOT NULL UNIQUE
 *   存储令牌的 sha256 哈希；原始短码仅创建时返回一次，之后不可恢复）。
 * - 接口响应形态与 apps/web/src/types.ts 对齐：ShareLink / CreateShareLinkResponse /
 *   ShareLinkUpdateInput / ShareLinkResponse / ShareLinksResponse。
 * - 创建分享需要 authz 模块判定的 share 权限（管理员绕过；普通用户需文件夹级 ACL 授予
 *   share，未迁移时回退遗留权限——legacy 默认不授予 share）。管理（更新/撤销/删除）仅限
 *   分享者本人或管理员；列表仅要求登录并按其归属过滤。
 * - activity_logs 的 ActivityAction 联合类型尚未包含分享动作，记录时按扩展后的动作名以
 *   类型断言写入；待 activity-log.ts 扩展该联合后可移除断言。
 */

import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  recordActivity,
  type ActivityAction,
} from '../activity-log.js';
import {
  hashPassword,
  requireUser,
  verifyPassword,
  type AuthenticatedRequest,
} from '../auth.js';
import { requireFilePermission } from '../authz.js';
import type { AppConfig } from '../config.js';
import type { HubDatabase } from '../db/database.js';
import {
  AppError,
  badRequest,
  forbidden,
  notFound,
  unauthorized,
} from '../errors.js';
import type { ErrorCode } from '../errors.js';
import type { FileService } from '../file-service.js';
import type { AuthUser } from '../types.js';

/** 时效档位（毫秒）；forever 为 null 表示永久有效。 */
export const SHARE_EXPIRY_PRESETS = {
  '1h': 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  forever: null,
} as const;

export type ShareExpiryPreset = keyof typeof SHARE_EXPIRY_PRESETS;

/** 令牌哈希：落库只保存哈希（与 sessions.token_hash 一致），原始令牌仅创建时返回一次。 */
export function hashShareToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface ShareRow {
  id: string;
  token_hash: string;
  file_id: string;
  kind: 'file' | 'folder';
  created_by: string;
  expires_at: string | null;
  max_accesses: number | null;
  access_count: number;
  password_hash: string | null;
  is_revoked: number;
  created_at: string;
  last_access_at: string | null;
}

export interface ShareRootFile {
  id: string;
  name: string;
  kind: 'file' | 'folder';
  mimeType: string | null;
  extension: string | null;
  sizeBytes: number | null;
  objectId: string | null;
}

/** 分享记录（列表/详情形态；与 web 端 ShareLink 对齐）。令牌只存哈希，故不含 token。 */
export interface ShareInfo {
  id: string;
  fileId: string;
  kind: 'file' | 'folder';
  fileName: string | null;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string | null;
  maxAccesses: number | null;
  accessCount: number;
  hasPassword: boolean;
  isRevoked: boolean;
  lastAccessAt: string | null;
  expired: boolean;
}

/** 分享子树节点（匿名目录浏览用；path 为相对分享根的 / 连接路径）。 */
export interface ShareTreeNode {
  id: string;
  name: string;
  kind: 'file' | 'folder';
  mimeType: string | null;
  extension: string | null;
  sizeBytes: number | null;
  path: string;
  children?: ShareTreeNode[];
}

interface ShareWithFileRow extends ShareRow {
  username: string | null;
  file_name: string | null;
}

interface ShareTreeNodeRow {
  id: string;
  name: string;
  kind: 'file' | 'folder';
  mime_type: string | null;
  extension: string | null;
  size_bytes: number | null;
}

interface ShareRootFileRaw {
  id: string;
  name: string;
  kind: 'file' | 'folder';
  mime_type: string | null;
  extension: string | null;
  size_bytes: number | null;
  object_id: string | null;
}

function findShareByToken(db: HubDatabase, token: string): ShareRow | undefined {
  return db.sqlite.prepare(
    'SELECT * FROM shares WHERE token_hash = ? LIMIT 1',
  ).get(hashShareToken(token)) as ShareRow | undefined;
}

/**
 * 校验分享状态（不校验密码、不计数）：存在 / 未撤销 / 未过期 / 次数未超 / 根文件仍存在。
 * 任一不满足即抛对应错误；通过后返回分享行与其根文件元数据。
 */
function assertShareActive(db: HubDatabase, token: string): { share: ShareRow; root: ShareRootFile } {
  const share = findShareByToken(db, token);
  if (!share) throw shareError(404, 'SHARE_NOT_FOUND', '分享链接不存在');
  if (share.is_revoked) throw shareError(403, 'SHARE_REVOKED', '该分享已被撤销');
  if (share.expires_at !== null && share.expires_at <= new Date().toISOString()) {
    throw shareError(410, 'SHARE_EXPIRED', '该分享已过期');
  }
  if (share.max_accesses !== null && share.access_count >= share.max_accesses) {
    throw shareError(403, 'SHARE_ACCESS_EXCEEDED', '该分享的访问次数已用尽');
  }

  const root = db.sqlite.prepare(
    `SELECT id, name, kind, mime_type, extension, size_bytes, object_id
     FROM files WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
  ).get(share.file_id) as ShareRootFileRaw | undefined;
  if (!root) throw shareError(404, 'SHARE_NOT_FOUND', '分享指向的文件不存在');

  return { share, root: mapRootFile(root) };
}

/** 校验访问密码（设置了密码时）；缺失 / 错误抛对应错误，不泄露文件信息。 */
function assertSharePassword(share: ShareRow, password: string | undefined): void {
  if (!share.password_hash) return;
  if (!password) throw shareError(401, 'SHARE_PASSWORD_REQUIRED', '该分享需要访问密码');
  if (!verifyPassword(password, share.password_hash)) {
    throw shareError(401, 'SHARE_PASSWORD_INCORRECT', '访问密码错误');
  }
}

/**
 * 公开访问的统一入口：校验五要素（存在/未撤销/未过期/次数/密码），通过后自增
 * access_count 并刷新 last_access_at。返回分享行与其根文件元数据。
 */
export function resolveShareForAccess(
  db: HubDatabase,
  token: string,
  password?: string,
): { share: ShareRow; root: ShareRootFile } {
  const { share, root } = assertShareActive(db, token);
  assertSharePassword(share, password);

  const now = new Date().toISOString();
  db.sqlite.prepare(
    'UPDATE shares SET access_count = access_count + 1, last_access_at = ? WHERE id = ?',
  ).run(now, share.id);
  share.access_count += 1;
  share.last_access_at = now;

  return { share, root };
}

/**
 * 校验访问密码（不计数，供 /verify 使用）：分享状态非法时抛错；
 * 未设密码恒为 true；设置了密码时按给定密码是否匹配返回 true/false。
 */
export function checkSharePassword(
  db: HubDatabase,
  token: string,
  password: string | undefined,
): boolean {
  const { share } = assertShareActive(db, token);
  if (!share.password_hash) return true;
  if (!password) return false;
  return verifyPassword(password, share.password_hash);
}

/** 判断目标文件是否属于该分享的根文件子树（沿父链向上校验）。 */
export function isFileWithinShare(
  db: HubDatabase,
  share: ShareRow,
  targetId: string,
): boolean {
  let current: string | null = targetId;
  const visited = new Set<string>();
  while (current) {
    if (current === share.file_id) return true;
    if (visited.has(current)) return false;
    visited.add(current);
    const row = db.sqlite.prepare(
      'SELECT parent_id FROM files WHERE id = ? AND deleted_at IS NULL LIMIT 1',
    ).get(current) as { parent_id: string | null } | undefined;
    if (!row) return false;
    current = row.parent_id;
  }
  return false;
}

/** 列出分享根目录的完整子树（递归、防环、仅未删除节点），并统计文件数与总字节。 */
export function listShareSubtree(
  db: HubDatabase,
  rootId: string,
): { tree: ShareTreeNode; totalCount: number; totalBytes: number } {
  const rootRow = db.sqlite.prepare(
    `SELECT id, name, kind, mime_type, extension, size_bytes
     FROM files WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
  ).get(rootId) as ShareTreeNodeRow | undefined;
  if (!rootRow) throw shareError(404, 'SHARE_NOT_FOUND', '分享指向的文件不存在');

  const totals = { count: 0, bytes: 0 };
  const visited = new Set<string>([rootId]);

  const buildChildren = (parentId: string, path: string): ShareTreeNode[] => {
    const children = db.sqlite.prepare(
      `SELECT id, name, kind, mime_type, extension, size_bytes
       FROM files
       WHERE parent_id = ? AND deleted_at IS NULL
       ORDER BY kind = 'file' ASC, name COLLATE NOCASE ASC, id ASC`,
    ).all(parentId) as ShareTreeNodeRow[];

    const nodes: ShareTreeNode[] = [];
    for (const child of children) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      const childPath = path ? `${path}/${child.name}` : child.name;
      if (child.kind === 'file') {
        totals.count += 1;
        totals.bytes += child.size_bytes ?? 0;
        nodes.push({
          id: child.id,
          name: child.name,
          kind: 'file',
          mimeType: child.mime_type,
          extension: child.extension,
          sizeBytes: child.size_bytes,
          path: childPath,
        });
      } else {
        nodes.push({
          id: child.id,
          name: child.name,
          kind: 'folder',
          mimeType: child.mime_type,
          extension: child.extension,
          sizeBytes: child.size_bytes,
          path: childPath,
          children: buildChildren(child.id, childPath),
        });
      }
    }
    return nodes;
  };

  return {
    tree: {
      id: rootRow.id,
      name: rootRow.name,
      kind: rootRow.kind,
      mimeType: rootRow.mime_type,
      extension: rootRow.extension,
      sizeBytes: rootRow.size_bytes,
      path: rootRow.name,
      children: rootRow.kind === 'folder' ? buildChildren(rootRow.id, rootRow.name) : undefined,
    },
    totalCount: totals.count,
    totalBytes: totals.bytes,
  };
}

/**
 * 分享相关活动日志。ActivityAction 联合尚未收录分享动作，此处按扩展后的动作名写入；
 * 待 activity-log.ts 扩展该联合后可将断言替换为直接传值。
 */
export function recordShareActivity(
  db: HubDatabase,
  input: {
    userId: string;
    action: string;
    targetType?: 'file' | 'folder';
    targetName?: string;
    detail?: string;
  },
): void {
  recordActivity(db.sqlite, {
    userId: input.userId,
    action: input.action as ActivityAction,
    targetType: input.targetType,
    targetName: input.targetName,
    detail: input.detail,
  });
}

/** 分享状态错误：status/code 由调用方决定，code 暂以断言挂到 ErrorCode 上。 */
function shareError(status: number, code: string, message: string): AppError {
  return new AppError(status, code as ErrorCode, message);
}

function mapRootFile(row: ShareRootFileRaw): ShareRootFile {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    mimeType: row.mime_type,
    extension: row.extension,
    sizeBytes: row.size_bytes,
    objectId: row.object_id,
  };
}

function mapShare(row: ShareWithFileRow): ShareInfo {
  return {
    id: row.id,
    fileId: row.file_id,
    kind: row.kind,
    fileName: row.file_name,
    createdBy: row.username,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    maxAccesses: row.max_accesses,
    accessCount: row.access_count,
    hasPassword: row.password_hash !== null,
    isRevoked: Boolean(row.is_revoked),
    lastAccessAt: row.last_access_at,
    expired: row.expires_at !== null && row.expires_at <= new Date().toISOString(),
  };
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw badRequest(message, result.error.flatten());
  return result.data;
}

/** 空值 / 空串 / undefined 均视为“无密码”；否则返回去首尾空白的密码。 */
function normalizeOptionalPassword(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function generateShareToken(db: HubDatabase): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const token = randomBytes(12).toString('base64url');
    const exists = db.sqlite.prepare(
      'SELECT 1 FROM shares WHERE token_hash = ? LIMIT 1',
    ).get(hashShareToken(token));
    if (!exists) return token;
  }
  throw new Error('分享令牌生成失败');
}

const shareSelect = `
  SELECT s.id, s.token_hash, s.file_id, s.kind, s.created_by, s.expires_at,
         s.max_accesses, s.access_count, s.password_hash, s.is_revoked,
         s.created_at, s.last_access_at,
         u.username, f.name AS file_name
  FROM shares s
  LEFT JOIN users u ON u.id = s.created_by
  LEFT JOIN files f ON f.id = s.file_id
`;

function getShareById(db: HubDatabase, id: string): ShareWithFileRow {
  const row = db.sqlite.prepare(
    `${shareSelect} WHERE s.id = ? LIMIT 1`,
  ).get(id) as ShareWithFileRow | undefined;
  if (!row) throw notFound('分享');
  return row;
}

function assertShareOwnerOrAdmin(share: ShareWithFileRow, user: AuthUser): void {
  if (user.role !== 'admin' && share.created_by !== user.id) {
    throw forbidden('无权操作该分享');
  }
}

function shareUrl(config: AppConfig, token: string): string {
  const base = config.publicUrl?.trim().replace(/\/+$/, '');
  return base ? `${base}/s/${token}` : `/s/${token}`;
}

// ----- Zod 校验 -----

const presetSchema = z.enum(['1h', '1d', '3d', '7d', '30d', 'forever']);
const shareIdParamsSchema = z.object({ id: z.string().min(1).max(128) });

const createShareSchema = z.object({
  fileId: z.string().uuid(),
  expiresIn: presetSchema.default('7d'),
  maxAccesses: z.number().int().min(1).max(1_000_000).nullable().optional(),
  password: z.string().max(1024).nullable().optional(),
});

const updateShareSchema = z.object({
  expiresIn: presetSchema.optional(),
  maxAccesses: z.number().int().min(1).max(1_000_000).nullable().optional(),
  password: z.string().max(1024).nullable().optional(),
  isRevoked: z.boolean().optional(),
  resetCount: z.boolean().optional(),
}).refine((value) => {
  return value.expiresIn !== undefined
    || value.maxAccesses !== undefined
    || value.password !== undefined
    || value.isRevoked !== undefined
    || value.resetCount !== undefined;
}, { message: '至少需要更新一项设置' });

const listSharesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  mine: z.enum(['true', 'false']).optional(),
});

// zod 的 ZodType<T> 泛型按输入侧（各字段均可选）推断，故 parse 后需投影到具体接口
// （与 routes/files.ts 对 listQuerySchema 的处理一致）。
interface CreateShareInput {
  fileId: string;
  expiresIn: ShareExpiryPreset;
  maxAccesses: number | null | undefined;
  password: string | null | undefined;
}

interface ShareListQuery {
  page: number;
  limit: number;
  mine?: 'true' | 'false';
}

export interface ShareRouteContext {
  config: AppConfig;
  db: HubDatabase;
  files: FileService;
}

export function registerShareRoutes(app: FastifyInstance, context: ShareRouteContext): void {
  // 管理分享仅要求登录；创建分享在 handler 内通过 authz 校验 share 权限。
  const requireLogin = async (request: FastifyRequest): Promise<void> => {
    await requireUser(context.db.sqlite, request);
  };

  const currentUser = (request: FastifyRequest): AuthUser => {
    const user = (request as AuthenticatedRequest).user;
    if (!user) throw unauthorized();
    return user;
  };

  // ----- 创建分享（原始令牌仅在此返回一次） -----
  // authz：要求用户对该文件（或其所在文件夹）具备 share 权限；管理员绕过，文件不存在抛 404。
  app.post('/api/share-links', async (request, reply) => {
    const input = parseOrThrow(createShareSchema, request.body, '创建分享参数无效') as CreateShareInput;
    const user = await requireFilePermission(context.db.sqlite, request, 'share', input.fileId);
    const file = context.files.get(input.fileId);
    const ttl = SHARE_EXPIRY_PRESETS[input.expiresIn];
    const expiresAt = ttl === null ? null : new Date(Date.now() + ttl).toISOString();
    const password = normalizeOptionalPassword(input.password);
    const id = randomBytes(16).toString('hex');
    const token = generateShareToken(context.db);
    const now = new Date().toISOString();

    context.db.sqlite.prepare(
      `INSERT INTO shares
        (id, token_hash, file_id, kind, created_by, expires_at, max_accesses, access_count, password_hash, is_revoked, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?)`,
    ).run(
      id,
      hashShareToken(token),
      file.id,
      file.kind,
      user.id,
      expiresAt,
      input.maxAccesses ?? null,
      password === null ? null : hashPassword(password),
      now,
    );
    context.db.sqlite.prepare('UPDATE files SET is_shared = 1 WHERE id = ?').run(file.id);

    recordShareActivity(context.db, {
      userId: user.id,
      action: 'share_create',
      targetType: file.kind,
      targetName: file.name,
      detail: `档位 ${input.expiresIn}${password ? '，含访问密码' : ''}`,
    });

    return reply.code(201).send({
      share: mapShare(getShareById(context.db, id)),
      token,
      url: shareUrl(context.config, token),
    });
  });

  // ----- 分享列表：管理员可见全部；普通用户仅自己的；?mine=true 强制只看自己的 -----
  app.get('/api/share-links', { preHandler: requireLogin }, async (request) => {
    const user = currentUser(request);
    const query = parseOrThrow(listSharesQuerySchema, request.query, '查询参数无效') as ShareListQuery;
    const adminAll = user.role === 'admin' && query.mine !== 'true';
    const where = adminAll ? '' : 'WHERE s.created_by = ?';
    const values: unknown[] = adminAll ? [] : [user.id];

    const total = (context.db.sqlite.prepare(
      `SELECT COUNT(*) AS total FROM shares s ${where}`,
    ).get(...values) as { total: number }).total;

    const rows = context.db.sqlite.prepare(
      `${shareSelect} ${where} ORDER BY s.created_at DESC, s.id DESC LIMIT ? OFFSET ?`,
    ).all(...values, query.limit, (query.page - 1) * query.limit) as ShareWithFileRow[];

    return {
      shares: rows.map(mapShare),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        hasNext: query.page * query.limit < total,
      },
    };
  });

  // ----- 分享详情 -----
  app.get('/api/share-links/:id', { preHandler: requireLogin }, async (request) => {
    const user = currentUser(request);
    const { id } = parseOrThrow(shareIdParamsSchema, request.params, '分享 ID 无效');
    const row = getShareById(context.db, id);
    assertShareOwnerOrAdmin(row, user);
    return { share: mapShare(row) };
  });

  // ----- 更新分享：重置时效/次数上限/密码，撤销/恢复，重置计数 -----
  app.patch('/api/share-links/:id', { preHandler: requireLogin }, async (request) => {
    const user = currentUser(request);
    const { id } = parseOrThrow(shareIdParamsSchema, request.params, '分享 ID 无效');
    const input = parseOrThrow(updateShareSchema, request.body, '更新参数无效');
    const current = getShareById(context.db, id);
    assertShareOwnerOrAdmin(current, user);

    const sets: string[] = [];
    const values: unknown[] = [];
    if (input.expiresIn !== undefined) {
      const ttl = SHARE_EXPIRY_PRESETS[input.expiresIn];
      sets.push('expires_at = ?');
      values.push(ttl === null ? null : new Date(Date.now() + ttl).toISOString());
    }
    if (input.maxAccesses !== undefined) {
      sets.push('max_accesses = ?');
      values.push(input.maxAccesses);
    }
    if (input.password !== undefined) {
      const password = normalizeOptionalPassword(input.password);
      sets.push('password_hash = ?');
      values.push(password === null ? null : hashPassword(password));
    }
    if (input.isRevoked !== undefined) {
      sets.push('is_revoked = ?');
      values.push(input.isRevoked ? 1 : 0);
    }
    if (input.resetCount === true) {
      sets.push('access_count = 0');
    }
    if (sets.length === 0) throw badRequest('至少需要更新一项设置');

    context.db.sqlite.prepare(
      `UPDATE shares SET ${sets.join(', ')} WHERE id = ?`,
    ).run(...values, id);

    recordShareActivity(context.db, {
      userId: user.id,
      action: input.isRevoked === true ? 'share_revoke' : 'share_update',
      targetType: current.kind,
      targetName: current.file_name ?? undefined,
      detail: `更新分享 ${current.id}`,
    });

    return { share: mapShare(getShareById(context.db, id)) };
  });

  // ----- 立即撤销（即时生效；公开端点每次读取都会校验 is_revoked） -----
  app.post('/api/share-links/:id/revoke', { preHandler: requireLogin }, async (request) => {
    const user = currentUser(request);
    const { id } = parseOrThrow(shareIdParamsSchema, request.params, '分享 ID 无效');
    const current = getShareById(context.db, id);
    assertShareOwnerOrAdmin(current, user);

    context.db.sqlite.prepare(
      'UPDATE shares SET is_revoked = 1 WHERE id = ?',
    ).run(id);

    recordShareActivity(context.db, {
      userId: user.id,
      action: 'share_revoke',
      targetType: current.kind,
      targetName: current.file_name ?? undefined,
      detail: '撤销分享链接',
    });

    return { share: mapShare(getShareById(context.db, id)) };
  });

  // ----- 删除分享记录 -----
  app.delete('/api/share-links/:id', { preHandler: requireLogin }, async (request) => {
    const user = currentUser(request);
    const { id } = parseOrThrow(shareIdParamsSchema, request.params, '分享 ID 无效');
    const current = getShareById(context.db, id);
    assertShareOwnerOrAdmin(current, user);

    context.db.sqlite.prepare('DELETE FROM shares WHERE id = ?').run(id);

    recordShareActivity(context.db, {
      userId: user.id,
      action: 'share_delete',
      targetType: current.kind,
      targetName: current.file_name ?? undefined,
      detail: '删除分享记录',
    });

    return { ok: true };
  });
}
