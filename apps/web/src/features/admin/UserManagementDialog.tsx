import { memo, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Eye,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  UserPlus,
  UserRound,
  UsersRound,
} from 'lucide-react';
import { api } from '../../api/client';
import { Modal } from '../../components/Modal';
import type { AuthUser, CreateUserInput, UserDetailsResponse } from '../../types';
import { errorMessage, formatBytes, formatDate } from '../../utils/format';

interface UserManagementDialogProps {
  currentUser: AuthUser;
  onClose: () => void;
}

interface UserPermissionRowProps {
  user: AuthUser;
  currentUser: AuthUser;
  saving: boolean;
  onSave: (id: string, update: { isEnabled: boolean; permissions: AuthUser['permissions'] }) => void;
  onReset: (user: AuthUser) => void;
  onDelete: (user: AuthUser) => void;
  onViewDetails: (user: AuthUser) => void;
}

const permissionLabels: Array<{
  key: keyof AuthUser['permissions'];
  title: string;
  description: string;
}> = [
  { key: 'read', title: '读取与下载', description: '浏览、预览，并下载文件到本地' },
  { key: 'upload', title: '上传与创建', description: '上传文件、新建文件夹' },
  { key: 'edit', title: '编辑与删除', description: '重命名、移动、复制和删除' },
];

const UserPermissionRow = memo(function UserPermissionRow({
  user,
  currentUser,
  saving,
  onSave,
  onReset,
  onDelete,
  onViewDetails,
}: UserPermissionRowProps) {
  const [isEnabled, setIsEnabled] = useState(user.isEnabled);
  const [permissions, setPermissions] = useState(user.permissions);

  useEffect(() => {
    setIsEnabled(user.isEnabled);
    setPermissions(user.permissions);
  }, [user]);

  const isAdmin = user.role === 'admin';
  const isSelf = user.id === currentUser.id;
  const dirty = isEnabled !== user.isEnabled
    || permissionLabels.some(({ key }) => permissions[key] !== user.permissions[key]);

  return (
    <article className={`user-access-row ${!isEnabled ? 'is-disabled' : ''}`}>
      <header className="user-access-row__identity">
        <div className="user-avatar">
          {isAdmin ? <ShieldCheck size={20} /> : <UserRound size={20} />}
        </div>
        <div>
          <strong>{user.username}{isSelf ? '（你）' : ''}</strong>
          <span>
            {isAdmin
              ? '管理员 · 始终拥有全部权限'
              : (user.lastLoginAt
                ? `上次登录 ${formatDate(user.lastLoginAt)}`
                : `尚未登录 · 注册于 ${formatDate(user.createdAt)}`)}
          </span>
        </div>
        <label className="account-toggle">
          <input
            type="checkbox"
            checked={isEnabled}
            onChange={(event) => setIsEnabled(event.target.checked)}
            disabled={isAdmin || saving}
          />
          <span>{isEnabled ? '账号启用' : '账号停用'}</span>
        </label>
      </header>

      <div className="permission-options">
        {permissionLabels.map(({ key, title, description }) => (
          <label className="permission-option" key={key}>
            <input
              type="checkbox"
              checked={permissions[key]}
              onChange={(event) => setPermissions((current) => {
                if (key === 'read' && !event.target.checked) {
                  return { read: false, upload: false, edit: false };
                }
                return {
                  ...current,
                  read: key === 'read' ? event.target.checked : (event.target.checked || current.read),
                  [key]: event.target.checked,
                };
              })}
              disabled={isAdmin || !isEnabled || saving}
            />
            <span><strong>{title}</strong><small>{description}</small></span>
          </label>
        ))}
      </div>

      <footer className="user-access-row__footer">
        <div className="user-access-row__actions">
          <button
            className="icon-button"
            type="button"
            onClick={() => onViewDetails(user)}
            disabled={saving}
            title="查看用户详情与统计"
            aria-label="查看详情"
          >
            <Eye size={17} />
          </button>
          {!isAdmin ? (
            <button
              className="icon-button"
              type="button"
              onClick={() => onReset(user)}
              disabled={saving}
              title="重置密码"
              aria-label="重置密码"
            >
              <KeyRound size={17} />
            </button>
          ) : null}
          {!isAdmin && !isSelf ? (
            <button
              className="icon-button icon-button--danger"
              type="button"
              onClick={() => onDelete(user)}
              disabled={saving}
              title="删除用户"
              aria-label="删除用户"
            >
              <Trash2 size={17} />
            </button>
          ) : null}
        </div>
        <div className="user-access-row__save">
          {!isAdmin && !isEnabled ? (
            <span>停用后，该用户的已登录会话会立即失效。</span>
          ) : (
            <span />
          )}
          {!isAdmin ? (
            <button
              className="button button--primary"
              type="button"
              disabled={!dirty || saving}
              onClick={() => onSave(user.id, { isEnabled, permissions })}
            >
              {saving ? <LoaderCircle className="spin" size={17} /> : null}
              {saving ? '保存中…' : '保存设置'}
            </button>
          ) : null}
        </div>
      </footer>
    </article>
  );
});

