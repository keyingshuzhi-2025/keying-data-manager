import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  Ban,
  ChevronRight,
  Clock,
  Download,
  Eye,
  FileQuestion,
  FolderOpen,
  Globe,
  Link2,
  LoaderCircle,
  Lock,
  LockKeyhole,
  ShieldCheck,
} from 'lucide-react';
import {
  ApiError,
  api,
  publicShareDownloadUrl,
  publicShareStreamUrl,
} from '../../api/client';
import { FileTypeIcon } from '../../components/FileTypeIcon';
import { errorMessage, fileTypeOf, formatBytes, formatDate } from '../../utils/format';
import { PublicFilePreview } from './PublicFilePreview';
import { publicTargetUrl, toFileRecord } from './utils';
import type { PublicShareInfo, ShareTreeNode } from '../../types';
import './shares.css';

type TerminalState = 'not-found' | 'expired' | 'revoked' | 'exhausted' | null;

const terminalViews: Record<Exclude<TerminalState, null>, { icon: typeof Link2; title: string; desc: string }> = {
  'not-found': { icon: Link2, title: '链接不存在', desc: '该分享链接可能已被删除，或地址有误。' },
  expired: { icon: Clock, title: '分享已过期', desc: '此分享链接已超过有效期，无法继续访问。' },
  revoked: { icon: Ban, title: '分享已撤销', desc: '分享者已撤销此链接，访问已被停止。' },
  exhausted: { icon: LockKeyhole, title: '访问次数已用尽', desc: '此分享链接已达到访问次数上限。' },
};

/** 解析终态（错误码优先，其次数据字段兜底） */
function resolveTerminal(error: ApiError | null, share: PublicShareInfo | undefined): TerminalState {
  if (error) {
    switch (error.code) {
      case 'SHARE_NOT_FOUND': return 'not-found';
      case 'SHARE_EXPIRED': return 'expired';
      case 'SHARE_REVOKED': return 'revoked';
      case 'SHARE_ACCESS_EXCEEDED': return 'exhausted';
      default: break;
    }
  }
  if (share) {
    if (share.isRevoked) return 'revoked';
    if (share.expired) return 'expired';
    if (share.maxAccesses !== null && share.accessCount >= share.maxAccesses) return 'exhausted';
  }
  return null;
}

