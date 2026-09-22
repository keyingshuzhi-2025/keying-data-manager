import type { FastifyRequest } from 'fastify';
import Database from 'better-sqlite3';
import { requireUser } from './auth.js';
import { conflict, forbidden, notFound } from './errors.js';
import type { AuthUser } from './types.js';

/**
 * 文件夹级授权（集中式 authz 模块，见 docs/v0.1.2-plan.md §5）。
 *
 * 生效规则（按优先级）：
 * 1. 管理员始终全权（admin bypass）；
 * 2. 沿目录链自近向远查找最近一条显式 ACL（`folder_permissions`，`ROOT` 为根目录默认策略兜底）；
 * 3. 均未命中（含 `folder_permissions` 表尚未迁移）时，回退到用户全局遗留权限
 *    （users.can_read / can_upload / can_edit）。
 *
 * `folder_permissions` 表结构约定（与计划 §5.2 一致，迁移落地前该表不存在）：
 *   folder_id   TEXT PRIMARY KEY  -- files.id；'ROOT' 为默认策略
 *   can_read    INTEGER, can_download INTEGER, can_upload INTEGER,
 *   can_edit    INTEGER, can_edit_md   INTEGER, can_share   INTEGER,
 *   updated_by  TEXT, updated_at TEXT
 */

/** 六维权限维度 */
export type AuthzPermission = 'read' | 'download' | 'upload' | 'edit' | 'editMd' | 'share';

/** 六维权限位集合 */
export type PermissionSet = Record<AuthzPermission, boolean>;

export const PERMISSIONS: readonly AuthzPermission[] = [
  'read',
  'download',
  'upload',
  'edit',
  'editMd',
  'share',
] as const;

/** folder_permissions.folder_id 使用的根目录默认策略标识 */
export const ROOT_FOLDER_ID = 'ROOT';

/** 文件夹级 ACL 表名 */
export const FOLDER_PERMISSIONS_TABLE = 'folder_permissions';

/** 权限判定目标：根目录默认策略 / 目录 / 文件（文件按所在目录判定） */
export type AuthzTarget =
  | { kind: 'root' }
  | { kind: 'folder'; id: string }
  | { kind: 'file'; id: string };

/** folder_permissions 行（snake_case 列映射，与 users 表遗留列命名一致） */
interface FolderAclRow {
  folder_id: string;
  can_read: number;
  can_download: number;
  can_upload: number;
  can_edit: number;
  can_edit_md: number;
  can_share: number;
  updated_by: string | null;
  updated_at: string | null;
}

interface AclMatch {
  folderId: string;
  permissions: PermissionSet;
}

const permissionMessages: Record<AuthzPermission, string> = {
  read: '当前账号无权查看该目录或文件',
  download: '当前账号无权下载该文件',
  upload: '当前账号无权在该位置上传或创建',
  edit: '当前账号无权修改该目录或文件',
  editMd: '当前账号无权编辑该 Markdown 文件',
  share: '当前账号无权创建分享链接',
};

/** 六维全开（管理员绕过 / 全开默认策略） */
export function allPermissions(): PermissionSet {
  return {
    read: true,
    download: true,
    upload: true,
    edit: true,
    editMd: true,
    share: true,
  };
}

/** 六维全关 */
export function noPermissions(): PermissionSet {
  return {
    read: false,
    download: false,
    upload: false,
    edit: false,
    editMd: false,
    share: false,
  };
}

/**
 * 遗留用户全局权限回退：
 * - read/upload/edit 直接映射 users.can_read / can_upload / can_edit；
 * - download 与历史行为一致（原下载接口仅要求 read，即"可读即可下载"）；
 * - editMd/share 为新增维度，遗留数据未授予，默认关闭（最小权限）。
 */
export function legacyPermissionsForUser(user: AuthUser): PermissionSet {
  return {
    ...noPermissions(),
    read: user.permissions.read,
    download: user.permissions.read,
    upload: user.permissions.upload,
    edit: user.permissions.edit,
  };
}

export function hasPermission(set: PermissionSet, permission: AuthzPermission): boolean {
  return set[permission];
}