// ----- 创建用户对话框 -----
function CreateUserDialog({ onClose, onCreated }: {
  onClose: () => void;
  onCreated: (user: AuthUser) => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isEnabled, setIsEnabled] = useState(true);
  const [permissions, setPermissions] = useState<AuthUser['permissions']>({
    read: true, upload: true, edit: true,
  });

  const create = useMutation({
    mutationFn: (input: CreateUserInput) => api.createUser(input),
    onSuccess: ({ user }) => {
      onCreated(user);
    },
  });

  const valid = username.trim().length >= 3
    && /^[A-Za-z0-9._-]+$/.test(username)
    && password.length >= 8;
  const passwordsStrong = password.length >= 8;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    create.mutate({ username: username.trim(), password, isEnabled, permissions });
  };

  return (
    <Modal title="新建用户" description="为局域网成员开通账号并预设权限。" onClose={onClose} size="medium">
      <form className="user-create-form" onSubmit={submit}>
        {create.isError ? (
          <div className="notice notice--error" role="alert">{errorMessage(create.error)}</div>
        ) : null}
        <label className="field">
          <span>账号</span>
          <input
            name="username"
            autoComplete="off"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="3–50 个字符，仅支持字母数字和 _.-"
            minLength={3}
            maxLength={50}
            required
            autoFocus
          />
        </label>
        <label className="field">
          <span>初始密码</span>
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="至少 8 个字符"
            minLength={8}
            required
          />
          {password && !passwordsStrong ? <small className="field-error">至少 8 个字符</small> : null}
        </label>
        <label className="account-toggle">
          <input
            type="checkbox"
            checked={isEnabled}
            onChange={(event) => setIsEnabled(event.target.checked)}
          />
          <span>{isEnabled ? '账号创建后立即启用' : '账号创建后保持停用'}</span>
        </label>
        <fieldset className="create-permissions">
          <legend>初始权限</legend>
          {permissionLabels.map(({ key, title, description }) => (
            <label className="permission-option" key={key}>
              <input
                type="checkbox"
                checked={permissions[key]}
                onChange={(event) => setPermissions((current) => {
                  if (key === 'read' && !event.target.checked) {
                    return { read: false, upload: false, edit: false };
                  }
                  return {
                    ...current,
                    read: key === 'read' ? event.target.checked : (event.target.checked || current.read),
                    [key]: event.target.checked,
                  };
                })}
              />
              <span><strong>{title}</strong><small>{description}</small></span>
            </label>
          ))}
        </fieldset>
        <div className="user-create-form__footer">
          <button className="button button--secondary" type="button" onClick={onClose}>取消</button>
          <button className="button button--primary" type="submit" disabled={!valid || create.isPending}>
            {create.isPending ? <LoaderCircle className="spin" size={17} /> : null}
            {create.isPending ? '创建中…' : '创建用户'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ----- 重置密码对话框 -----
function ResetPasswordDialog({ user, onClose, onDone }: {
  user: AuthUser;
  onClose: () => void;
  onDone: () => void;
}) {
  const [newPassword, setNewPassword] = useState('');
  const reset = useMutation({
    mutationFn: () => api.resetUserPassword(user.id, { newPassword }),
    onSuccess: () => onDone(),
  });

  const valid = newPassword.length >= 8;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) reset.mutate();
  };

  return (
    <Modal title="重置密码" description={`为用户 “${user.username}” 设置新密码。其所有会话将立即失效。`} onClose={onClose} size="small">
      <form className="user-create-form" onSubmit={submit}>
        {reset.isError ? (
          <div className="notice notice--error" role="alert">{errorMessage(reset.error)}</div>
        ) : null}
        <label className="field">
          <span>新密码</span>
          <input
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            placeholder="至少 8 个字符"
            minLength={8}
            required
            autoFocus
          />
        </label>
        <div className="user-create-form__footer">
          <button className="button button--secondary" type="button" onClick={onClose}>取消</button>
          <button className="button button--primary" type="submit" disabled={!valid || reset.isPending}>
            {reset.isPending ? <LoaderCircle className="spin" size={17} /> : null}
            {reset.isPending ? '重置中…' : '重置密码'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ----- 删除确认对话框 -----
function DeleteUserDialog({ user, onClose, onDone }: {
  user: AuthUser;
  onClose: () => void;
  onDone: () => void;
}) {
  const remove = useMutation({
    mutationFn: () => api.deleteUser(user.id),
    onSuccess: () => onDone(),
  });
  return (
    <Modal title="删除用户" description={`确认要永久删除用户 “${user.username}” 吗？该账号的所有会话将立即失效，此操作不可撤销。`} onClose={onClose} size="small">
      <div className="user-create-form">
        {remove.isError ? (
          <div className="notice notice--error" role="alert">{errorMessage(remove.error)}</div>
        ) : null}
        <div className="user-create-form__footer">
          <button className="button button--secondary" type="button" onClick={onClose}>取消</button>
          <button className="button button--danger" type="button" onClick={() => remove.mutate()} disabled={remove.isPending}>
            {remove.isPending ? <LoaderCircle className="spin" size={17} /> : null}
            {remove.isPending ? '删除中…' : '确认删除'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ----- 用户详情对话框 -----
function UserDetailsDialog({ userId, username, onClose }: {
  userId: string;
  username: string;
  onClose: () => void;
}) {
  const details = useQuery({
    queryKey: ['admin-user-details', userId],
    queryFn: () => api.getUser(userId),
    enabled: Boolean(userId),
  });
  const d = details.data as UserDetailsResponse | undefined;
  return (
    <Modal title="用户详情" description={`账号 “${username}” 的使用统计`} onClose={onClose} size="medium">
      <div className="user-details">
        {details.isPending ? (
          <div className="surface-state"><LoaderCircle className="spin" size={24} /><span>正在读取…</span></div>
        ) : details.isError ? (
          <div className="notice notice--error" role="alert">{errorMessage(details.error)}</div>
        ) : d ? (
          <>
            <dl className="user-details__list">
              <div><dt>账号</dt><dd>{d.user.username}</dd></div>
              <div><dt>角色</dt><dd>{d.user.role === 'admin' ? '管理员' : '普通用户'}</dd></div>
              <div><dt>账号状态</dt><dd>{d.user.isEnabled ? '启用' : '停用'}</dd></div>
              <div><dt>注册时间</dt><dd>{formatDate(d.user.createdAt)}</dd></div>
              <div>
                <dt>最后登录</dt>
                <dd>{d.user.lastLoginAt ? formatDate(d.user.lastLoginAt) : '尚未登录'}</dd>
              </div>
              <div><dt>活跃会话</dt><dd>{d.stats.activeSessionCount} 个</dd></div>
            </dl>
            <h3 className="user-details__heading">文件库统计（全站共享）</h3>
            <dl className="user-details__list">
              <div><dt>项目总数</dt><dd>{d.stats.globalFileCount} 个</dd></div>
              <div><dt>占用空间</dt><dd>{formatBytes(d.stats.globalTotalBytes)}</dd></div>
            </dl>
            <p className="user-details__note">本站所有文件对登录用户可见，因此文件与占用统计为全站数据。</p>
          </>
        ) : null}
        <div className="user-create-form__footer">
          <button className="button button--secondary" type="button" onClick={() => details.refetch()} disabled={details.isFetching}>
            <RefreshCw size={15} /> 刷新
          </button>
          <button className="button button--primary" type="button" onClick={onClose}>关闭</button>
        </div>
      </div>
    </Modal>
  );
}

// ----- 主对话框 -----
export function UserManagementDialog({ currentUser, onClose }: UserManagementDialogProps) {
  const queryClient = useQueryClient();
  const users = useQuery({
    queryKey: ['admin-users'],
    queryFn: api.listUsers,
  });
  const updateAccess = useMutation({
    mutationFn: ({ id, update }: { id: string; update: { isEnabled: boolean; permissions: AuthUser['permissions'] } }) =>
      api.updateUserAccess(id, update),
    onSuccess: ({ user }) => {
      queryClient.setQueryData<{ users: AuthUser[] }>(['admin-users'], (current) => ({
        users: current?.users.map((item) => item.id === user.id ? user : item) ?? [user],
      }));
    },
  });

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [roleFilter, setRoleFilter] = useState<'all' | 'admin' | 'user'>('all');

  const [createOpen, setCreateOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<AuthUser | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AuthUser | null>(null);
  const [detailsTarget, setDetailsTarget] = useState<AuthUser | null>(null);

  const filteredUsers = useMemo(() => {
    if (!users.data) return [] as AuthUser[];
    const q = search.trim().toLowerCase();
    return users.data.users.filter((u) => {
      if (q && !u.username.toLowerCase().includes(q)) return false;
      if (statusFilter === 'enabled' && !u.isEnabled) return false;
      if (statusFilter === 'disabled' && u.isEnabled) return false;
      if (roleFilter !== 'all' && u.role !== roleFilter) return false;
      return true;
    });
  }, [users.data, search, statusFilter, roleFilter]);

  const counters = useMemo(() => {
    const list = users.data?.users ?? [];
    return {
      total: list.length,
      enabled: list.filter((u) => u.isEnabled).length,
      disabled: list.filter((u) => !u.isEnabled).length,
    };
  }, [users.data]);

  return (
    <>
      <Modal
        title="用户与权限"
        description="普通用户注册后默认无文件权限，由管理员在此授权。可新建用户、重置密码或删除账号。"
        onClose={onClose}
        size="large"
      >
        <div className="user-management">
          <div className="permission-note">
            <UsersRound size={20} />
            <div><strong>读取权限包含下载</strong><span>获得读取权限的用户可将文件下载到自己的设备；上传和编辑会自动开启读取权限。</span></div>
          </div>

          <div className="user-management__toolbar">
            <label className="search-field">
              <Search size={16} />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="按账号搜索"
                aria-label="按账号搜索"
              />
            </label>
            <select
              className="select-field"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
              aria-label="按状态筛选"
            >
              <option value="all">全部状态（{counters.total}）</option>
              <option value="enabled">已启用（{counters.enabled}）</option>
              <option value="disabled">已停用（{counters.disabled}）</option>
            </select>
            <select
              className="select-field"
              value={roleFilter}
              onChange={(event) => setRoleFilter(event.target.value as typeof roleFilter)}
              aria-label="按角色筛选"
            >
              <option value="all">全部角色</option>
              <option value="admin">仅管理员</option>
              <option value="user">仅普通用户</option>
            </select>
            <button className="button button--primary" type="button" onClick={() => setCreateOpen(true)}>
              <UserPlus size={17} /> 新建用户
            </button>
          </div>

          {users.isPending ? (
            <div className="surface-state user-management__state"><LoaderCircle className="spin" size={25} /><span>正在读取用户…</span></div>
          ) : null}
          {users.isError ? (
            <div className="notice notice--error" role="alert">
              <span>{errorMessage(users.error)}</span>
              <button className="button button--secondary" type="button" onClick={() => users.refetch()}>重试</button>
            </div>
          ) : null}
          {updateAccess.isError ? (
            <div className="notice notice--error" role="alert">{errorMessage(updateAccess.error)}</div>
          ) : null}

          {users.data && filteredUsers.length === 0 ? (
            <div className="surface-state surface-state--empty">
              <strong>{users.data.users.length === 0 ? '当前还没有任何账号' : '没有匹配的用户'}</strong>
              <span>{users.data.users.length === 0 ? '点击“新建用户”添加第一个账号。' : '调整搜索条件或筛选器后再试。'}</span>
            </div>
          ) : null}

          <div className="user-access-list">
            {filteredUsers.map((user) => (
              <UserPermissionRow
                key={user.id}
                user={user}
                currentUser={currentUser}
                saving={updateAccess.isPending && updateAccess.variables?.id === user.id}
                onSave={(id, update) => updateAccess.mutate({ id, update })}
                onReset={(u) => setResetTarget(u)}
                onDelete={(u) => setDeleteTarget(u)}
                onViewDetails={(u) => setDetailsTarget(u)}
              />
            ))}
          </div>
        </div>
      </Modal>

      {createOpen ? (
        <CreateUserDialog
          onClose={() => setCreateOpen(false)}
          onCreated={(user) => {
            setCreateOpen(false);
            queryClient.setQueryData<{ users: AuthUser[] }>(['admin-users'], (current) => ({
              users: current ? [user, ...current.users.filter((u) => u.id !== user.id)] : [user],
            }));
          }}
        />
      ) : null}
      {resetTarget ? (
        <ResetPasswordDialog
          user={resetTarget}
          onClose={() => setResetTarget(null)}
          onDone={() => setResetTarget(null)}
        />
      ) : null}
      {deleteTarget ? (
        <DeleteUserDialog
          user={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDone={() => {
            const targetId = deleteTarget.id;
            queryClient.setQueryData<{ users: AuthUser[] }>(['admin-users'], (current) => ({
              users: current?.users.filter((u) => u.id !== targetId) ?? [],
            }));
            setDeleteTarget(null);
          }}
        />
      ) : null}
      {detailsTarget ? (
        <UserDetailsDialog
          userId={detailsTarget.id}
          username={detailsTarget.username}
          onClose={() => setDetailsTarget(null)}
        />
      ) : null}
    </>
  );
}