/** 分享子树的一行（文件夹可展开 / 收起，文件可预览 / 下载） */
function ShareTreeRow({
  node,
  token,
  depth,
  onPreview,
}: {
  node: ShareTreeNode;
  token: string;
  depth: number;
  onPreview: (node: ShareTreeNode) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  const indent = { '--tree-depth': depth } as CSSProperties;

  if (node.kind === 'folder') {
    return (
      <li className="share-tree__row share-tree__row--folder" style={indent}>
        <button
          type="button"
          className="share-tree__toggle"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
        >
          <ChevronRight className={`share-tree__chevron${open ? ' is-open' : ''}`} size={15} aria-hidden="true" />
          <FileTypeIcon file={toFileRecord(node)} size={18} />
          <span className="share-tree__name" title={node.name}>{node.name}</span>
          <span className="share-tree__count">{node.children?.length ?? 0} 项</span>
        </button>
        {open && node.children && node.children.length > 0 ? (
          <ul className="share-tree">
            {node.children.map((child) => (
              <ShareTreeRow key={child.id} node={child} token={token} depth={depth + 1} onPreview={onPreview} />
            ))}
          </ul>
        ) : null}
      </li>
    );
  }

  const downloadUrl = publicTargetUrl(publicShareDownloadUrl(token), node);
  return (
    <li className="share-tree__row share-tree__row--file" style={indent}>
      <button type="button" className="share-tree__file" onClick={() => onPreview(node)}>
        <FileTypeIcon file={toFileRecord(node)} size={18} />
        <span className="share-tree__name" title={node.name}>{node.name}</span>
      </button>
      <span className="share-tree__size">{formatBytes(node.sizeBytes)}</span>
      <span className="share-tree__actions">
        <button type="button" onClick={() => onPreview(node)} aria-label={`预览 ${node.name}`} title="预览">
          <Eye size={17} />
        </button>
        <a href={downloadUrl} aria-label={`下载 ${node.name}`} title="下载">
          <Download size={17} />
        </a>
      </span>
    </li>
  );
}

/**
 * 匿名公开分享落地页（/s/:token）。
 *
 * 只读：仅可预览 / 下载该分享指向的单个文件或文件夹子树，
 * 不登录、不暴露内部路径 / 上传者；所有外部输出由服务端叠加分享者溯源水印。
 */
export function PublicSharePage({ token }: { token: string }) {
  const [unlocked, setUnlocked] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [preview, setPreview] = useState<ShareTreeNode | null>(null);

  useEffect(() => {
    setUnlocked(false);
    setPasswordInput('');
    setPreview(null);
  }, [token]);

  const info = useQuery({
    queryKey: ['public-share', token, unlocked],
    queryFn: () => api.getPublicShareInfo(token),
  });
  const share = info.data?.share;
  const isFolder = share?.kind === 'folder';
  const rootFile = share && !isFolder ? info.data?.file : undefined;

  useEffect(() => {
    const previous = document.title;
    const titleName = isFolder
      ? share?.fileName ?? '文件夹分享'
      : rootFile?.name ?? share?.fileName ?? '文件分享';
    if (share) document.title = `${titleName} - 匿名分享 · 柯影文件站`;
    return () => { document.title = previous; };
  }, [share, isFolder, rootFile]);

  const error = info.error instanceof ApiError ? info.error : null;
  const terminal = resolveTerminal(error, share);
  const passwordRequired = !unlocked && error?.code === 'SHARE_PASSWORD_REQUIRED';

  const verify = useMutation({
    mutationFn: (value: string) => api.verifyPublicSharePassword(token, { password: value }),
    onSuccess: () => setUnlocked(true),
  });

  const submitPassword = (event: FormEvent) => {
    event.preventDefault();
    if (passwordInput && !verify.isPending) verify.mutate(passwordInput);
  };

  const tree = useQuery({
    queryKey: ['public-share-tree', token, unlocked],
    queryFn: () => api.getPublicShareTree(token),
    enabled: Boolean(isFolder),
  });

  const streamUrl = publicShareStreamUrl(token);
  const downloadUrl = publicShareDownloadUrl(token);
  const rootType = rootFile ? fileTypeOf(rootFile) : 'other';
  const rootName = rootFile?.name ?? share?.fileName ?? '分享文件';

  return (
    <div className="public-share">
      <header className="public-share__topbar">
        <div className="public-share__brand">
          <div className="brand-mark"><Globe size={20} /></div>
          <div><strong>柯影文件站</strong><span>SHARED FILES</span></div>
        </div>
        <span className="public-share__topbar__spacer" />
        <span className="public-share__badge"><Lock size={13} />匿名只读访问</span>
      </header>

      <main className="public-share__main">
        <div className="public-share__card">
          {info.isPending ? (
            <div className="public-share__status" role="status">
              <LoaderCircle className="spin" size={30} />
              <span className="muted-text">正在读取分享内容…</span>
            </div>
          ) : terminal ? (
            <div className="public-share__status" role="alert">
              {(() => {
                const view = terminalViews[terminal];
                const Icon = view.icon;
                return (
                  <>
                    <div className="public-share__status__icon"><Icon size={28} /></div>
                    <h2>{view.title}</h2>
                    <p>{view.desc}</p>
                  </>
                );
              })()}
            </div>
          ) : passwordRequired ? (
            <form className="public-share__password" onSubmit={submitPassword}>
              <div className="public-share__lock"><Lock size={26} /></div>
              <span className="eyebrow">受密码保护</span>
              <h2>此分享已加密</h2>
              <p>输入访问密码后即可查看内容。密码错误不会返回任何文件信息。</p>
              <label className="field">
                <span>访问密码</span>
                <input
                  type="password"
                  value={passwordInput}
                  onChange={(event) => setPasswordInput(event.target.value)}
                  autoFocus
                  required
                />
              </label>
              {verify.isError ? <p className="field-error">{errorMessage(verify.error)}</p> : null}
              <button className="button button--primary button--wide" type="submit" disabled={verify.isPending || !passwordInput}>
                {verify.isPending ? <LoaderCircle className="spin" size={17} /> : <Lock size={17} />}
                {verify.isPending ? '验证中…' : '解锁访问'}
              </button>
            </form>
          ) : info.isError ? (
            <div className="public-share__status" role="alert">
              <div className="public-share__status__icon"><FileQuestion size={28} /></div>
              <h2>无法访问此分享</h2>
              <p>{error ? errorMessage(error) : '网络异常，请稍后重试。'}</p>
              <button className="button button--secondary" type="button" onClick={() => info.refetch()}>
                <LoaderCircle className={info.isFetching ? 'spin' : undefined} size={16} />重试
              </button>
            </div>
          ) : share ? (
            <div className="public-share__content">
              <div className="public-share__heading">
                <div>
                  <span className="eyebrow">{isFolder ? '文件夹分享' : '文件分享'}</span>
                  <h1>{rootName}</h1>
                </div>
                <div className="public-share__heading__badges">
                  <span className="public-share__badge--meta">
                    {share.expiresAt ? `有效期至 ${formatDate(share.expiresAt)}` : '永久有效'}
                  </span>
                  {share.maxAccesses !== null ? (
                    <span className="public-share__badge--meta">次数上限 {share.maxAccesses}</span>
                  ) : null}
                </div>
              </div>

              {isFolder ? (
                <div className="public-share__folder">
                  <div className="public-share__folder-head">
                    <span className="eyebrow">目录内容</span>
                    {tree.data ? (
                      <span className="public-share__badge--meta">
                        {tree.data.totalCount} 个文件 · {formatBytes(tree.data.totalBytes)}
                      </span>
                    ) : null}
                  </div>
                  {tree.isPending ? (
                    <div className="inline-loading"><LoaderCircle className="spin" size={18} />载入目录…</div>
                  ) : tree.isError ? (
                    <div className="notice notice--error" role="alert">
                      <span>{errorMessage(tree.error)}</span>
                      <button className="button button--secondary" type="button" onClick={() => tree.refetch()}>重试</button>
                    </div>
                  ) : !tree.data?.tree.children || tree.data.tree.children.length === 0 ? (
                    <div className="public-share__empty">
                      <FolderOpen size={30} strokeWidth={1.5} />
                      <span>此文件夹为空。</span>
                    </div>
                  ) : (
                    <ul className="share-tree">
                      {tree.data.tree.children.map((child) => (
                        <ShareTreeRow key={child.id} node={child} token={token} depth={0} onPreview={setPreview} />
                      ))}
                    </ul>
                  )}
                </div>
              ) : (
                <div className="public-share__layout">
                  <div className="public-share__stage">
                    {rootType === 'image' ? <img src={streamUrl} alt={rootName} /> : null}
                    {rootType === 'audio' ? <audio src={streamUrl} controls autoPlay={false}>浏览器不支持音频播放。</audio> : null}
                    {rootType === 'video' ? <video src={streamUrl} controls playsInline>浏览器不支持视频播放。</video> : null}
                    {rootType === 'document' && rootFile?.mimeType === 'application/pdf' ? (
                      <iframe src={streamUrl} title={`${rootName} PDF 预览`} />
                    ) : null}
                    {rootType === 'document' && rootFile?.mimeType?.startsWith('text/') ? (
                      <iframe className="text-preview" sandbox="" src={streamUrl} title={`${rootName} 文本预览`} />
                    ) : null}
                    {(rootType === 'other'
                      || (rootType === 'document' && rootFile?.mimeType !== 'application/pdf' && !rootFile?.mimeType?.startsWith('text/')))
                      ? (
                        <div className="public-share__fallback">
                          <FileQuestion size={48} strokeWidth={1.4} />
                          <strong>此格式无法在浏览器中直接预览</strong>
                          <span>下载后使用本地应用打开。</span>
                        </div>
                      ) : null}
                  </div>
                  <aside className="public-share__meta">
                    <dl>
                      <div><dt>类型</dt><dd>{rootFile?.mimeType ?? '未知'}</dd></div>
                      <div><dt>大小</dt><dd>{formatBytes(rootFile?.sizeBytes ?? null)}</dd></div>
                      <div><dt>分享时间</dt><dd>{formatDate(share.createdAt)}</dd></div>
                      <div><dt>访问限制</dt><dd>{share.maxAccesses !== null ? `最多 ${share.maxAccesses} 次` : '不限次数'}</dd></div>
                    </dl>
                    <a className="button button--primary button--wide" href={downloadUrl}>
                      <Download size={18} />下载文件
                    </a>
                  </aside>
                </div>
              )}
            </div>
          ) : null}
        </div>
      </main>

      <footer className="public-share__footer">
        <ShieldCheck size={14} />
        <span>仅供只读访问 · 内容输出叠加分享者溯源水印 · 由柯影文件站分享</span>
      </footer>

      {preview ? (
        <PublicFilePreview node={preview} token={token} onClose={() => setPreview(null)} />
      ) : null}
    </div>
  );
}
