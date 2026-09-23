import { memo, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Droplets,
  Eye,
  Activity,
  Gauge,
  Gift,
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
import { ACTIVITY_LABELS } from '../../utils/activityLabels';
import type {
  ActivityRecord,
  AuthUser,
  BatchAction,
  CreateUserInput,
  UserDetailsResponse,
} from '../../types';
import { errorMessage, formatBytes, formatDate } from '../../utils/format';
import { InvitesPanel } from './InvitesPanel';
import { ActivityAuditPanel } from './ActivityAuditPanel';
import { QuotaManagementPanel } from './QuotaManagementPanel';
import { WatermarkConfigPanel } from './WatermarkConfigPanel';

interface UserManagementDialogProps {
  currentUser: AuthUser;
  onClose: () => void;
}

interface UserPermissionRowProps {
  user: AuthUser;
  currentUser: AuthUser;
  selected: boolean;
  onToggleSelect: (id: string) => void;
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
  { key: 'read', title: '读取', description: '浏览和预览文件' },
  { key: 'upload', title: '上传与创建', description: '上传文件、新建文件夹' },
  { key: 'edit', title: '编辑与删除', description: '重命名、移动、复制和删除' },
];

/** 下载 / Markdown 编辑 / 分享由文件夹级 ACL 控制，不在此处全局设置。 */
const aclNote = '下载、Markdown 编辑与对外分享权限由文件夹级 ACL 控制（管理员可绕过）。';

const UserPermissionRow = memo(function UserPermissionRow({
  user,
  currentUser,
  selected,
  onToggleSelect,
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
  const selectable = !isAdmin && !isSelf;

  return (
    <article className={`user-access-row ${!isEnabled ? 'is-disabled' : ''}`}>
      <header className="user-access-row__identity">
        {selectable ? (
          <label className="user-select-check" title={selected ? '取消选择' : '选择此用户'}>
            <input
              type="checkbox"
              checked={selected}
              onChange={() => onToggleSelect(user.id)}
              aria-label={`选择 ${user.username}`}
            />
          </label>
        ) : null}
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
            title="查看用户详情、统计与操作记录"
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
          {selectable ? (
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
    onSuccess: ({ user }) => onCreated(user),
  });

  const valid = username.trim().length >= 3
    && /^[A-Za-z0-9._-]+$/.test(username)
    && password.length >= 8;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    create.mutate({ username: username.trim(), password, isEnabled, permissions });
  };

  return (
    <Modal title="新建用户" description="为局域网成员开通账号并预设权限。下载、Markdown 编辑与分享由文件夹级 ACL 控制。" onClose={onClose} size="medium">
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

// ----- 删除确认对话框（单个或批量） -----
function DeleteConfirmDialog({ title, description, pending, onClose, onConfirm }: {
  title: string;
  description: string;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal title={title} description={description} onClose={onClose} size="small">
      <div className="user-create-form">
        <div className="user-create-form__footer">
          <button className="button button--secondary" type="button" onClick={onClose}>取消</button>
          <button className="button button--danger" type="button" onClick={onConfirm} disabled={pending}>
            {pending ? <LoaderCircle className="spin" size={17} /> : null}
            {pending ? '删除中…' : '确认删除'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ----- 角色变更确认 -----
function RoleConfirmDialog({ user, targetRole, pending, onClose, onConfirm }: {
  user: AuthUser;
  targetRole: 'admin' | 'user';
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const promote = targetRole === 'admin';
  return (
    <Modal
      title={promote ? '提升为管理员' : '降级为普通用户'}
      description={promote
        ? `确认将 “${user.username}” 提升为管理员？管理员拥有全部文件权限，并可管理所有用户与邀请。`
        : `确认将 “${user.username}” 降级为普通用户？其文件权限将按其当前设置生效。`}
      onClose={onClose}
      size="small"
    >
      <div className="user-create-form">
        <div className="user-create-form__footer">
          <button className="button button--secondary" type="button" onClick={onClose}>取消</button>
          <button className="button button--primary" type="button" onClick={onConfirm} disabled={pending}>
            {pending ? <LoaderCircle className="spin" size={17} /> : null}
            {pending ? '处理中…' : (promote ? '确认提升' : '确认降级')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ----- 用户详情对话框（统计 + 角色 + 活动日志） -----
function UserDetailsDialog({ user, currentUser, onClose }: {
  user: AuthUser;
  currentUser: AuthUser;
  onClose: () => void;
}) {
  const details = useQuery({
    queryKey: ['admin-user-details', user.id],
    queryFn: () => api.getUser(user.id),
  });
  const activity = useQuery({
    queryKey: ['admin-user-activity', user.id],
    queryFn: () => api.getUserActivity(user.id),
  });
  const changeRole = useMutation({
    mutationFn: (role: 'admin' | 'user') => api.changeUserRole(user.id, { role }),
    onSuccess: () => onClose(),
  });
  const [roleConfirm, setRoleConfirm] = useState<'admin' | 'user' | null>(null);

  const d = details.data as UserDetailsResponse | undefined;
  const roleTarget: 'admin' | 'user' | null = user.id !== currentUser.id
    ? (user.role === 'admin' ? 'user' : 'admin')
    : null;

  return (
    <Modal title="用户详情" description={`账号 “${user.username}” 的使用统计与操作记录`} onClose={onClose} size="large">
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

            {roleTarget ? (
              <div className="user-details__role">
                <span>{user.role === 'admin' ? '该账号当前为管理员。' : '该账号当前为普通用户。'}</span>
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => setRoleConfirm(roleTarget)}
                  disabled={changeRole.isPending}
                >
                  <ShieldCheck size={16} />
                  {roleTarget === 'admin' ? '提升为管理员' : '降级为普通用户'}
                </button>
              </div>
            ) : null}

            <h3 className="user-details__heading">操作记录（最近 50 条）</h3>
            {activity.isPending ? (
              <div className="surface-state"><LoaderCircle className="spin" size={20} /><span>正在读取…</span></div>
            ) : activity.isError ? (
              <div className="notice notice--error" role="alert">{errorMessage(activity.error)}</div>
            ) : activity.data && activity.data.activities.length === 0 ? (
              <div className="surface-state surface-state--empty"><span>该用户还没有操作记录。</span></div>
            ) : (
              <ul className="activity-timeline">
                {activity.data?.activities.map((item: ActivityRecord) => (
                  <li key={item.id} className="activity-item">
                    <span className="activity-item__dot" />
                    <div>
                      <strong>{ACTIVITY_LABELS[item.action] ?? item.action}</strong>
                      {item.targetName ? <span> · {item.targetName}</span> : null}
                      {item.detail ? <small>{item.detail}</small> : null}
                    </div>
                    <time>{formatDate(item.createdAt)}</time>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : null}
        <div className="user-create-form__footer">
          <button
            className="button button--secondary"
            type="button"
            onClick={() => { details.refetch(); activity.refetch(); }}
            disabled={details.isFetching}
          >
            <RefreshCw size={15} /> 刷新
          </button>
          <button className="button button--primary" type="button" onClick={onClose}>关闭</button>
        </div>
      </div>

      {roleConfirm ? (
        <RoleConfirmDialog
          user={user}
          targetRole={roleConfirm}
          pending={changeRole.isPending}
          onClose={() => setRoleConfirm(null)}
          onConfirm={() => changeRole.mutate(roleConfirm)}
        />
      ) : null}
    </Modal>
  );
}

// ----- 主对话框 -----
export function UserManagementDialog({ currentUser, onClose }: UserManagementDialogProps) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'users' | 'invites' | 'audit' | 'quota' | 'watermark'>('users');
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
  const batchAction = useMutation({
    mutationFn: ({ ids, action }: { ids: string[]; action: BatchAction }) => api.batchUsers({ ids, action }),
    onSuccess: () => {
      setSelectedIds(new Set());
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
  });

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [roleFilter, setRoleFilter] = useState<'all' | 'admin' | 'user'>('all');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [createOpen, setCreateOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<AuthUser | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AuthUser | null>(null);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
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

  const selectableUsers = useMemo(() => filteredUsers.filter(
    (u) => u.role !== 'admin' && u.id !== currentUser.id,
  ), [filteredUsers, currentUser.id]);
  const allSelected = selectableUsers.length > 0
    && selectableUsers.every((u) => selectedIds.has(u.id));

  const toggleSelect = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleSelectAll = () => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allSelected) {
        selectableUsers.forEach((u) => next.delete(u.id));
        return next;
      }
      selectableUsers.forEach((u) => next.add(u.id));
      return next;
    });
  };
  const runBatch = (action: BatchAction) => {
    if (selectedIds.size === 0) return;
    if (action === 'delete') {
      setBatchDeleteOpen(true);
      return;
    }
    batchAction.mutate({ ids: [...selectedIds], action });
  };

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
        description="管理账号、角色、存储配额与水印配置。全局权限仅读取/上传/编辑；下载、Markdown 编辑与分享由文件夹级 ACL 控制。"
        onClose={onClose}
        size="large"
      >
        <div className="user-management">
          <div className="user-management__tabs" role="tablist" aria-label="管理视图">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'users'}
              className={tab === 'users' ? 'is-active' : ''}
              onClick={() => setTab('users')}
            >
              <UsersRound size={16} /> 用户列表
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'invites'}
              className={tab === 'invites' ? 'is-active' : ''}
              onClick={() => setTab('invites')}
            >
              <Gift size={16} /> 邀请链接
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'audit'}
              className={tab === 'audit' ? 'is-active' : ''}
              onClick={() => setTab('audit')}
            >
              <Activity size={16} /> 活动审计
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'quota'}
              className={tab === 'quota' ? 'is-active' : ''}
              onClick={() => setTab('quota')}
            >
              <Gauge size={16} /> 存储配额
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'watermark'}
              className={tab === 'watermark' ? 'is-active' : ''}
              onClick={() => setTab('watermark')}
            >
              <Droplets size={16} /> 水印设置
            </button>
          </div>

          {tab === 'invites' ? (
            <InvitesPanel currentUser={currentUser} />
          ) : tab === 'audit' ? (
            <ActivityAuditPanel />
          ) : tab === 'quota' ? (
            <QuotaManagementPanel />
          ) : tab === 'watermark' ? (
            <WatermarkConfigPanel />
          ) : (
            <>
              <div className="permission-note">
                <UsersRound size={20} />
                <div><strong>六维权限独立控制</strong><span>读取、下载、上传、编辑、Markdown 编辑和对外分享分别授权；管理员始终拥有全部权限。</span></div>
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

              {selectedIds.size > 0 ? (
                <div className="batch-bar" role="region" aria-label="批量操作">
                  <label className="user-select-check">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      aria-label="全选当前列表"
                    />
                  </label>
                  <span>已选 <strong>{selectedIds.size}</strong> 个账号</span>
                  <button
                    className="button button--secondary"
                    type="button"
                    onClick={() => runBatch('enable')}
                    disabled={batchAction.isPending}
                  >
                    {batchAction.isPending ? <LoaderCircle className="spin" size={15} /> : null}
                    批量启用
                  </button>
                  <button
                    className="button button--secondary"
                    type="button"
                    onClick={() => runBatch('disable')}
                    disabled={batchAction.isPending}
                  >
                    批量停用
                  </button>
                  <button
                    className="button button--danger"
                    type="button"
                    onClick={() => runBatch('delete')}
                    disabled={batchAction.isPending}
                  >
                    <Trash2 size={15} /> 批量删除
                  </button>
                </div>
              ) : (
                <div className="user-management__select-all">
                  <label className="user-select-check">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      disabled={selectableUsers.length === 0}
                      aria-label="全选当前列表"
                    />
                  </label>
                  <span>选择后可批量启用 / 停用 / 删除（管理员与本人不可选）</span>
                </div>
              )}

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
              {batchAction.isError ? (
                <div className="notice notice--error" role="alert">{errorMessage(batchAction.error)}</div>
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
                    selected={selectedIds.has(user.id)}
                    onToggleSelect={toggleSelect}
                    saving={updateAccess.isPending && updateAccess.variables?.id === user.id}
                    onSave={(id, update) => updateAccess.mutate({ id, update })}
                    onReset={(u) => setResetTarget(u)}
                    onDelete={(u) => setDeleteTarget(u)}
                    onViewDetails={(u) => setDetailsTarget(u)}
                  />
                ))}
              </div>
            </>
          )}
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
        <DeleteConfirmDialog
          title="删除用户"
          description={`确认要永久删除用户 “${deleteTarget.username}” 吗？该账号的所有会话将立即失效，此操作不可撤销。`}
          pending={false}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => {
            const targetId = deleteTarget.id;
            api.deleteUser(targetId)
              .then(() => {
                queryClient.setQueryData<{ users: AuthUser[] }>(['admin-users'], (current) => ({
                  users: current?.users.filter((u) => u.id !== targetId) ?? [],
                }));
              })
              .catch(() => undefined);
            setDeleteTarget(null);
          }}
        />
      ) : null}
      {batchDeleteOpen ? (
        <DeleteConfirmDialog
          title="批量删除用户"
          description={`确认永久删除选中的 ${selectedIds.size} 个账号？其所有会话将立即失效，此操作不可撤销。`}
          pending={batchAction.isPending}
          onClose={() => setBatchDeleteOpen(false)}
          onConfirm={() => {
            batchAction.mutate({ ids: [...selectedIds], action: 'delete' });
            setBatchDeleteOpen(false);
          }}
        />
      ) : null}
      {detailsTarget ? (
        <UserDetailsDialog
          user={detailsTarget}
          currentUser={currentUser}
          onClose={() => {
            setDetailsTarget(null);
            void queryClient.invalidateQueries({ queryKey: ['admin-users'] });
          }}
        />
      ) : null}
    </>
  );
}