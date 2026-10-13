import { useState, type FormEvent } from 'react';
import { LoaderCircle, Save, ShieldCheck } from 'lucide-react';
import { Modal } from '../../components/Modal';
import { Toast, type ToastMessage } from '../../components/Toast';
import type { AuthUser, PermissionSet } from '../../types';
import { errorMessage } from '../../utils/format';
import { PermissionGrid, permissionSummaryText, PERMISSION_DEFINITIONS, type PermissionDefinition } from '../common/PermissionCard';

/** 用户全局权限仅含读取/上传/编辑；download / editMd / share 由文件夹级 ACL 控制。 */
const EDITABLE_DEFS = PERMISSION_DEFINITIONS.filter(
  (d: PermissionDefinition) => ['read', 'upload', 'edit'].includes(d.key),
) as PermissionDefinition[];

export interface PermissionEditorModalProps {
  user: AuthUser;
  initialPermissions: AuthUser['permissions'];
  onClose: () => void;
  onSave: (permissions: AuthUser['permissions']) => void;
  saving: boolean;
}

/** 权限编辑模态框：独立弹窗编辑用户全局权限，避免行内卡片拥挤。 */
export function PermissionEditorModal({
  user,
  initialPermissions,
  onClose,
  onSave,
  saving,
}: PermissionEditorModalProps) {
  const [permissions, setPermissions] = useState<AuthUser['permissions']>({ ...initialPermissions });
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const dirty = EDITABLE_DEFS.some((d) => permissions[d.key] !== initialPermissions[d.key]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!dirty || saving) return;
    onSave(permissions);
  };
  const applyPreset = (preset: 'all' | 'readonly' | 'none') => {
    if (preset === 'all') setPermissions({ read: true, upload: true, edit: true });
    if (preset === 'readonly') setPermissions({ read: true, upload: false, edit: false });
    if (preset === 'none') setPermissions({ read: false, upload: false, edit: false });
  };

  return (
    <Modal
      title={`权限设置 · ${user.username}`}
      description="设置该账号的默认权限（文件夹 ACL 未覆盖时生效）。下载、Markdown 编辑与分享由文件夹级 ACL 按目录控制。"
      onClose={onClose}
      size="medium"
    >
      <form className="user-create-form permission-editor" onSubmit={submit}>
        {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}
        <div className="permission-note">
          <ShieldCheck size={18} />
          <div>
            <strong>当前权限摘要</strong>
            <span>{permissionSummaryText(permissions as unknown as PermissionSet) || '无'}</span>
          </div>
        </div>
        <div className="permission-presets" aria-label="常用权限预设">
          <button className="button button--secondary button--sm" type="button" onClick={() => applyPreset('all')}>全开</button>
          <button className="button button--secondary button--sm" type="button" onClick={() => applyPreset('readonly')}>只读</button>
          <button className="button button--secondary button--sm" type="button" onClick={() => applyPreset('none')}>清空</button>
        </div>
        <fieldset className="create-permissions">
          <legend>全局权限</legend>
          <PermissionGrid
            permissions={permissions as unknown as PermissionSet}
            onChange={(next) => setPermissions(next)}
            permissionsDef={EDITABLE_DEFS}
          />
        </fieldset>
        <div className="user-create-form__footer">
          <button className="button button--secondary" type="button" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button className="button button--primary" type="submit" disabled={!dirty || saving}>
            {saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}
            {saving ? '保存中…' : '保存权限'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
