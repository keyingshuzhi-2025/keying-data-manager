import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderLock, LoaderCircle, RotateCcw, Save, ShieldCheck } from 'lucide-react';
import { api } from '../../api/client';
import { Modal } from '../../components/Modal';
import { Toast, type ToastMessage } from '../../components/Toast';
import type { FolderAclInfo, PermissionSet } from '../../types';
import { errorMessage } from '../../utils/format';
import { PermissionGrid, permissionSummaryText } from '../common/PermissionCard';

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

function folderLabel(folderId: string): string {
  return folderId === 'ROOT' ? '根目录默认策略' : `目录 ${folderId.slice(0, 8)}…`;
}

export function FolderPermissionsDialog({
  folderId,
  onClose,
}: {
  folderId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const query = useQuery({
    queryKey: ['folder-permissions', folderId],
    queryFn: () => api.getFolderPermissions(folderId),
  });
  const update = useMutation({
    mutationFn: (permissions: PermissionSet) => api.updateFolderPermissions({ folderId, permissions }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['folder-permissions'] });
      void queryClient.invalidateQueries({ queryKey: ['files'] });
      void queryClient.invalidateQueries({ queryKey: ['path'] });
      setToast({ id: Date.now(), text: '目录权限已更新', tone: 'success' });
    },
    onError: (error) => setToast({ id: Date.now(), text: errorMessage(error), tone: 'error' }),
  });
  const inherit = useMutation({
    mutationFn: () => api.updateFolderPermissions({ folderId, inheritParent: true }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['folder-permissions'] });
      void queryClient.invalidateQueries({ queryKey: ['files'] });
      setToast({ id: Date.now(), text: '已恢复继承父目录权限', tone: 'success' });
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
      title="目录权限"
      description={`正在配置“${folderLabel(folderId)}”。子目录默认继承最近一层显式策略。`}
      onClose={onClose}
      size="medium"
    >
      {query.isPending ? (
        <div className="surface-state"><LoaderCircle className="spin" size={24} /><span>正在读取权限…</span></div>
      ) : null}
      {query.isError ? (
        <div className="notice notice--error" role="alert">
          <span>{errorMessage(query.error)}</span>
          <button className="button button--secondary" type="button" onClick={() => void query.refetch()}>重试</button>
        </div>
      ) : null}
      {acl && permissions ? (
        <form className="user-create-form" onSubmit={submit}>
          <div className="permission-note">
            <ShieldCheck size={18} />
            <div>
              <strong>{acl.inheritParent ? '当前目录继承上级权限' : '当前目录有显式权限'}</strong>
              <span>生效来源：{acl.source === 'root' ? '根目录默认策略' : acl.source === 'folder' ? '本目录或上级目录' : '账号遗留权限'}；管理员始终绕过 ACL。</span>
            </div>
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
            <FolderLock size={14} />生效权限：{permissionSummaryText(effective ?? permissions)}
          </div>
          <div className="user-create-form__footer">
            <button
              className="button button--secondary"
              type="button"
              onClick={() => inherit.mutate()}
              disabled={busy || acl.inheritParent}
            >
              <RotateCcw size={16} />恢复继承
            </button>
            <button className="button button--primary" type="submit" disabled={!dirty || busy}>
              {update.isPending ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}保存权限
            </button>
          </div>
        </form>
      ) : null}
      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}
    </Modal>
  );
}

export type { FolderAclInfo };
