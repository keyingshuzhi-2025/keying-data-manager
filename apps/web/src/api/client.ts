import type {
  ActivityExportResponse,
  ActivityListParams,
  ActivityListResponse,
  BatchUsersInput,
  BatchUsersResult,
  ChangePasswordInput,
  CreateShareLinkInput,
  CreateShareLinkResponse,
  CreateUserInput,
  FileContentResponse,
  FileContentUpdateInput,
  FileListParams,
  FileListResponse,
  FilePreviewResponse,
  FileRecord,
  FolderAclResponse,
  FolderAclUpdateInput,
  Invite,
  InviteCreateInput,
  InvitesResponse,
  PublicShareContentResponse,
  PublicShareResponse,
  PublicShareTreeResponse,
  PublicShareVerifyInput,
  QuotaUpdateInput,
  ResetPasswordInput,
  RoleChangeInput,
  SessionResponse,
  ShareLinkResponse,
  ShareLinksParams,
  ShareLinksResponse,
  ShareLinkUpdateInput,
  UploadProgress,
  UserAccessUpdate,
  UserActivityResponse,
  UserDetailsResponse,
  UsersResponse,
} from '../types';

interface ErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code = 'REQUEST_FAILED',
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: 'same-origin',
  });
  const body = response.status === 204
    ? undefined
    : await response.json().catch(() => undefined) as T | ErrorBody | undefined;

  if (!response.ok) {
    const error = (body as ErrorBody | undefined)?.error;
    throw new ApiError(
      error?.message ?? `请求失败（${response.status}）`,
      response.status,
      error?.code,
      error?.details,
    );
  }
  return body as T;
}

