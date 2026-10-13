import type { FastifyRequest } from 'fastify';
import type { AppSqliteDatabase } from './db/node-sqlite.js';
import { requireUser } from './auth.js';
import { conflict, forbidden, notFound } from './errors.js';
import type { AuthUser } from './types.js';

/**
 * 文件夹级授权（集中式 authz 模块，见 docs/v0.1.2-plan.md §5）。
 *
 * 生效规则（按优先级）：
 * 1. 管理员始终全权（admin bypass）；
 * 2. 沿目录链自近向远查找最近一条显式 ACL（`folder_permissions`，`ROOT` 为根目录默认策略兜底）；
 * 3. 命中 ROOT 时将 ROOT 策略与账号基线取交集；未命中且无 ACL 表时回退账号基线。
 *
 * 账号基线与目录策略：
 * - `ROOT` 是全局默认策略，但仍受账号级遗留权限约束，避免迁移把原本受限的账号静默放权；
 *   更近的显式文件夹 ACL 可按管理员配置覆盖该默认值。
 * - `users.can_read/can_upload/can_edit` 保留为账号级基线，在 ROOT 命中时与站点策略取交集；
 *   若 ACL 表不存在，则继续作为兼容授权来源。
 *
 * `folder_permissions` 表结构约定（与计划 §5.2 一致）：
 *   folder_id   TEXT PRIMARY KEY  -- files.id；'ROOT' 为根目录默认策略（虚拟行，不指向 files 任何行）
 *   can_read / can_download / can_upload / can_edit / can_edit_md / can_share   INTEGER
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

/** folder_permissions 表名 */
export const FOLDER_PERMISSIONS_TABLE = 'folder_permissions';

/** 站点级配置键：ROOT 默认策略模式（'open'：策略矩阵全开、仍受账号基线约束；'tighten'：仅读+下载） */
export const FOLDER_PERMISSIONS_DEFAULT_MODE_KEY = 'folder_permissions_default_mode';

/** 默认模式常量（迁移与运维脚本使用） */
export const FOLDER_PERMISSIONS_DEFAULT_MODE: ReadonlyArray<'open' | 'tighten'> = ['open', 'tighten'];

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
  read: '当前账号无权读取该目录或文件',
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
 * 账号级基线权限：ROOT 默认策略以此为上限；目录显式 ACL 可按管理员配置覆盖。
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

/** folder_permissions 表是否已存在（迁移未落地时返回 false，走遗留过渡兜底） */
function folderAclTableExists(db: AppSqliteDatabase): boolean {
  const row = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(FOLDER_PERMISSIONS_TABLE);
  return Boolean(row);
}

