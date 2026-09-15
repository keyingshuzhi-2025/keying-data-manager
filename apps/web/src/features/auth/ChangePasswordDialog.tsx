import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { LoaderCircle, ShieldCheck } from 'lucide-react';
import { api } from '../../api/client';
import { Modal } from '../../components/Modal';
import { errorMessage } from '../../utils/format';

interface ChangePasswordDialogProps {
  onClose: () => void;
  onChanged: () => void;
}

export function ChangePasswordDialog({ onClose, onChanged }: ChangePasswordDialogProps) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const change = useMutation({
    mutationFn: () => api.changeOwnPassword({ currentPassword, newPassword }),
    onSuccess: () => onChanged(),
  });

  const valid = currentPassword.length >= 1
    && newPassword.length >= 8
    && newPassword === confirmPassword;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    change.mutate();
  };

  return (
    <Modal
      title="修改密码"
      description="修改后将强制退出其他设备上的登录，当前设备保持在线。"
      onClose={onClose}
      size="small"
    >
      <form className="user-create-form" onSubmit={submit}>
        {change.isError ? (
          <div className="notice notice--error" role="alert">{errorMessage(change.error)}</div>
        ) : null}
        <label className="field">
          <span>当前密码</span>
          <input
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            required
            autoFocus
          />
        </label>
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
          />
        </label>
        <label className="field">
          <span>确认新密码</span>
          <input
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            required
          />
          {confirmPassword && newPassword !== confirmPassword ? (
            <small className="field-error">两次输入的新密码不一致</small>
          ) : null}
        </label>
        <div className="user-create-form__footer">
          <button className="button button--secondary" type="button" onClick={onClose}>取消</button>
          <button className="button button--primary" type="submit" disabled={!valid || change.isPending}>
            {change.isPending ? <LoaderCircle className="spin" size={17} /> : null}
            {change.isPending ? '提交中…' : '确认修改'}
          </button>
        </div>
        <p className="user-details__note"><ShieldCheck size={14} /> 请牢记新密码；忘记后只能由管理员重置。</p>
      </form>
    </Modal>
  );
}