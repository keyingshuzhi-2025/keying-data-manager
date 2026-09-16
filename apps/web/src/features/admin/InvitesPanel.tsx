import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  Copy,
  Gift,
  Infinity as InfinityIcon,
  Link2,
  LoaderCircle,
  Trash2,
} from 'lucide-react';
import { api } from '../../api/client';
import type { AuthUser, Invite } from '../../types';
import { errorMessage, formatDate } from '../../utils/format';

interface InvitesPanelProps {
  currentUser: AuthUser;
}

const permissionLabels: Array<{
  key: keyof AuthUser['permissions'];
  title: string;
}> = [
  { key: 'read', title: '读取' },
  { key: 'upload', title: '上传' },
  { key: 'edit', title: '编辑' },
];

const expiryOptions: Array<{ value: number | null; label: string }> = [
  { value: 1, label: '1 小时后过期' },
  { value: 24, label: '24 小时后过期' },
  { value: 24 * 7, label: '7 天后过期' },
  { value: 24 * 30, label: '30 天后过期' },
  { value: null, label: '永不过期' },
];

function inviteUrl(code: string): string {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/register`;
  url.searchParams.set('invite', code);
  return url.toString();
}

function inviteStatus(invite: Invite): { label: string; tone: string } {
  if (invite.used) return { label: '已使用', tone: 'used' };
  if (!invite.isEnabled) return { label: '已撤销', tone: 'revoked' };
  if (invite.expired) return { label: '已过期', tone: 'revoked' };
  return { label: '可用', tone: 'active' };
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
    <button
      className="icon-button"
      type="button"
      onClick={copy}
      title={label}
      aria-label={label}
    >
      {copied ? <Check size={16} /> : <Copy size={16} />}
    </button>
  );
}

export function InvitesPanel({ currentUser }: InvitesPanelProps) {
  const queryClient = useQueryClient();
  const invites = useQuery({ queryKey: ['admin-invites'], queryFn: api.listInvites });

  const [permissions, setPermissions] = useState<AuthUser['permissions']>({
    read: true, upload: true, edit: true,
  });
  const [expiresInHours, setExpiresInHours] = useState<number | null>(24);

  const createInvite = useMutation({
    mutationFn: () => api.createInvite({
      permissions,
      expiresInHours: expiresInHours ?? undefined,
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-invites'] });
    },
  });
  const revokeInvite = useMutation({
    mutationFn: (id: string) => api.revokeInvite(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-invites'] });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!createInvite.isPending) createInvite.mutate();
  };

  const newest = invites.data?.invites[0];

  return (
    <div className="invites-panel">
      <form className="invite-create" onSubmit={submit}>
        <div className="invite-create__row">
          <fieldset className="create-permissions">
            <legend>邀请开通的权限</legend>
            <div className="invite-permission-options">
              {permissionLabels.map(({ key, title }) => (
                <label className="invite-permission-option" key={key}>
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
                  <span>{title}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="field invite-expiry">
            <span>有效期</span>
            <select
              className="select-field"
              value={expiresInHours === null ? 'never' : String(expiresInHours)}
              onChange={(event) => {
                const value = event.target.value;
                setExpiresInHours(value === 'never' ? null : Number(value));
              }}
            >
              {expiryOptions.map((option) => (
                <option key={option.label} value={option.value === null ? 'never' : String(option.value)}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button
            className="button button--primary"
            type="submit"
            disabled={createInvite.isPending || !permissions.read}
          >
            {createInvite.isPending ? <LoaderCircle className="spin" size={17} /> : <Gift size={17} />}
            {createInvite.isPending ? '生成中…' : '生成邀请链接'}
          </button>
        </div>
        {createInvite.isError ? (
          <div className="notice notice--error" role="alert">{errorMessage(createInvite.error)}</div>
        ) : null}
      </form>

      {newest && !newest.used && newest.isEnabled && !newest.expired ? (
        <div className="invite-result">
          <div>
            <strong>邀请链接（一次性）</strong>
            <code title={inviteUrl(newest.code)}>{inviteUrl(newest.code)}</code>
          </div>
          <CopyButton text={inviteUrl(newest.code)} label="复制邀请链接" />
        </div>
      ) : null}

      <div className="invite-list">
        {invites.isPending ? (
          <div className="surface-state invites-state"><LoaderCircle className="spin" size={22} /><span>正在读取邀请…</span></div>
        ) : invites.isError ? (
          <div className="notice notice--error" role="alert">
            <span>{errorMessage(invites.error)}</span>
            <button className="button button--secondary" type="button" onClick={() => invites.refetch()}>重试</button>
          </div>
        ) : invites.data && invites.data.invites.length === 0 ? (
          <div className="surface-state surface-state--empty invites-state">
            <Link2 size={22} />
            <span>还没有生成过邀请链接。邀请他人通过链接注册后，账号会自动获得预设权限。</span>
          </div>
        ) : (
          <ul className="invite-list__items">
            {invites.data?.invites.map((invite) => {
              const status = inviteStatus(invite);
              const usable = !invite.used && invite.isEnabled && !invite.expired;
              return (
                <li className={`invite-item invite-item--${status.tone}`} key={invite.id}>
                  <div className="invite-item__main">
                    <code className="invite-item__code">{invite.code}</code>
                    <span className="invite-item__perms">
                      {permissionLabels.filter(({ key }) => invite.permissions[key]).map(({ title }) => title).join(' / ') || '无权限'}
                    </span>
                    <span className="invite-item__meta">
                      创建于 {formatDate(invite.createdAt)}
                      {invite.expiresAt ? ` · ${formatDate(invite.expiresAt)} 过期` : ''}
                      {invite.usedAt ? ` · 使用于 ${formatDate(invite.usedAt)}` : ''}
                    </span>
                  </div>
                  <span className={`invite-status invite-status--${status.tone}`}>{status.label}</span>
                  {usable ? <CopyButton text={inviteUrl(invite.code)} label="复制邀请链接" /> : null}
                  {usable ? (
                    <button
                      className="icon-button icon-button--danger"
                      type="button"
                      onClick={() => revokeInvite.mutate(invite.id)}
                      disabled={revokeInvite.isPending}
                      title="撤销邀请"
                      aria-label="撤销邀请"
                    >
                      <Trash2 size={16} />
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <p className="user-details__note"><InfinityIcon size={14} /> 邀请码一次性有效：注册成功后自动失效；已生成的链接可在列表中随时撤销。</p>
    </div>
  );
}