/** 读取 ROOT 默认策略行（不存在返回 undefined） */
function findRootAcl(db: AppSqliteDatabase): FolderAclRow | undefined {
  return db.prepare(
    `SELECT folder_id, can_read, can_download, can_upload, can_edit, can_edit_md, can_share
     FROM ${FOLDER_PERMISSIONS_TABLE} WHERE folder_id = ?`,
  ).get(ROOT_FOLDER_ID) as FolderAclRow | undefined;
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

function intersectPermissions(left: PermissionSet, right: PermissionSet): PermissionSet {
  return {
    read: left.read && right.read,
    download: left.download && right.download,
    upload: left.upload && right.upload,
    edit: left.edit && right.edit,
    editMd: left.editMd && right.editMd,
    share: left.share && right.share,
  };
}

/**
 * 在目录链中自近向远查找最近一条显式 ACL。
 * 目录链顺序为 [目标目录, 逐级父目录, ..., 根目录, ROOT]。
 * 未命中时返回 undefined（不自动回退 ROOT，调用方按需要单独处理）。
 */
function findNearestAcl(db: AppSqliteDatabase, chain: string[]): AclMatch | undefined {
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
function folderChainForFolder(db: AppSqliteDatabase, folderId: string): string[] {
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

/** 文件优先使用自身 ACL，再继承所在目录链；位于根目录时最终继承 ROOT 策略。 */
function folderChainForFile(db: AppSqliteDatabase, fileId: string): string[] {
  const row = db.prepare(
    "SELECT parent_id, kind FROM files WHERE id = ? AND deleted_at IS NULL",
  ).get(fileId) as { parent_id: string | null; kind: string } | undefined;
  if (!row) throw notFound('文件');
  if (row.kind !== 'file') throw notFound('文件');
  return [fileId, ...(row.parent_id ? folderChainForFolder(db, row.parent_id) : [ROOT_FOLDER_ID])];
}

function folderChainForTarget(db: AppSqliteDatabase, target: AuthzTarget): string[] {
  switch (target.kind) {
    case 'root':
      return [ROOT_FOLDER_ID];
    case 'folder':
      return folderChainForFolder(db, target.id);
    case 'file':
      return folderChainForFile(db, target.id);
  }
}

export type PermissionSource = 'admin' | 'item' | 'folder' | 'root' | 'legacy';

export interface PermissionResolution {
  permissions: PermissionSet;
  /** 生效来源：管理员绕过 / 最近目录 ACL / ROOT 默认策略 / 用户全局遗留权限（迁移过渡） */
  source: PermissionSource;
  /** 命中的 item_id/folder_id（source 为 'item'/'folder'/'root' 时有效） */
  folderId: string | null;
}

/**
 * 解析用户在目标上的生效权限与来源：
 * 1) 管理员全权绕过；
 * 2) 沿目录链找最近显式 ACL（含 ROOT 默认策略）；
 * 3) 均未命中时：`folder_permissions` 表不存在则回退用户全局遗留权限（迁移过渡兜底），
 *    否则返回全关（表存在但无 ACL 行属于异常状态，由健康检查告警）。
 */
export function resolvePermissionSource(
  db: AppSqliteDatabase,
  user: AuthUser,
  target: AuthzTarget,
): PermissionResolution {
  if (user.role === 'admin') {
    return { permissions: allPermissions(), source: 'admin', folderId: null };
  }
  const chain = folderChainForTarget(db, target);
  const itemTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'item_permissions'").get();
  if (itemTable) {
    const match = db.prepare(
      `SELECT item_id, can_read, can_download, can_upload, can_edit, can_edit_md, can_share
       FROM item_permissions WHERE user_id = ? AND item_id IN (${chain.map(() => '?').join(',')})`,
    ).all(user.id, ...chain) as Array<{ item_id: string; can_read: number; can_download: number; can_upload: number; can_edit: number; can_edit_md: number; can_share: number }>;
    const byId = new Map(match.map((row) => [row.item_id, row]));
    const nearest = chain.find((id) => byId.has(id));
    if (nearest) {
      const row = byId.get(nearest)!;
      return {
        permissions: mapAclRow({ ...row, folder_id: row.item_id, updated_by: null, updated_at: null }),
        source: 'item',
        folderId: nearest,
      };
    }
  }
  if (!folderAclTableExists(db)) {
    // 兼容旧库：无 ACL 表时使用账号基线权限。
    return { permissions: legacyPermissionsForUser(user), source: 'legacy', folderId: null };
  }
  const match = findNearestAcl(db, chain);
  if (match) {
    // ROOT 代表全局默认策略，不应覆盖账号原有的个人权限基线。
    // 目录级显式 ACL 仍可按管理员意图覆盖账号基线。
    const permissions = match.folderId === ROOT_FOLDER_ID
      ? intersectPermissions(match.permissions, legacyPermissionsForUser(user))
      : match.permissions;
    return {
      permissions,
      source: match.folderId === ROOT_FOLDER_ID ? 'root' : 'folder',
      folderId: match.folderId,
    };
  }
  // 表存在但链上无任何 ACL 行（包括 ROOT 被删除）：全关兜底，防止用户被意外锁死。
  return { permissions: noPermissions(), source: 'root', folderId: ROOT_FOLDER_ID };
}

/** 用户在目标上的生效六维权限（resolvePermissionSource 的简写） */
export function resolveEffectivePermissions(
  db: AppSqliteDatabase,
  user: AuthUser,
  target: AuthzTarget,
): PermissionSet {
  return resolvePermissionSource(db, user, target).permissions;
}

/**
 * 解析用户在目标上的完整权限链（供管理端权限链查看器）：
 * 沿目录链列出每一跳的显式 ACL，并标明最终命中点与生效权限。
 * 返回 shape 与 getPermissionChain 保持一致（含 target / name / parentId / 继承语义）。
 */
export function resolveEffectivePermissionChain(
  db: AppSqliteDatabase,
  user: AuthUser,
  target: AuthzTarget,
): PermissionChainInfo {
  // 保持鉴权链与线上请求使用同一套解析、回退和父目录链语义。
  return getPermissionChain(db, user, target);
}

/**
 * 校验用户对目标具备指定权限（路由 preHandler 用）：
 * 未登录抛 401；目标不存在/非法抛 404；权限不足抛 403。返回当前认证用户。
 */
export async function requireTargetPermission(
  db: AppSqliteDatabase,
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
  db: AppSqliteDatabase,
  request: FastifyRequest,
  permission: AuthzPermission,
): Promise<AuthUser> {
  return requireTargetPermission(db, request, permission, { kind: 'root' });
}

/** 要求对指定目录具备指定权限（目录不存在或不是目录时抛 404） */
export function requireFolderPermission(
  db: AppSqliteDatabase,
  request: FastifyRequest,
  permission: AuthzPermission,
  folderId: string,
): Promise<AuthUser> {
  return requireTargetPermission(db, request, permission, { kind: 'folder', id: folderId });
}

/** 要求对指定文件按所在目录具备指定权限（文件不存在时抛 404） */
export function requireFilePermission(
  db: AppSqliteDatabase,
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
  db: AppSqliteDatabase,
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

/** 要求对指定文件同时具备全部权限（文件不存在时抛 404） */
export function requireFilePermissions(
  db: AppSqliteDatabase,
  request: FastifyRequest,
  permissions: readonly AuthzPermission[],
  fileId: string,
): Promise<AuthUser> {
  return requireTargetPermissions(db, request, permissions, { kind: 'file', id: fileId });
}

/**
 * 解析目标上「已配置」的生效权限（不含管理员绕过）——供管理端 ACL 查看/编辑面板使用：
 * 沿目录链找最近显式 ACL（含 ROOT 默认策略），均未命中时优先返回 ROOT 默认策略；
 * 仅在 `folder_permissions` 表不存在时返回全关 + legacy 占位（迁移过渡）。
 */
export function resolveConfiguredPermissionSource(
  db: AppSqliteDatabase,
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
    // 链上无 ACL 行，但有 ROOT 默认策略：返回 ROOT（v7 迁移保证预置）。
    const rootRow = findRootAcl(db);
    if (rootRow) {
      return {
        permissions: mapAclRow(rootRow),
        source: 'root',
        folderId: ROOT_FOLDER_ID,
      };
    }
    // 表存在但无任何行（含 ROOT 被删）：全关。
    return { permissions: noPermissions(), source: 'root', folderId: ROOT_FOLDER_ID };
  }
  // 迁移过渡：ACL 表尚未存在。
  return { permissions: noPermissions(), source: 'legacy', folderId: null };
}

/** 权限链每一跳的完整信息（管理员只读）。 */
export interface AclHopInfo {
  folderId: string;
  name: string;
  /** 本跳显式配置的 ACL；null = 未配置（继承） */
  configured: PermissionSet | null;
  /** 本跳是否存在显式配置 */
  configuredSource: 'item' | 'folder' | 'root' | 'none';
  /** 是否被标记为命中点（对 admin 标记在 ROOT 位置，对 legacy 回退也标记在 ROOT 位置） */
  isEffective: boolean;
  /** 上一跳的 folder_id（链中前一个位置，ROOT 无上一跳） */
  parentId: string | null;
  /** 本跳是否被更近的显式 ACL 覆盖（本跳未配置，且链上更近处有配置） */
  inheritedFromNearby: boolean;
  /** 本跳是否继承自 ROOT（本跳未配置且链上无其他配置，直接沿用到 ROOT） */
  inheritedFromRoot: boolean;
}

/** 用户在目标上的完整权限链（管理员查看器用）。 */
export interface PermissionChainInfo {
  target: AuthzTarget;
  /** 沿目录链（目标目录 → 逐层父目录 → ROOT）的跳数；最后一跳为 ROOT */
  hops: AclHopInfo[];
  /** 生效权限（不含管理员绕过的语义——管理员也展示 ROOT 行为） */
  effective: PermissionSet;
  source: PermissionSource;
  folderId: string | null;
  userBaseline: PermissionSet;
}

/** 管理员只读：站点文件夹 ACL 一览（含目录名）。 */
export interface FolderAclListEntry {
  folderId: string;
  name: string;
  kind?: 'root' | 'folder' | 'file';
  userId?: string;
  username?: string;
  permissions: PermissionSet;
  updatedBy: string | null;
  updatedAt: string | null;
}

/** 管理员只读：文件夹 ACL 健康检查发现。 */
export interface HealthFinding {
  code: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
}

/** 管理员只读：文件夹 ACL 健康检查。 */
export interface PermissionsHealth {
  ok: boolean;
  tableExists: boolean;
  tableVersion: number;
  rootMode: 'open' | 'tighten' | 'unknown';
  rootAclPresent: boolean;
  aclRowCount: number;
  findings: HealthFinding[];
}

/**
 * 权限链每一跳的完整信息（管理员只读）：
 * 沿目标目录链（目标目录 → 逐层父目录 → ROOT）构造，标注每跳的显式配置与命中关系。
 */
export function getPermissionChain(
  db: AppSqliteDatabase,
  user: AuthUser,
  target: AuthzTarget,
): PermissionChainInfo {
  const chain = folderChainForTarget(db, target);
  const userBaseline = legacyPermissionsForUser(user);
  const resolution = resolvePermissionSource(db, user, target);

  // 1) 找出实际命中的 ACL 行。
  let match: { folderId: string; permissions: PermissionSet; source: 'item' | 'folder' | 'root' } | undefined;
  if (folderAclTableExists(db)) {
    const itemTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'item_permissions'").get();
    if (itemTable) {
      const itemRows = db.prepare(
        `SELECT item_id, can_read, can_download, can_upload, can_edit, can_edit_md, can_share
         FROM item_permissions WHERE user_id = ? AND item_id IN (${chain.map(() => '?').join(',')})`,
      ).all(user.id, ...chain) as Array<{ item_id: string; can_read: number; can_download: number; can_upload: number; can_edit: number; can_edit_md: number; can_share: number }>;
      const itemById = new Map(itemRows.map((row) => [row.item_id, row]));
      const nearest = chain.find((id) => itemById.has(id));
      if (nearest) {
        const row = itemById.get(nearest)!;
        match = { folderId: nearest, source: 'item', permissions: mapAclRow({ ...row, folder_id: nearest, updated_by: null, updated_at: null }) };
      }
    }
    if (!match) {
      const folderMatch = findNearestAcl(db, chain);
      if (folderMatch) match = { ...folderMatch, source: folderMatch.folderId === ROOT_FOLDER_ID ? 'root' : 'folder' };
    }
    if (!match) {
      const rootRow = findRootAcl(db);
      if (rootRow) match = { folderId: ROOT_FOLDER_ID, source: 'root', permissions: mapAclRow(rootRow) };
    }
  }

  // 2) 逐跳构建信息，带上一跳 parent_id 以便前端渲染继承关系。
  const folders = new Map<string, string | null>();
  for (let i = 0; i < chain.length - 1; i += 1) {
    folders.set(chain[i], chain[i + 1]);
  }

  // 先收集全部行（权限 + 目录名），避免逐跳多次查询。
  const rows: Map<string, FolderAclRow | undefined> = new Map();
  const itemRows: Map<string, FolderAclRow | undefined> = new Map();
  const names = new Map<string, string>();
  if (folderAclTableExists(db)) {
    for (const folderId of chain) {
      rows.set(folderId, db.prepare(
        `SELECT folder_id, can_read, can_download, can_upload, can_edit, can_edit_md, can_share
         FROM ${FOLDER_PERMISSIONS_TABLE} WHERE folder_id = ?`,
      ).get(folderId) as FolderAclRow | undefined);
      const itemTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'item_permissions'").get();
      itemRows.set(folderId, itemTable ? db.prepare(
        `SELECT item_id AS folder_id, can_read, can_download, can_upload, can_edit, can_edit_md, can_share
         FROM item_permissions WHERE item_id = ? AND user_id = ?`,
      ).get(folderId, user.id) as FolderAclRow | undefined : undefined);
      const fileRow = db.prepare(
        'SELECT name FROM files WHERE id = ? AND deleted_at IS NULL',
      ).get(folderId) as { name: string } | undefined;
      names.set(folderId, folderId === ROOT_FOLDER_ID
        ? '根目录（默认策略）'
        : (fileRow?.name ?? folderId));
    }
  }

  const hops: AclHopInfo[] = [];
  for (let i = 0; i < chain.length; i += 1) {
    const folderId = chain[i];
    const personalRow = itemRows.get(folderId);
    const row = personalRow ?? rows.get(folderId);
    const configured = row ? mapAclRow(row) : null;
    const isRoot = folderId === ROOT_FOLDER_ID;
    const parentFolderId = folders.get(folderId) ?? null;
    const isConfigured = row !== undefined;

    let configuredSource: AclHopInfo['configuredSource'] = isConfigured
      ? (personalRow ? 'item' : isRoot ? 'root' : 'folder')
      : 'none';

    // 判断继承语义：本跳未配置，若命中点为 ROOT，则沿用到 ROOT；否则沿用到最近的显式 ACL（索引大于本跳索引）。
    let inheritedFromNearby = false;
    let inheritedFromRoot = false;
    if (!isConfigured && match) {
      if (match.folderId === ROOT_FOLDER_ID) {
        inheritedFromRoot = true;
      } else if (chain.indexOf(match.folderId) > i) {
        inheritedFromNearby = true;
      }
    }

    const isEffective = isRoot
      ? resolution.source === 'admin' || resolution.source === 'root' || resolution.source === 'legacy'
      : (resolution.source === 'folder' || resolution.source === 'item') && resolution.folderId === folderId;

    hops.push({
      folderId,
      name: names.get(folderId) ?? folderId,
      configured,
      configuredSource,
      isEffective,
      parentId: parentFolderId,
      inheritedFromNearby,
      inheritedFromRoot,
    });
  }

  return {
    target,
    hops,
    effective: resolution.permissions,
    source: resolution.source,
    folderId: resolution.folderId,
    userBaseline,
  };
}

/**
 * 管理员只读：获取站点上所有已配置的 folder_permissions 行（含目录名）。
 * ROOT 行的目录名固定为「根目录（默认策略）」。
 */
export function getFolderAcls(db: AppSqliteDatabase): FolderAclListEntry[] {
  const rows = db.prepare(
    `SELECT folder_id, can_read, can_download, can_upload, can_edit, can_edit_md, can_share,
            updated_by, updated_at
     FROM folder_permissions ORDER BY folder_id`,
  ).all() as Array<{
    folder_id: string;
    can_read: number;
    can_download: number;
    can_upload: number;
    can_edit: number;
    can_edit_md: number;
    can_share: number;
    updated_by: string | null;
    updated_at: string | null;
  }>;

  const results: FolderAclListEntry[] = [];
  for (const row of rows) {
    const isRoot = row.folder_id === ROOT_FOLDER_ID;
    let name = isRoot ? '根目录（默认策略）' : '';
    if (!isRoot) {
      const fileRow = db.prepare(
        'SELECT name FROM files WHERE id = ? AND deleted_at IS NULL',
      ).get(row.folder_id) as { name: string } | undefined;
      name = fileRow?.name ?? row.folder_id;
    }
    results.push({
      folderId: row.folder_id,
      name,
      kind: isRoot ? 'root' : 'folder',
      permissions: {
        read: Boolean(row.can_read),
        download: Boolean(row.can_download),
        upload: Boolean(row.can_upload),
        edit: Boolean(row.can_edit),
        editMd: Boolean(row.can_edit_md),
        share: Boolean(row.can_share),
      },
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
    });
  }
  const itemTableExists = Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'item_permissions'",
  ).get());
  const personalRows = itemTableExists ? db.prepare(
    `SELECT ip.item_id, ip.user_id, ip.can_read, ip.can_download, ip.can_upload, ip.can_edit,
            ip.can_edit_md, ip.can_share, ip.updated_by, ip.updated_at, u.username, f.name, f.kind
     FROM item_permissions ip
     JOIN users u ON u.id = ip.user_id
     JOIN files f ON f.id = ip.item_id
     WHERE f.deleted_at IS NULL
     ORDER BY f.name COLLATE NOCASE, u.username COLLATE NOCASE`,
  ).all() as Array<{
    item_id: string; user_id: string; can_read: number; can_download: number; can_upload: number;
    can_edit: number; can_edit_md: number; can_share: number; updated_by: string | null;
    updated_at: string; username: string; name: string; kind: 'file' | 'folder';
  }> : [];
  for (const row of personalRows) {
    results.push({
      folderId: row.item_id,
      name: row.name,
      kind: row.kind,
      userId: row.user_id,
      username: row.username,
      permissions: {
        read: Boolean(row.can_read),
        download: Boolean(row.can_download),
        upload: Boolean(row.can_upload),
        edit: Boolean(row.can_edit),
        editMd: Boolean(row.can_edit_md),
        share: Boolean(row.can_share),
      },
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
    });
  }
  return results;
}

/** 管理员只读：文件夹 ACL 健康检查。 */
export function getPermissionsHealth(db: AppSqliteDatabase): PermissionsHealth {
  const findings: HealthFinding[] = [];
  const tableExists = folderAclTableExists(db);

  if (!tableExists) {
    findings.push({
      code: 'ACL_TABLE_MISSING',
      severity: 'critical',
      message: '文件夹 ACL 表（folder_permissions）不存在——迁移未落地，授权将回退到账号基线权限。',
    });
    return {
      ok: false,
      tableExists: false,
      tableVersion: 0,
      rootMode: 'unknown',
      rootAclPresent: false,
      aclRowCount: 0,
      findings,
    };
  }

  const version = Number(db.pragma('user_version', { simple: true }) as number);
  const rootModeRow = db.prepare(
    'SELECT value FROM app_config WHERE key = ?',
  ).get(FOLDER_PERMISSIONS_DEFAULT_MODE_KEY) as { value: string } | undefined;
  const rootMode: PermissionsHealth['rootMode'] = (rootModeRow?.value === 'tighten'
    ? 'tighten' : 'open') as 'open' | 'tighten' | 'unknown';
  const rootModeLabel = rootMode === 'tighten' ? '仅读 + 下载（受账号基线约束）' : '账号基线允许范围内开放';

  const rootRow = findRootAcl(db);
  const folderAclRowCount = db.prepare(
    `SELECT COUNT(*) AS n FROM ${FOLDER_PERMISSIONS_TABLE}`,
  ).get() as { n: number };
  const itemTableExists = Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'item_permissions'",
  ).get());
  const personalAclCount = itemTableExists
    ? db.prepare('SELECT COUNT(*) AS n FROM item_permissions').get() as { n: number }
    : { n: 0 };
  const aclRowCount = { n: folderAclRowCount.n + personalAclCount.n };

  if (!rootRow) {
    findings.push({
      code: 'ROOT_ACL_MISSING',
      severity: 'critical',
      message: 'ROOT 默认策略行缺失——迁移未完成或已被误删；新用户将被意外锁定。',
    });
  } else if (!rootRow.can_read) {
    findings.push({
      code: 'ROOT_ACL_TOO_RESTRICTIVE',
      severity: 'warning',
      message: 'ROOT 默认策略未开启读取——已登录用户将无法浏览任何目录，请确认是否为预期配置。',
    });
  }

  const nonRootRows = db.prepare(
    `SELECT COUNT(*) AS n FROM ${FOLDER_PERMISSIONS_TABLE} WHERE folder_id != ?`,
  ).get(ROOT_FOLDER_ID) as { n: number };
  if (rootRow && nonRootRows.n === 0 && personalAclCount.n === 0) {
    findings.push({
      code: 'ONLY_ROOT_ACL',
      severity: 'info',
      message: `当前仅配置了 ROOT 默认策略（${rootModeLabel}），未设置任何子目录 ACL。`,
    });
  }

  const totalEnabled = db.prepare(
    `SELECT COALESCE(SUM(can_read + can_download + can_upload + can_edit + can_edit_md + can_share), 0) AS total
     FROM ${FOLDER_PERMISSIONS_TABLE}`,
  ).get() as { total: number };
  if (rootMode === 'tighten' && folderAclRowCount.n > 1 && totalEnabled.total > (folderAclRowCount.n - 1) * 2) {
    findings.push({
      code: 'TIGHTEN_INCONSISTENT',
      severity: 'warning',
      message: '「默认收紧」模式下已配置多个子目录 ACL，但总权限位超过 2×(子 ACL 数)——部分目录权限可能宽于收紧预期，请复核。',
    });
  }

  return {
    ok: findings.every((f) => f.severity !== 'critical'),
    tableExists: true,
    tableVersion: version,
    rootMode,
    rootAclPresent: Boolean(rootRow),
    aclRowCount: aclRowCount.n,
    findings,
  };
}
