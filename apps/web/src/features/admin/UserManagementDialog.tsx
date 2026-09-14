import { memo, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, ShieldCheck, UserRound, UsersRound } from 'lucide-react';
import { api } from '../../api/client';
import { Modal } from '../../components/Modal';
import type { AuthUser, UserAccessUpdate, UsersResponse } from '../../types';
import { errorMessage, formatDate } from '../../utils/format';

interface UserManagementDialogProps {
  onClose: () => void;
}

interface UserPermissionRowProps {
  user: AuthUser;
  saving: boolean;
  onSave: (id: string, update: UserAccessUpdate) => void;
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
  saving,
  onSave,
}: UserPermissionRowProps) {
  const [isEnabled, setIsEnabled] = useState(user.isEnabled);
  const [permissions, setPermissions] = useState(user.permissions);

  useEffect(() => {
    setIsEnabled(user.isEnabled);
    setPermissions(user.permissions);
  }, [user]);

  const isAdmin = user.role === 'admin';
  const dirty = isEnabled !== user.isEnabled
    || permissionLabels.some(({ key }) => permissions[key] !== user.permissions[key]);

  return (
    <article className={`user-access-row ${!isEnabled ? 'is-disabled' : ''}`}>
      <header className="user-access-row__identity">
        <div className="user-avatar">
          {isAdmin ? <ShieldCheck size={20} /> : <UserRound size={20} />}
        </div>
        <div>
          <strong>{user.username}</strong>
          <span>{isAdmin ? '管理员 · 始终拥有全部权限' : `注册于 ${formatDate(user.createdAt)}`}</span>
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

      {!isAdmin ? (
        <footer className="user-access-row__footer">
          {!isEnabled ? <span>停用后，该用户的已登录会话会立即失效。</span> : <span />}
          <button
            className="button button--primary"
            type="button"
            disabled={!dirty || saving}
            onClick={() => onSave(user.id, { isEnabled, permissions })}
          >
            {saving ? <LoaderCircle className="spin" size={17} /> : null}
            {saving ? '保存中…' : '保存设置'}
          </button>
        </footer>
      ) : null}
    </article>
  );
});

export function UserManagementDialog({ onClose }: UserManagementDialogProps) {
  const queryClient = useQueryClient();
  const users = useQuery({
    queryKey: ['admin-users'],
    queryFn: api.listUsers,
  });
  const updateAccess = useMutation({
    mutationFn: ({ id, update }: { id: string; update: UserAccessUpdate }) => api.updateUserAccess(id, update),
    onSuccess: ({ user }) => {
      queryClient.setQueryData<UsersResponse>(['admin-users'], (current) => ({
        users: current?.users.map((item) => item.id === user.id ? user : item) ?? [user],
      }));
    },
  });

  return (
    <Modal
      title="用户与权限"
      description="普通用户注册后默认无文件权限，由管理员在此授权。"
      onClose={onClose}
      size="large"
    >
      <div className="user-management">
        <div className="permission-note">
          <UsersRound size={20} />
          <div><strong>读取权限包含下载</strong><span>获得读取权限的用户可将文件下载到自己的设备；上传和编辑会自动开启读取权限。</span></div>
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

        <div className="user-access-list">
          {users.data?.users.map((user) => (
            <UserPermissionRow
              key={user.id}
              user={user}
              saving={updateAccess.isPending && updateAccess.variables?.id === user.id}
              onSave={(id, update) => updateAccess.mutate({ id, update })}
            />
          ))}
        </div>
      </div>
    </Modal>
  );
}