/** folder_permissions 表是否已存在（迁移未落地时返回 false，走遗留回退） */
function folderAclTableExists(db: Database.Database): boolean {
  const row = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(FOLDER_PERMISSIONS_TABLE);
  return Boolean(row);
}

function mapAclRow(row: FolderAclRow): PermissionSet {
  return {
    read: Boolean(row.can_read),
    download: Boolean(row.can_download),
    upload: Boolean(row.can_upload),
    edit: Boolean(row.can_edit),
    editMd: Boolean(row.can_edit_md),
    share: Boolean(row.can_share),
  };
}

/**
 * 在目录链中自近向远查找最近一条显式 ACL。
 * 目录链顺序为 [目标目录, 逐级父目录, ..., 根目录, ROOT]。
 */
function findNearestAcl(db: Database.Database, chain: string[]): AclMatch | undefined {
  const placeholders = chain.map(() => '?').join(', ');
  const rows = db.prepare(
    `SELECT folder_id, can_read, can_download, can_upload, can_edit, can_edit_md, can_share
     FROM ${FOLDER_PERMISSIONS_TABLE} WHERE folder_id IN (${placeholders})`,
  ).all(...chain) as FolderAclRow[];
  const byFolderId = new Map<string, FolderAclRow>(
    rows.map((row): [string, FolderAclRow] => [row.folder_id, row]),
  );
  for (const folderId of chain) {
    const row = byFolderId.get(folderId);
    if (row) return { folderId, permissions: mapAclRow(row) };
  }
  return undefined;
}

/**
 * 从指定目录沿父链向上收集目录 id（含自身），末尾追加 ROOT。
 * 目录不存在或不是目录时抛 404；目录结构存在循环引用时抛 409。
 */
function folderChainForFolder(db: Database.Database, folderId: string): string[] {
  const chain: string[] = [];
  const visited = new Set<string>();
  let current: string | null = folderId;

  while (current) {
    if (visited.has(current)) throw conflict('目录结构存在循环引用');
    visited.add(current);
    chain.push(current);
    const row = db.prepare(
      'SELECT parent_id, kind FROM files WHERE id = ? AND deleted_at IS NULL',
    ).get(current) as { parent_id: string | null; kind: string } | undefined;
    if (!row) throw notFound('目录');
    if (row.kind !== 'folder') throw notFound('目录');
    current = row.parent_id;
  }

  chain.push(ROOT_FOLDER_ID);
  return chain;
}

/** 文件按其所在目录判定权限；位于根目录的文件直接使用 ROOT 默认策略 */
function folderChainForFile(db: Database.Database, fileId: string): string[] {
  const row = db.prepare(
    'SELECT parent_id FROM files WHERE id = ? AND deleted_at IS NULL',
  ).get(fileId) as { parent_id: string | null } | undefined;
  if (!row) throw notFound('文件');
  return row.parent_id ? folderChainForFolder(db, row.parent_id) : [ROOT_FOLDER_ID];
}

function folderChainForTarget(db: Database.Database, target: AuthzTarget): string[] {
  switch (target.kind) {
    case 'root':
      return [ROOT_FOLDER_ID];
    case 'folder':
      return folderChainForFolder(db, target.id);
    case 'file':
      return folderChainForFile(db, target.id);
  }
}

export type PermissionSource = 'admin' | 'folder' | 'root' | 'legacy';

export interface PermissionResolution {
  permissions: PermissionSet;
  /** 生效来源：管理员绕过 / 最近目录 ACL / ROOT 默认策略 / 用户全局遗留权限 */
  source: PermissionSource;
  /** 命中的 folder_id（source 为 'folder'/'root' 时有效；'admin'/'legacy' 时为 null） */
  folderId: string | null;
}

/**
 * 解析用户在目标上的生效权限与来源：
 * 1) 管理员全权绕过；
 * 2) 沿目录链找最近显式 ACL（含 ROOT 默认策略）；
 * 3) 均未命中时回退到用户全局遗留权限。
 */
