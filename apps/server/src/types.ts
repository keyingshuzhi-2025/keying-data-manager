export type FileKind = 'file' | 'folder';

export type FileType = 'folder' | 'text' | 'document' | 'image' | 'audio' | 'video' | 'other';

export interface FileRecord {
  id: string;
  parentId: string | null;
  name: string;
  kind: FileKind;
  objectId: string | null;
  mimeType: string | null;
  extension: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  isShared: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/** classifyFileType 的输入：kind 必填，mimeType / extension 可缺省（缺省时按另一维度或兜底判定） */
export interface FileTypeInput {
  kind: FileKind;
  mimeType?: string | null;
  extension?: string | null;
}

export interface ListFilesQuery {
  parentId?: string;
  q?: string;
  type?: 'folder' | 'text' | 'document' | 'image' | 'audio' | 'video' | 'other';
  sort: 'name' | 'size' | 'createdAt' | 'updatedAt';
  order: 'asc' | 'desc';
  page: number;
  limit: number;
}

export interface ListFilesResult {
  items: FileRecord[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    hasNext: boolean;
  };
}

// ---- v6：文件夹级继承权限（六维） ----

/** 文件夹级 ACL 的六种权限；管理员始终全权；'ROOT' 表示根目录默认策略 */
export const FOLDER_PERMISSION_TYPES = [
  'read',
  'download',
  'upload',
  'edit',
  'edit_md',
  'share',
] as const;

export type FolderPermission = (typeof FOLDER_PERMISSION_TYPES)[number];

/** folder_permissions 表的权限列名（与六维权限一一对应） */
export type FolderPermissionColumn =
  | 'can_read'
  | 'can_download'
  | 'can_upload'
  | 'can_edit'
  | 'can_edit_md'
  | 'can_share';

export const FOLDER_PERMISSION_COLUMNS: ReadonlyArray<FolderPermissionColumn> = [
  'can_read',
  'can_download',
  'can_upload',
  'can_edit',
  'can_edit_md',
  'can_share',
];

export const FOLDER_PERMISSION_TO_COLUMN: Record<FolderPermission, FolderPermissionColumn> = {
  read: 'can_read',
  download: 'can_download',
  upload: 'can_upload',
  edit: 'can_edit',
  edit_md: 'can_edit_md',
  share: 'can_share',
};

export const FOLDER_PERMISSION_COLUMN_TO_PERMISSION: Record<FolderPermissionColumn, FolderPermission> = {
  can_read: 'read',
  can_download: 'download',
  can_upload: 'upload',
  can_edit: 'edit',
  can_edit_md: 'edit_md',
  can_share: 'share',
};

/** 根目录默认策略的虚拟 folder_id（不指向任何 files 行，故 folder_permissions 不设外键） */
export const ROOT_FOLDER_ID = 'ROOT';

/** folder_permissions 表的行 */
export interface FolderPermissionRow {
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

// ---- v6：公开分享链接 ----

export type ShareKind = 'file' | 'folder';

/** 分享时效档位（1小时 / 1天 / 3天 / 7天 / 30天 / 永久） */
export type ShareExpiryTier = '1h' | '1d' | '3d' | '7d' | '30d' | 'forever';

export const SHARE_EXPIRY_TIERS: ReadonlyArray<ShareExpiryTier> = [
  '1h',
  '1d',
  '3d',
  '7d',
  '30d',
  'forever',
];

/** 各时效档位的毫秒数（'forever' 为永久，无上限） */
export const SHARE_EXPIRY_TIER_MS: Record<Exclude<ShareExpiryTier, 'forever'>, number> = {
  '1h': 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

/** shares 表的行（令牌只存哈希 token_hash；明文 token 仅创建时返回一次） */
export interface ShareRow {
  id: string;
  token_hash: string;
  file_id: string;
  kind: ShareKind;
  created_by: string;
  expires_at: string | null;
  max_accesses: number | null;
  access_count: number;
  password_hash: string | null;
  is_revoked: number;
  created_at: string;
  last_access_at: string | null;
}

/** shares 的对外（API）形态；不含令牌（创建响应单独返回 { token, url }） */
export interface ShareRecord {
  id: string;
  fileId: string;
  kind: ShareKind;
  createdBy: string;
  expiresAt: string | null;
  maxAccesses: number | null;
  accessCount: number;
  passwordHash: string | null;
  isRevoked: boolean;
  createdAt: string;
  lastAccessAt: string | null;
}

// ---- v6：站点键值配置 ----

/** app_config 表的行（键值站点配置，如动态水印参数） */
export interface AppConfigRow {
  key: string;
  value: string;
  updated_by: string | null;
  updated_at: string;
}

export interface AuthUser {
  id: string;
  username: string;
  role: 'admin' | 'user';
  isEnabled: boolean;
  /**
   * v0.1.2：六维权限。read/download/upload/edit 由遗留 users.can_* 派生
   * （download = read，与历史"可读即可下载"一致）；editMd/share 为新增维度，
   * 遗留数据默认关闭。文件夹级生效权限由 authz 模块按 ACL 解析，
   * 本字段为未命中 ACL 时的用户基线。
   */
  permissions: {
    read: boolean;
    download: boolean;
    upload: boolean;
    edit: boolean;
    editMd: boolean;
    share: boolean;
  };
  storageQuotaBytes: number;
  /** 已用存储字节数（管理员列表/详情返回，v0.1.2 新增） */
  storageUsedBytes?: number;
  createdAt: string;
  lastLoginAt: string | null;
}

export type UserPermission = keyof AuthUser['permissions'];

export interface CreateFileInput {
  id: string;
  parentId: string | null;
  name: string;
  objectId: string;
  mimeType: string;
  extension: string | null;
  sizeBytes: number;
  sha256: string;
}

export interface StoredObject {
  objectId: string;
  path: string;
  sizeBytes: number;
  sha256: string;
}
