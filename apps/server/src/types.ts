export type FileKind = 'file' | 'folder';

export type FileType = 'folder' | 'image' | 'audio' | 'video' | 'document' | 'other';

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

export interface ListFilesQuery {
  parentId?: string;
  q?: string;
  type?: 'folder' | 'image' | 'audio' | 'video' | 'document' | 'other';
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
  storageQuotaBytes: number;
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
