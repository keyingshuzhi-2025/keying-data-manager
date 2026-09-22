import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Ban,
  Check,
  Copy,
  Link2,
  LoaderCircle,
  RotateCcw,
  Share2,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { api } from '../../api/client';
import { Modal } from '../../components/Modal';
import { Toast, type ToastMessage } from '../../components/Toast';
import type { FileRecord, ShareExpiryTier, ShareLink } from '../../types';
import { errorMessage, formatDate } from '../../utils/format';
import { shareLinkStatus, type ShareLinkStatus } from './utils';
import './shares.css';

const expiryPresets: Array<{ value: ShareExpiryTier; label: string }> = [
  { value: '1h', label: '1 小时内' },
  { value: '1d', label: '1 天' },
  { value: '3d', label: '3 天' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
  { value: 'forever', label: '永久有效' },
];

const statusMeta: Record<ShareLinkStatus, { label: string; tone: string }> = {
  active: { label: '有效', tone: 'active' },
  revoked: { label: '已撤销', tone: 'revoked' },
  expired: { label: '已过期', tone: 'expired' },
  exhausted: { label: '次数用尽', tone: 'exhausted' },
};

function expiryLabel(share: ShareLink): string {
  return share.expiresAt ? `有效期至 ${formatDate(share.expiresAt)}` : '永久有效';
}

/** 服务端返回的链接在未配置 publicUrl 时是相对路径（/s/:token），这里统一补全为绝对地址 */
function absoluteUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return new URL(url, window.location.origin).toString();
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // 剪贴板不可用时用户可手动复制
    }
  };
  return (
    <button className="icon-button" type="button" onClick={copy} title={label} aria-label={label}>
      {copied ? <Check size={16} /> : <Copy size={16} />}
    </button>
  );
}

