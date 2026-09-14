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

export interface UploadProgress {
  loaded: number;
  total: number;
  percent: number;
}
