import type {
  BatchUsersInput,
  BatchUsersResult,
  ChangePasswordInput,
  CreateUserInput,
  FileListParams,
  FileListResponse,
  FileRecord,
  Invite,
  InviteCreateInput,
  InvitesResponse,
  ResetPasswordInput,
  RoleChangeInput,
  SessionResponse,
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