export function ShareDialog({ file, onClose }: { file: FileRecord; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [expiry, setExpiry] = useState<ShareExpiryTier>('7d');
  const [maxAccesses, setMaxAccesses] = useState('');
  const [password, setPassword] = useState('');
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const showToast = (text: string, tone: ToastMessage['tone'] = 'success') => {
    setToast({ id: Date.now(), text, tone });
  };

  useEffect(() => {
    if (!toast) return undefined;
    const timeout = window.setTimeout(() => setToast((current) => (current?.id === toast.id ? null : current)), 4500);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const sharesQuery = useQuery({
    queryKey: ['share-links'],
    queryFn: () => api.listShareLinks({ limit: 200 }),
  });
  const shares = useMemo(
    () => (sharesQuery.data?.shares ?? []).filter((share) => share.fileId === file.id),
    [sharesQuery.data, file.id],
  );

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['share-links'] });
  };

  const create = useMutation({
    mutationFn: (input: { maxAccesses: number | null; password: string | null }) => api.createShareLink({
      fileId: file.id,
      expiresIn: expiry,
      maxAccesses: input.maxAccesses,
      password: input.password,
    }),
    onSuccess: () => {
      setMaxAccesses('');
      setPassword('');
      invalidate();
      showToast('分享链接已创建');
    },
    onError: (error) => showToast(errorMessage(error), 'error'),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeShareLink(id),
    onSuccess: () => {
      invalidate();
      showToast('分享已撤销，链接立即失效');
    },
    onError: (error) => showToast(errorMessage(error), 'error'),
  });
  const restore = useMutation({
    mutationFn: (id: string) => api.updateShareLink(id, { isRevoked: false }),
    onSuccess: () => {
      invalidate();
      showToast('分享已恢复');
    },
    onError: (error) => showToast(errorMessage(error), 'error'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteShareLink(id),
    onSuccess: () => {
      invalidate();
      showToast('分享记录已删除');
    },
    onError: (error) => showToast(errorMessage(error), 'error'),
  });

  const busy = create.isPending || revoke.isPending || restore.isPending || remove.isPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (create.isPending) return;
    const raw = maxAccesses.trim();
    let parsed: number | null = null;
    if (raw) {
      parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        showToast('次数上限需为不小于 1 的整数', 'error');
        return;
      }
    }
    create.mutate({
      maxAccesses: parsed,
      password: password.trim() || null,
    });
  };

  const created = create.data;

  return (
    <Modal title="分享链接" description={`为“${file.name}”创建对外分享链接。`} onClose={onClose} size="medium">
      <div className="share-dialog">
        <form className="dialog-form share-create" onSubmit={submit}>
          <div className="share-create__row">
            <label className="field share-create__expiry">
              <span>有效期</span>
              <select
                className="select-field"
                value={expiry}
                onChange={(event) => setExpiry(event.target.value as ShareExpiryTier)}
              >
                {expiryPresets.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>次数上限（可选）</span>
              <input
                type="number"
                min={1}
                step={1}
                value={maxAccesses}
                onChange={(event) => setMaxAccesses(event.target.value)}
                placeholder="不限"
                disabled={create.isPending}
              />
            </label>
          </div>
          <label className="field">
            <span>访问密码（可选）</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              maxLength={64}
              placeholder="留空则不设密码"
              disabled={create.isPending}
            />
          </label>
          <div className="notice notice--invite">
            <ShieldCheck size={17} />
            <span>
              <strong>公开访问</strong>
              任何人获得链接即可在有效期内访问，请谨慎传播；撤销后立即失效。
              设置密码后，访问者需输入密码才能查看内容。
            </span>
          </div>
          {create.isError ? (
            <div className="notice notice--error" role="alert">{errorMessage(create.error)}</div>
          ) : null}
          <div className="dialog-actions">
            <button className="button button--ghost" type="button" onClick={onClose}>关闭</button>
            <button className="button button--primary" type="submit" disabled={busy}>
              {create.isPending ? <LoaderCircle className="spin" size={17} /> : <Share2 size={17} />}
              {create.isPending ? '创建中…' : '创建分享链接'}
            </button>
          </div>
        </form>

        {created ? (
          <div className="share-result" role="status">
            <div>
              <strong>分享链接已生成</strong>
              <code title={absoluteUrl(created.url)}>{absoluteUrl(created.url)}</code>
              <small>
                {expiryLabel(created.share)}
                {created.share.hasPassword ? ' · 已设置访问密码，请单独告知访问者' : ''}
              </small>
            </div>
            <CopyButton text={absoluteUrl(created.url)} label="复制分享链接" />
          </div>
        ) : null}

        <div className="share-links">
          <div className="share-links__heading">
            <span className="eyebrow">已有分享</span>
            <span className="share-links__count">{shares.length} 个</span>
          </div>
          <p className="share-links__note">
            出于安全考虑，链接令牌仅在创建时显示一次；如需再次复制，请重新创建。
          </p>
          {sharesQuery.isPending ? (
            <div className="inline-loading"><LoaderCircle className="spin" size={18} />载入分享…</div>
          ) : sharesQuery.isError ? (
            <div className="notice notice--error" role="alert">
              <span>{errorMessage(sharesQuery.error)}</span>
              <button className="button button--secondary" type="button" onClick={() => sharesQuery.refetch()}>重试</button>
            </div>
          ) : shares.length === 0 ? (
            <p className="share-links__empty">
              尚未创建过此{file.kind === 'folder' ? '文件夹' : '文件'}的分享链接。
            </p>
          ) : (
            <ul className="share-links__items">
              {shares.map((share) => {
                const status = shareLinkStatus(share);
                const view = statusMeta[status];
                const usable = status === 'active';
                return (
                  <li className={`share-link-row${usable ? '' : ' is-off'}`} key={share.id}>
                    <div className="share-link-row__main">
                      <span className="share-link-row__token">
                        <Link2 size={15} aria-hidden="true" />
                        {share.fileName ?? '（文件已删除）'}
                      </span>
                      <span className="share-link-row__meta">
                        {formatDate(share.createdAt)} 创建 · {expiryLabel(share)}
                        {share.maxAccesses !== null
                          ? ` · 次数 ${share.accessCount}/${share.maxAccesses}`
                          : ` · 已访问 ${share.accessCount} 次`}
                        {share.hasPassword ? ' · 有密码' : ''}
                      </span>
                    </div>
                    <span className={`share-status share-status--${view.tone}`}>{view.label}</span>
                    <div className="share-link-row__actions">
                      {usable ? (
                        <button
                          className="icon-button"
                          type="button"
                          onClick={() => revoke.mutate(share.id)}
                          disabled={revoke.isPending}
                          title="撤销分享"
                          aria-label="撤销分享"
                        >
                          <Ban size={16} />
                        </button>
                      ) : null}
                      {status === 'revoked' ? (
                        <button
                          className="icon-button"
                          type="button"
                          onClick={() => restore.mutate(share.id)}
                          disabled={restore.isPending}
                          title="恢复分享"
                          aria-label="恢复分享"
                        >
                          <RotateCcw size={16} />
                        </button>
                      ) : null}
                      <button
                        className="icon-button icon-button--danger"
                        type="button"
                        onClick={() => remove.mutate(share.id)}
                        disabled={remove.isPending}
                        title="删除记录"
                        aria-label="删除记录"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}
    </Modal>
  );
}