function queryString(params: FileListParams): string {
  const search = new URLSearchParams();
  if (params.parentId) search.set('parentId', params.parentId);
  if (params.q) search.set('q', params.q);
  if (params.type) search.set('type', params.type);
  if (params.sort) search.set('sort', params.sort);
  if (params.order) search.set('order', params.order);
  if (params.page) search.set('page', String(params.page));
  if (params.limit) search.set('limit', String(params.limit));
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

function encodeQuery<T extends object>(params: T): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

export const api = {
  session: () => request<SessionResponse>('/api/auth/session'),
  login: (username: string, password: string) => request<SessionResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  }),
  register: (username: string, password: string, inviteCode?: string) => request<SessionResponse>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(inviteCode ? { username, password, inviteCode } : { username, password }),
  }),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  listUsers: () => request<UsersResponse>('/api/admin/users'),
  createUser: (input: CreateUserInput) => request<{ user: UsersResponse['users'][number] }>(
    '/api/admin/users',
    { method: 'POST', body: JSON.stringify(input) },
  ),
  getUser: (id: string) => request<UserDetailsResponse>(`/api/admin/users/${id}`),
  getUserActivity: (id: string) => request<UserActivityResponse>(`/api/admin/users/${id}/activity`),
  deleteUser: (id: string) => request<{ ok: boolean }>(`/api/admin/users/${id}`, { method: 'DELETE' }),
  resetUserPassword: (id: string, input: ResetPasswordInput) => request<{ ok: boolean }>(
    `/api/admin/users/${id}/reset-password`,
    { method: 'POST', body: JSON.stringify(input) },
  ),
  updateUserAccess: (id: string, update: UserAccessUpdate) => request<{ user: UsersResponse['users'][number] }>(
    `/api/admin/users/${id}`,
    { method: 'PATCH', body: JSON.stringify(update) },
  ),
  batchUsers: (input: BatchUsersInput) => request<BatchUsersResult>(
    '/api/admin/users/batch',
    { method: 'POST', body: JSON.stringify(input) },
  ),
  changeUserRole: (id: string, input: RoleChangeInput) => request<{ user: UsersResponse['users'][number] }>(
    `/api/admin/users/${id}/role`,
    { method: 'PATCH', body: JSON.stringify(input) },
  ),
  createInvite: (input: InviteCreateInput) => request<{ invite: Invite }>(
    '/api/admin/invites',
    { method: 'POST', body: JSON.stringify(input) },
  ),
  listInvites: () => request<InvitesResponse>('/api/admin/invites'),
  revokeInvite: (id: string) => request<{ ok: boolean }>(
    `/api/admin/invites/${id}`,
    { method: 'DELETE' },
  ),
  changeOwnPassword: (input: ChangePasswordInput) => request<{ ok: boolean }>(
    '/api/auth/password',
    { method: 'POST', body: JSON.stringify(input) },
  ),
  listFiles: (params: FileListParams) => request<FileListResponse>(`/api/files${queryString(params)}`),
  getFile: (id: string) => request<{ file: FileRecord }>(`/api/files/${id}`),
  getPath: (id: string) => request<{ path: FileRecord[] }>(`/api/files/${id}/path`),
  createFolder: (name: string, parentId: string | null) => request<{ file: FileRecord }>('/api/files', {
    method: 'POST',
    body: JSON.stringify({ name, parentId, kind: 'folder' }),
  }),
  updateFile: (id: string, patch: { name?: string; parentId?: string | null }) => request<{ file: FileRecord }>(
    `/api/files/${id}`,
    { method: 'PATCH', body: JSON.stringify(patch) },
  ),
  moveFile: (id: string, parentId: string | null) => request<{ file: FileRecord }>(
    `/api/files/${id}/move`,
    { method: 'POST', body: JSON.stringify({ parentId }) },
  ),
  copyFile: (id: string, parentId: string | null, name?: string) => request<{ file: FileRecord }>(
    `/api/files/${id}/copy`,
    { method: 'POST', body: JSON.stringify({ parentId, name }) },
  ),
  deleteFile: (id: string) => request<{ ok: boolean }>(`/api/files/${id}`, { method: 'DELETE' }),

  // ----- 文件夹级权限（六维 ACL，docs/v0.1.2-plan.md §5.4） -----
  getFolderPermissions: (folderId: string) =>
    request<FolderAclResponse>(`/api/admin/permissions${encodeQuery({ folderId })}`),
  updateFolderPermissions: (input: FolderAclUpdateInput) => request<FolderAclResponse>(
    '/api/admin/permissions',
    { method: 'PUT', body: JSON.stringify(input) },
  ),

  // ----- 公开分享链接（docs/v0.1.2-plan.md §4.3；服务端 routes/shares.ts） -----
  createShareLink: (input: CreateShareLinkInput) => request<CreateShareLinkResponse>('/api/share-links', {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  listShareLinks: (params: ShareLinksParams = {}) =>
    request<ShareLinksResponse>(`/api/share-links${encodeQuery(params)}`),
  getShareLink: (id: string) => request<ShareLinkResponse>(`/api/share-links/${id}`),
  updateShareLink: (id: string, input: ShareLinkUpdateInput) => request<ShareLinkResponse>(
    `/api/share-links/${id}`,
    { method: 'PATCH', body: JSON.stringify(input) },
  ),
  revokeShareLink: (id: string) => request<ShareLinkResponse>(
    `/api/share-links/${id}/revoke`,
    { method: 'POST' },
  ),
  deleteShareLink: (id: string) => request<{ ok: boolean }>(`/api/share-links/${id}`, { method: 'DELETE' }),

  // ----- 存储配额（docs/v0.1.2-plan.md §8：PATCH /api/admin/users/:id 扩展 storage_quota_bytes） -----
  updateUserQuota: (id: string, input: QuotaUpdateInput) =>
    request<{ user: UsersResponse['users'][number] }>(
      `/api/admin/users/${id}`,
      { method: 'PATCH', body: JSON.stringify(input) },
    ),

  // ----- 活动审计（全站，docs/v0.1.2-plan.md §8） -----
  listActivity: (params: ActivityListParams = {}) =>
    request<ActivityListResponse>(`/api/admin/activity${encodeQuery(params)}`),
  exportActivityCsv: (params: ActivityListParams = {}) =>
    request<string>(`/api/admin/activity/export${encodeQuery(params)}`),

  // ----- 文件内容 / 预览 / 导出（docs/v0.1.2-plan.md §6–§7） -----
  getFileContent: (id: string) => request<FileContentResponse>(`/api/files/${id}/content`),
  updateFileContent: (id: string, input: FileContentUpdateInput) => request<{ file: FileRecord }>(
    `/api/files/${id}/content`,
    { method: 'PUT', body: JSON.stringify(input) },
  ),
  previewFile: (id: string) => request<FilePreviewResponse>(`/api/files/${id}/preview`),

  // ----- 公开分享（匿名访问，docs/v0.1.2-plan.md §4.3–4.4） -----
  getPublicShareInfo: (token: string) => request<PublicShareResponse>(`/api/public/shares/${token}/info`),
  getPublicShareTree: (token: string) =>
    request<PublicShareTreeResponse>(`/api/public/shares/${token}/tree`),
  getPublicShareContent: (token: string, fileId: string) =>
    request<PublicShareContentResponse>(`/api/public/shares/${token}/files/${fileId}/content`),
  verifyPublicSharePassword: (token: string, input: PublicShareVerifyInput) =>
    request<{ ok: boolean }>(`/api/public/shares/${token}/verify`, { method: 'POST', body: JSON.stringify(input) }),
};

export function uploadFile(
  file: File,
  parentId: string | null,
  onProgress: (progress: UploadProgress) => void,
): Promise<FileRecord> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    if (parentId) form.append('parentId', parentId);
    form.append('file', file, file.name);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/uploads');
    xhr.withCredentials = true;
    xhr.upload.addEventListener('progress', (event) => {
      const total = event.lengthComputable ? event.total : file.size;
      onProgress({
        loaded: event.loaded,
        total,
        percent: total > 0 ? Math.round((event.loaded / total) * 100) : 0,
      });
    });
    xhr.addEventListener('error', () => reject(new ApiError('网络连接失败，请稍后重试', 0, 'NETWORK_ERROR')));
    xhr.addEventListener('abort', () => reject(new ApiError('上传已取消', 0, 'UPLOAD_ABORTED')));
    xhr.addEventListener('load', () => {
      let body: { file?: FileRecord; error?: { code?: string; message?: string; details?: unknown } } = {};
      try {
        body = JSON.parse(xhr.responseText) as typeof body;
      } catch {
        // The status and generic message below still communicate the failure.
      }
      if (xhr.status >= 200 && xhr.status < 300 && body.file) {
        resolve(body.file);
        return;
      }
      reject(new ApiError(
        body.error?.message ?? `上传失败（${xhr.status || '网络错误'}）`,
        xhr.status,
        body.error?.code,
        body.error?.details,
      ));
    });
    xhr.send(form);
  });
}

// ----- 二进制下载 / 流式 / 导出端点（返回文件流而非 JSON，直接提供 URL 供链接或 window.open 使用） -----
export function fileDownloadUrl(id: string): string {
  return `/api/files/${id}/download`;
}

export function fileStreamUrl(id: string): string {
  return `/api/files/${id}/stream`;
}

/** MD → PDF 导出（docs/v0.1.2-plan.md §6.3：GET /api/files/:id/export-pdf，需 read+download） */
export function fileExportPdfUrl(id: string): string {
  return `/api/files/${id}/export-pdf`;
}

export function publicShareDownloadUrl(token: string): string {
  return `/api/public/shares/${token}/download`;
}

export function publicShareStreamUrl(token: string): string {
  return `/api/public/shares/${token}/stream`;
}
