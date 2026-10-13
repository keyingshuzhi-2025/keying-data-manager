import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderLock, LoaderCircle, RotateCcw, Save, ShieldCheck } from 'lucide-react';
import { api } from '../../api/client';
import { Modal } from '../../components/Modal';
import { Toast, type ToastMessage } from '../../components/Toast';
import type { FileRecord, ItemAclInfo, PermissionSet } from '../../types';
import { errorMessage } from '../../utils/format';
import { PermissionGrid, permissionSummaryText } from '../common/PermissionCard';
import { PermissionChainViewer } from '../admin/PermissionChainViewer';

const permissionLabels: Array<{
  key: keyof PermissionSet;
  title: string;
  description: string;
}> = [
  { key: 'read', title: '读取', description: '查看目录和文件元数据' },
  { key: 'download', title: '下载', description: '获取文件原始内容' },
  { key: 'upload', title: '上传与创建', description: '在当前目录上传或新建文件夹' },
  { key: 'edit', title: '编辑与删除', description: '重命名、移动、复制和删除' },
  { key: 'editMd', title: 'Markdown 编辑', description: '在线修改 Markdown 文件' },
  { key: 'share', title: '对外分享', description: '为当前目录或文件创建分享链接' },
];

export function ItemPermissionsDialog({
  item,
  canViewChain,
  onClose,
}: {
  item: FileRecord;
  canViewChain: boolean;
  onClose: () => void;
}) {
  const itemId = item.id;
  const queryClient = useQueryClient();
  const [showPermissionChain, setShowPermissionChain] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const aclUsers = useQuery({ queryKey: ['acl-users'], queryFn: api.listAclUsers });
  const [selectedUserId, setSelectedUserId] = useState('');
  useEffect(() => {
    if (!aclUsers.data?.users.length) {
      setSelectedUserId('');
      return;
    }
    if (!aclUsers.data.users.some((user) => user.id === selectedUserId)) {
      setSelectedUserId(aclUsers.data.users[0].id);
    }
  }, [aclUsers.data, selectedUserId]);
  const query = useQuery({
    queryKey: ['item-permissions', itemId, selectedUserId],
    queryFn: () => api.getItemPermissions(itemId, selectedUserId),
    enabled: Boolean(selectedUserId),
  });
  const update = useMutation({
    mutationFn: (permissions: PermissionSet) => api.updateItemPermissions({ itemId, userId: selectedUserId, permissions }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['item-permissions'] });
      void queryClient.invalidateQueries({ queryKey: ['effective-permissions'] });
      void queryClient.invalidateQueries({ queryKey: ['effective-file-permissions'] });
      void queryClient.invalidateQueries({ queryKey: ['permission-chain'] });
      void queryClient.invalidateQueries({ queryKey: ['permissions-all'] });
      void queryClient.invalidateQueries({ queryKey: ['permissions-health'] });
      void queryClient.invalidateQueries({ queryKey: ['files'] });
      void queryClient.invalidateQueries({ queryKey: ['path'] });
      setToast({ id: Date.now(), text: '条目权限已更新', tone: 'success' });
    },
    onError: (error) => setToast({ id: Date.now(), text: errorMessage(error), tone: 'error' }),
  });
  const inherit = useMutation({
    mutationFn: () => api.updateItemPermissions({ itemId, userId: selectedUserId, inheritParent: true }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['item-permissions'] });
      void queryClient.invalidateQueries({ queryKey: ['effective-permissions'] });
      void queryClient.invalidateQueries({ queryKey: ['effective-file-permissions'] });
      void queryClient.invalidateQueries({ queryKey: ['permission-chain'] });
      void queryClient.invalidateQueries({ queryKey: ['permissions-all'] });
      void queryClient.invalidateQueries({ queryKey: ['permissions-health'] });
      void queryClient.invalidateQueries({ queryKey: ['files'] });
      setToast({ id: Date.now(), text: '已恢复继承上级权限', tone: 'success' });
    },
    onError: (error) => setToast({ id: Date.now(), text: errorMessage(error), tone: 'error' }),
  });

  const acl = query.data?.acl;
  const [permissions, setPermissions] = useState<PermissionSet | null>(null);
  useEffect(() => {
    if (acl?.permissions) {
      setPermissions({ ...acl.permissions });
    } else if (acl?.effective) {
      setPermissions({ ...acl.effective });
    }
  }, [acl?.permissions, acl?.effective]);

  const effective = useMemo<PermissionSet | undefined>(() => acl?.effective, [acl?.effective]);
  const effectiveForDirty = acl?.permissions ?? acl?.effective;
  const dirty = Boolean(permissions && effectiveForDirty && permissionLabels.some(({ key }) => permissions[key] !== effectiveForDirty[key]));
  const busy = update.isPending || inherit.isPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!permissions || !dirty || busy) return;
    update.mutate(permissions);
  };

  return (
    <Modal
      title={item.kind === 'folder' ? '文件夹权限' : '文件权限'}
      description={`正在配置“${item.name}”。${item.kind === 'folder' ? '子项默认继承本文件夹策略。' : '这项设置只作用于当前文件。'}`}
      onClose={onClose}
      size="medium"
    >
      {query.isPending && selectedUserId ? (
        <div className="surface-state"><LoaderCircle className="spin" size={24} /><span>正在读取权限…</span></div>
      ) : null}
      {aclUsers.isError ? <div className="notice notice--error" role="alert">{errorMessage(aclUsers.error)}</div> : null}
      {aclUsers.data && aclUsers.data.users.length === 0 ? (
        <div className="surface-state surface-state--empty">当前没有可授权的普通员工账号。</div>
      ) : null}
      {aclUsers.data?.users.length ? (
        <label className="field item-permissions-user-select">
          <span>授权员工</span>
          <select value={selectedUserId} onChange={(event) => setSelectedUserId(event.target.value)}>
            {aclUsers.data.users.map((user) => <option key={user.id} value={user.id}>{user.username}</option>)}
          </select>
        </label>
      ) : null}
      {query.isError ? (
        <div className="notice notice--error" role="alert">
          <span>{errorMessage(query.error)}</span>
          <button className="button button--secondary" type="button" onClick={() => void query.refetch()}>重试</button>
        </div>
      ) : null}
      {acl && permissions ? (
        <form className="user-create-form item-permissions-form" onSubmit={submit}>
          <div className="permission-note">
            <ShieldCheck size={18} />
            <div>
              <strong>{acl.inheritParent ? `${acl.username} 当前继承上级权限` : `${acl.username} 当前有单独授权`}</strong>
              <span>配置来源：{acl.source === 'item' ? '员工条目授权' : acl.source === 'root' ? '根目录默认策略' : acl.source === 'folder' ? '上级文件夹 ACL' : '账号基线'}。</span>
            </div>
            {canViewChain ? <button
              className="button button--secondary button--sm"
              type="button"
              onClick={() => setShowPermissionChain(true)}
            >
              查看权限链
            </button> : null}
          </div>
          <fieldset className="create-permissions">
            <legend>六维权限卡片</legend>
            <PermissionGrid
              permissions={permissions}
              onChange={(next) => setPermissions(next)}
              disabled={busy}
            />
          </fieldset>
          <div className="user-details__note">
            <FolderLock size={14} />继承后的配置：{permissionSummaryText(effective ?? permissions)}
          </div>
          <div className="user-create-form__footer">
            <button
              className="button button--secondary"
              type="button"
              onClick={() => inherit.mutate()}
              disabled={busy || acl.inheritParent}
            >
              <RotateCcw size={16} />恢复上级继承
            </button>
            <button className="button button--primary" type="submit" disabled={!dirty || busy}>
              {update.isPending ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}保存权限
            </button>
          </div>
        </form>
      ) : null}
      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}
      {showPermissionChain && canViewChain ? (
        <PermissionChainViewer
          initialFolderId={itemId}
          onClose={() => setShowPermissionChain(false)}
        />
      ) : null}
    </Modal>
  );
}

export type { ItemAclInfo };
