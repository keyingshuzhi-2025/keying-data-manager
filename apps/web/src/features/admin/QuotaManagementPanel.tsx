import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Gauge, HardDrive, Infinity as InfinityIcon, LoaderCircle, RefreshCw, Save } from 'lucide-react';
import { api } from '../../api/client';
import { Modal } from '../../components/Modal';
import { Toast } from '../../components/Toast';
import { errorMessage, formatBytes } from '../../utils/format';
import type { AuthUser, UsersResponse } from '../../types';
import { usePanelToast } from './usePanelToast';

const BYTES_PER_MB = 1024 * 1024;
/** 输入上限（MB），约 10 PB，防止数值溢出到不安全整数 */
const MAX_QUOTA_MB = 10_000_000;

function usedBytes(user: AuthUser): number {
  return user.storageUsedBytes ?? 0;
}

function quotaPercent(user: AuthUser): number | null {
  if (user.storageQuotaBytes <= 0) return null;
  return Math.min(100, Math.round((usedBytes(user) / user.storageQuotaBytes) * 100));
}

// ----- 设置配额对话框 -----
function SetQuotaDialog({ user, onClose, onSaved }: {
  user: AuthUser;
  onClose: () => void;
  onSaved: (updated: AuthUser) => void;
}) {
  const [value, setValue] = useState(
    user.storageQuotaBytes > 0 ? String(Math.ceil(user.storageQuotaBytes / BYTES_PER_MB)) : '0',
  );

  const raw = Number(value);
  const parsed = value.trim() !== '' && Number.isInteger(raw) && raw >= 0
    ? Math.min(raw, MAX_QUOTA_MB)
    : null;
  const quotaBytes = parsed === null ? null : parsed * BYTES_PER_MB;
  const belowUsed = quotaBytes !== null && quotaBytes > 0 && quotaBytes < usedBytes(user);

  const save = useMutation({
    mutationFn: (bytes: number) => api.updateUserQuota(user.id, { storageQuotaBytes: bytes }),
    onSuccess: ({ user: updated }) => onSaved(updated),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (quotaBytes === null || belowUsed || save.isPending) return;
    save.mutate(quotaBytes);
  };

  return (
    <Modal title="设置存储配额" description={`为用户 “${user.username}” 设置存储空间上限。`} onClose={onClose} size="small">
      <form className="user-create-form" onSubmit={submit}>
        {save.isError ? (
          <div className="notice notice--error" role="alert">{errorMessage(save.error)}</div>
        ) : null}
        {belowUsed ? (
          <div className="notice notice--error" role="alert">
            配额不能低于当前已用空间（{formatBytes(usedBytes(user))}）。
          </div>
        ) : null}

        <dl className="user-details__list">
          <div><dt>当前已用</dt><dd>{formatBytes(usedBytes(user))}</dd></div>
          <div><dt>当前配额</dt><dd>{user.storageQuotaBytes > 0 ? formatBytes(user.storageQuotaBytes) : '不限'}</dd></div>
        </dl>

        <label className="field">
          <span>配额上限（MB）</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="0 表示不限制"
            autoFocus
            required
          />
        </label>
        <p className="user-details__note">
          <InfinityIcon size={14} /> 输入 0 表示不限制；数值按整数 MB 换算为字节（1 MB = 1048576 字节）。
        </p>

        <div className="user-create-form__footer">
          <button className="button button--secondary" type="button" onClick={onClose}>取消</button>
          <button
            className="button button--primary"
            type="submit"
            disabled={quotaBytes === null || belowUsed || save.isPending}
          >
            {save.isPending ? <LoaderCircle className="spin" size={17} /> : <Save size={16} />}
            {save.isPending ? '保存中…' : '保存配额'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * 存储配额管理面板：展示每个账号的已用空间与配额，并为账号设置配额上限。
 * 使用 api.listUsers（AuthUser 已含 storageQuotaBytes / storageUsedBytes）与
 * api.updateUserQuota（PATCH /api/admin/users/:id { storageQuotaBytes }）。
 * 通常作为“用户与权限”对话框中的一个标签页挂载。
 */
export function QuotaManagementPanel() {
  const queryClient = useQueryClient();
  const { toast, showToast, dismissToast } = usePanelToast();
  const [target, setTarget] = useState<AuthUser | null>(null);

  // 与“用户与权限”对话框共用同一缓存键，数据保持一致
  const users = useQuery({
    queryKey: ['admin-users'],
    queryFn: api.listUsers,
  });

  const summary = useMemo(() => {
    const list = users.data?.users ?? [];
    return {
      total: list.length,
      usedBytes: list.reduce((sum, user) => sum + usedBytes(user), 0),
      limited: list.filter((user) => user.storageQuotaBytes > 0).length,
    };
  }, [users.data]);

  const onSaved = (updated: AuthUser) => {
    setTarget(null);
    queryClient.setQueryData<UsersResponse>(['admin-users'], (current) => ({
      users: current?.users.map((user) => (user.id === updated.id ? updated : user)) ?? [updated],
    }));
    showToast(`已更新 ${updated.username} 的存储配额`);
  };

  return (
    <div className="quota-panel">
      <div className="user-management__toolbar">
        <span className="quota-panel__summary">
          <HardDrive size={16} />
          共 <strong>{summary.total}</strong> 个账号 · 已用合计 <strong>{formatBytes(summary.usedBytes)}</strong>
          {summary.limited > 0 ? ` · ${summary.limited} 个账号设有配额` : ' · 尚未设置任何配额'}
        </span>
        <button
          className="button button--secondary"
          type="button"
          onClick={() => void users.refetch()}
          disabled={users.isFetching}
        >
          <RefreshCw size={16} /> 刷新
        </button>
      </div>

      {users.isPending ? (
        <div className="surface-state quota-state"><LoaderCircle className="spin" size={24} /><span>正在读取用户…</span></div>
      ) : null}
      {users.isError ? (
        <div className="notice notice--error" role="alert">
          <span>{errorMessage(users.error)}</span>
          <button className="button button--secondary" type="button" onClick={() => users.refetch()}>重试</button>
        </div>
      ) : null}

      {users.data && users.data.users.length === 0 ? (
        <div className="surface-state surface-state--empty quota-state">
          <strong>当前还没有任何账号</strong>
          <span>在“用户列表”中新建账号后即可为其设置配额。</span>
        </div>
      ) : null}

      {users.data && users.data.users.length > 0 ? (
        <>
          <div className="quota-table-wrap">
            <table className="quota-table">
              <thead>
                <tr>
                  <th>账号</th>
                  <th>已用空间</th>
                  <th>配额</th>
                  <th>使用率</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {users.data.users.map((user) => {
                  const percent = quotaPercent(user);
                  return (
                    <tr key={user.id} className={!user.isEnabled ? 'quota-row--disabled' : undefined}>
                      <td>
                        <strong>{user.username}</strong>
                        {user.role === 'admin' ? <small className="quota-role"> 管理员</small> : null}
                        {!user.isEnabled ? <small className="quota-status"> 停用</small> : null}
                      </td>
                      <td>{formatBytes(usedBytes(user))}</td>
                      <td>
                        {user.storageQuotaBytes > 0 ? (
                          formatBytes(user.storageQuotaBytes)
                        ) : (
                          <span className="quota-unlimited"><InfinityIcon size={13} /> 不限</span>
                        )}
                      </td>
                      <td>
                        {percent === null ? (
                          <span>—</span>
                        ) : (
                          <>
                            <div
                              className="quota-bar"
                              role="progressbar"
                              aria-valuenow={percent}
                              aria-valuemin={0}
                              aria-valuemax={100}
                              aria-label={`${user.username} 配额使用率 ${percent}%`}
                            >
                              <div
                                className="quota-bar__fill"
                                style={{
                                  width: `${percent}%`,
                                  background: percent >= 90 ? '#b3402e' : percent >= 70 ? '#c98a1b' : '#215347',
                                }}
                              />
                            </div>
                            <small className="quota-percent">{percent}%</small>
                          </>
                        )}
                      </td>
                      <td>
                        <button
                          className="button button--secondary"
                          type="button"
                          onClick={() => setTarget(user)}
                        >
                          <Gauge size={15} /> 设置配额
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="user-details__note">
            <InfinityIcon size={14} /> 配额 0 表示不限制；配额不能低于用户当前已用空间，否则服务器会拒绝保存。
          </p>
        </>
      ) : null}

      {target ? (
        <SetQuotaDialog user={target} onClose={() => setTarget(null)} onSaved={onSaved} />
      ) : null}
      {toast ? <Toast message={toast} onDismiss={dismissToast} /> : null}
    </div>
  );
}