export function resolvePermissionSource(
  db: Database.Database,
  user: AuthUser,
  target: AuthzTarget,
): PermissionResolution {
  if (user.role === 'admin') {
    return { permissions: allPermissions(), source: 'admin', folderId: null };
  }
  const chain = folderChainForTarget(db, target);
  if (folderAclTableExists(db)) {
    const match = findNearestAcl(db, chain);
    if (match) {
      return {
        permissions: match.permissions,
        source: match.folderId === ROOT_FOLDER_ID ? 'root' : 'folder',
        folderId: match.folderId,
      };
    }
  }
  return { permissions: legacyPermissionsForUser(user), source: 'legacy', folderId: null };
}

/** 用户在目标上的生效六维权限（resolvePermissionSource 的简写） */
export function resolveEffectivePermissions(
  db: Database.Database,
  user: AuthUser,
  target: AuthzTarget,
): PermissionSet {
  return resolvePermissionSource(db, user, target).permissions;
}

/**
 * 校验用户对目标具备指定权限（路由 preHandler 用）：
 * 未登录抛 401；目标不存在/非法抛 404；权限不足抛 403。返回当前认证用户。
 */
export async function requireTargetPermission(
  db: Database.Database,
  request: FastifyRequest,
  permission: AuthzPermission,
  target: AuthzTarget,
): Promise<AuthUser> {
  const user = await requireUser(db, request);
  const effective = resolveEffectivePermissions(db, user, target);
  if (!effective[permission]) throw forbidden(permissionMessages[permission]);
  return user;
}

/** 要求对根目录（默认策略）具备指定权限 */
export function requireRootPermission(
  db: Database.Database,
  request: FastifyRequest,
  permission: AuthzPermission,
): Promise<AuthUser> {
  return requireTargetPermission(db, request, permission, { kind: 'root' });
}

/** 要求对指定目录具备指定权限（目录不存在或不是目录时抛 404） */
export function requireFolderPermission(
  db: Database.Database,
  request: FastifyRequest,
  permission: AuthzPermission,
  folderId: string,
): Promise<AuthUser> {
  return requireTargetPermission(db, request, permission, { kind: 'folder', id: folderId });
}

/** 要求对指定文件按所在目录具备指定权限（文件不存在时抛 404） */
export function requireFilePermission(
  db: Database.Database,
  request: FastifyRequest,
  permission: AuthzPermission,
  fileId: string,
): Promise<AuthUser> {
  return requireTargetPermission(db, request, permission, { kind: 'file', id: fileId });
}

/**
 * 要求对目标同时具备全部指定权限（用于 download 需 read+download、导出等场景）。
 * 一次解析生效权限，避免多趟目录链查询。
 */
export async function requireTargetPermissions(
  db: Database.Database,
  request: FastifyRequest,
  permissions: readonly AuthzPermission[],
  target: AuthzTarget,
): Promise<AuthUser> {
  const user = await requireUser(db, request);
  const effective = resolveEffectivePermissions(db, user, target);
  for (const permission of permissions) {
    if (!effective[permission]) throw forbidden(permissionMessages[permission]);
  }
  return user;
}

/** 要求对指定文件同时具备全部指定权限（文件不存在时抛 404） */
export function requireFilePermissions(
  db: Database.Database,
  request: FastifyRequest,
  permissions: readonly AuthzPermission[],
  fileId: string,
): Promise<AuthUser> {
  return requireTargetPermissions(db, request, permissions, { kind: 'file', id: fileId });
}

/**
 * 解析目标上「已配置」的生效权限（不含管理员绕过）——供管理端 ACL 查看/编辑面板使用：
 * 沿目录链找最近显式 ACL（含 ROOT 默认策略），均未命中时返回全关（legacy 展示占位）。
 */
export function resolveConfiguredPermissionSource(
  db: Database.Database,
  target: AuthzTarget,
): { permissions: PermissionSet; source: 'folder' | 'root' | 'legacy'; folderId: string | null } {
  const chain = folderChainForTarget(db, target);
  if (folderAclTableExists(db)) {
    const match = findNearestAcl(db, chain);
    if (match) {
      return {
        permissions: match.permissions,
        source: match.folderId === ROOT_FOLDER_ID ? 'root' : 'folder',
        folderId: match.folderId,
      };
    }
  }
  return { permissions: noPermissions(), source: 'legacy', folderId: null };
}
