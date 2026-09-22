export type FileKind = 'file' | 'folder';
// NOTE: 服务端 v0.1.2 将新增 'text' 类型（docs/v0.1.2-plan.md §7），
// 但 FileTypeIcon.tsx 的 Record<FileType, LucideIcon> 尚未同步，
// 此处暂不扩展以保持 TypeScript 兼容；M1 里程碑再一并更新。
export type FileType = 'folder' | 'text' | 'image' | 'audio' | 'video' | 'document' | 'other';
export type SortField = 'name' | 'size' | 'createdAt' | 'updatedAt';
export type SortOrder = 'asc' | 'desc';

// ----- 分页 -----
export interface Pagination {
  page: number;
  limit: number;
  total: number;
  hasNext: boolean;
}

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
  /** 是否已有公开分享链接（v0.1.2 新增） */
  isShared: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface FileListResponse {
  items: FileRecord[];
  pagination: Pagination;
}

export interface FileListParams {
  parentId?: string | null;
  q?: string;
  type?: FileType;
  sort?: SortField;
  order?: SortOrder;
  page?: number;
  limit?: number;
}

// ----- 六维权限（与 docs/v0.1.2-plan.md §5.1 一致） -----
export type Permission = 'read' | 'download' | 'upload' | 'edit' | 'editMd' | 'share';

/** 完整六维权限位集合（文件夹 ACL 使用；服务端 authz.PermissionSet 的镜像） */
export type PermissionSet = Record<Permission, boolean>;

/**
 * 权限集合。read / upload / edit 为既有全局权限；
 * download / editMd / share 为 v0.1.2 新增维度，声明为可选字段以保持与
 * 现有三项权限字面量（{ read, upload, edit }）的 TypeScript 兼容。
 */
export interface Permissions {
  read: boolean;
  upload: boolean;
  edit: boolean;
  download?: boolean;
  editMd?: boolean;
  share?: boolean;
}

