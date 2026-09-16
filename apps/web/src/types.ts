export type FileKind = 'file' | 'folder';
export type FileType = 'folder' | 'image' | 'audio' | 'video' | 'document' | 'other';
export type SortField = 'name' | 'size' | 'createdAt' | 'updatedAt';
export type SortOrder = 'asc' | 'desc';

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
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface FileListResponse {
  items: FileRecord[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    hasNext: boolean;
  };
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

export interface AuthUser {
  id: string;
  username: string;
  role: 'admin' | 'user';
  isEnabled: boolean;
  permissions: {
    read: boolean;
    upload: boolean;
    edit: boolean;
  };
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
  permissions: {
    read: boolean;
    upload: boolean;
    edit: boolean;
  };
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
  action: string;
  targetType: string | null;
  targetName: string | null;
  detail: string | null;
  createdAt: string;
}

export interface UserActivityResponse {
  activities: ActivityRecord[];
}

export interface UploadProgress {
  loaded: number;
  total: number;
  percent: number;
}