export interface AuthUser {
  id: string;
  username: string;
  role: 'admin' | 'user';
  isEnabled: boolean;
  permissions: Permissions;
  /** 存储配额上限字节数；0 表示不限制 */
  storageQuotaBytes: number;
  /** 已用存储字节数（管理员列表/详情返回，v0.1.2 新增） */
  storageUsedBytes?: number;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface SessionResponse {
  user: AuthUser;
  expiresAt?: string;
}

export interface UsersResponse {
  users: AuthUser[];
}

export interface UserAccessUpdate {
  isEnabled?: boolean;
  permissions?: AuthUser['permissions'];
  /** v0.1.2：管理员调整存储配额（>=0，0 表示不限制） */
  storageQuotaBytes?: number;
}

export interface UserDetailsResponse {
  user: AuthUser;
  stats: {
    activeSessionCount: number;
    globalFileCount: number;
    globalTotalBytes: number;
  };
}

export interface CreateUserInput {
  username: string;
  password: string;
  isEnabled: boolean;
  permissions: AuthUser['permissions'];
}

export interface ResetPasswordInput {
  newPassword: string;
}

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

export type BatchAction = 'enable' | 'disable' | 'delete';

export interface BatchUsersInput {
  ids: string[];
  action: BatchAction;
}

export interface BatchUsersResult {
  ok: boolean;
  affected: number;
}

export interface RoleChangeInput {
  role: 'admin' | 'user';
}

export interface Invite {
  id: string;
  code: string;
  permissions: Permissions;
  isEnabled: boolean;
  createdAt: string;
  expiresAt: string | null;
  usedBy: string | null;
  usedAt: string | null;
  used: boolean;
  expired: boolean;
}

export interface InviteCreateInput {
  permissions: AuthUser['permissions'];
  expiresInHours?: number;
}

export interface InvitesResponse {
  invites: Invite[];
}

export interface ActivityRecord {
  id: string;
  userId: string;
  username?: string;
  action: string;
  targetType: string | null;
  targetName: string | null;
  detail: string | null;
  createdAt: string;
}

export interface UserActivityResponse {
  activities: ActivityRecord[];
}

// ----- 活动审计（全站） -----
export interface ActivityListParams {
  userId?: string;
  action?: string;
  q?: string;
  /** 起始时间（ISO 字符串），与 to 配合筛选 */
  from?: string;
  /** 截止时间（ISO 字符串） */
  to?: string;
  page?: number;
  limit?: number;
}

export interface ActivityListResponse {
  activities: ActivityRecord[];
  pagination: Pagination;
}

/** 活动日志 CSV 导出（v0.1.2 新增） */
export type ActivityExportResponse = string;

// ----- 文件夹级权限（六维 ACL，docs/v0.1.2-plan.md §5） -----
export type PermissionSource = 'admin' | 'folder' | 'root' | 'legacy';

/** 文件夹权限的读取结果：本目录显式设置 + 沿目录链继承解析后的生效权限 */
export interface FolderAclInfo {
  folderId: string;
  /** 本目录显式设置的六维权限；未设置（继承父目录）时为 null */
  permissions: PermissionSet | null;
  /** 继承解析后的生效六维权限 */
  effective: PermissionSet;
  /** 生效来源：admin / folder / root / legacy */
  source: PermissionSource;
  /** 生效来源的 folder_id（source 为 folder/root 时有效；否则为 null） */
  sourceFolderId: string | null;
  /** 是否继承父目录（本目录无显式设置时为 true） */
  inheritParent: boolean;
  updatedAt: string | null;
}

export interface FolderAclResponse {
  acl: FolderAclInfo;
}

/** 设置/恢复文件夹权限的输入；folderId 为 'ROOT' 时表示根目录默认策略 */
export interface FolderAclUpdateInput {
  folderId: string;
  /** 设置本目录显式权限；缺省表示仅调整继承 */
  permissions?: Partial<PermissionSet>;
  /** true = 恢复继承父目录（清空本目录显式设置） */
  inheritParent?: boolean;
}

// ----- 公开分享链接（docs/v0.1.2-plan.md §4；服务端 routes/shares.ts 的 API 形态） -----
export type ShareKind = 'file' | 'folder';

/** 分享时效档位：1小时 / 1天 / 3天 / 7天 / 30天 / 永久 */
export type ShareExpiryTier = '1h' | '1d' | '3d' | '7d' | '30d' | 'forever';

/**
 * 分享记录（列表/详情形态）。令牌只落库哈希，原始令牌仅创建时返回一次，
 * 因此该形态不含 token；创建响应单独返回 { share, token, url }。
 */
export interface ShareLink {
  id: string;
  fileId: string;
  kind: ShareKind;
  fileName: string | null;
  /** 创建者用户名（可能已删除） */
  createdBy: string | null;
  createdAt: string;
  expiresAt: string | null;
  /** 访问次数上限；null 表示不限 */
  maxAccesses: number | null;
  accessCount: number;
  hasPassword: boolean;
  isRevoked: boolean;
  lastAccessAt: string | null;
  /** 是否已过期（expiresAt 非空且早于当前时间） */
  expired: boolean;
}

export interface CreateShareLinkInput {
  fileId: string;
  /** 时效档位；缺省时服务端默认 '7d' */
  expiresIn?: ShareExpiryTier;
  /** 可选：访问/下载次数上限 */
  maxAccesses?: number | null;
  /** 可选：访问密码 */
  password?: string | null;
}

/** 创建分享的响应：原始令牌与完整链接仅在此返回一次 */
export interface CreateShareLinkResponse {
  share: ShareLink;
  token: string;
  url: string;
}

export interface ShareLinkUpdateInput {
  expiresIn?: ShareExpiryTier;
  maxAccesses?: number | null;
  password?: string | null;
  /** true = 撤销；false = 恢复 */
  isRevoked?: boolean;
  /** true = 重置访问计数 */
  resetCount?: boolean;
}

export interface ShareLinkResponse {
  share: ShareLink;
}

export interface ShareLinksResponse {
  shares: ShareLink[];
  pagination: Pagination;
}

export interface ShareLinksParams {
  page?: number;
  limit?: number;
  /** true = 仅看自己创建的分享（管理员默认可见全部） */
  mine?: boolean;
}

// ----- 存储配额（docs/v0.1.2-plan.md §8） -----
export interface QuotaUpdateInput {
  /** 配额上限字节数；0 表示不限制；不能低于已用存储 */
  storageQuotaBytes: number;
}

// ----- 文件内容 / 预览 / 导出（docs/v0.1.2-plan.md §6–§7） -----
export interface FileContentResponse {
  fileId: string;
  name: string;
  mimeType: string | null;
  /** 文本内容（UTF-8 解码；二进制文件为空并标记 isBinary） */
  content: string;
  sizeBytes: number;
  encoding: string;
  isBinary: boolean;
  /** 内容超过后端返回上限时被截断 */
  truncated: boolean;
}

/** 在线编辑文本/MD 文件（需 edit_md 权限） */
export interface FileContentUpdateInput {
  content: string;
}

export type PreviewKind = 'markdown' | 'text';

export interface FilePreviewResponse {
  fileId: string;
  name: string;
  kind: PreviewKind;
  content: string;
  sizeBytes: number;
  truncated: boolean;
}

// ----- 公开分享（匿名访问，docs/v0.1.2-plan.md §4.3–4.4） -----
/** 公开接口返回的文件元数据：不暴露内部路径/上传者/校验值等内部字段 */
export interface PublicShareFile {
  id: string;
  name: string;
  kind: FileKind;
  mimeType: string | null;
  extension: string | null;
  sizeBytes: number | null;
}

export interface PublicShareInfo {
  fileId: string;
  kind: ShareKind;
  fileName: string | null;
  createdAt: string;
  expiresAt: string | null;
  maxAccesses: number | null;
  accessCount: number;
  hasPassword: boolean;
  isRevoked: boolean;
  lastAccessAt: string | null;
  expired: boolean;
}

export interface PublicShareResponse {
  share: PublicShareInfo;
  file: PublicShareFile;
}

/** 分享子树节点（匿名目录浏览用；path 为相对分享根的 / 连接路径） */
export interface ShareTreeNode {
  id: string;
  name: string;
  kind: FileKind;
  mimeType: string | null;
  extension: string | null;
  sizeBytes: number | null;
  path: string;
  children?: ShareTreeNode[];
}

export interface PublicShareTreeResponse {
  tree: ShareTreeNode;
  totalCount: number;
  totalBytes: number;
}

export interface PublicShareContentResponse {
  token: string;
  fileId: string;
  name: string;
  mimeType: string | null;
  content: string;
  isBinary: boolean;
  truncated: boolean;
}

export interface PublicShareVerifyInput {
  password: string;
}

export interface UploadProgress {
  loaded: number;
  total: number;
  percent: number;
}
