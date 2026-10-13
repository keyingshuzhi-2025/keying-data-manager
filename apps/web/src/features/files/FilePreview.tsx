import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarClock,
  Download,
  ExternalLink,
  FileQuestion,
  Fingerprint,
  FolderLock,
  HardDrive,
  Link2,
  LoaderCircle,
  Pencil,
  Save,
  Share2,
} from 'lucide-react';
import { api, fileExportPdfUrl, fileStreamUrl } from '../../api/client';
import { FileTypeIcon } from '../../components/FileTypeIcon';
import { Modal } from '../../components/Modal';
import { Toast, type ToastMessage } from '../../components/Toast';
import type { FileRecord, PermissionSet } from '../../types';
import { errorMessage, fileTypeOf, formatBytes, formatDate } from '../../utils/format';
import { copyToClipboard } from '../../utils/clipboard';
import { ItemPermissionsDialog } from './ItemPermissionsDialog';
import { PermissionGrid } from '../common/PermissionCard';

interface FilePreviewProps {
  file: FileRecord;
  onClose: () => void;
  canDownload: boolean;
  canEditMd: boolean;
  canShare: boolean;
  canManagePermissions: boolean;
  canViewChain: boolean;
  userId: string;
}

export function FilePreview({
  file,
  onClose,
  canDownload: inheritedCanDownload,
  canEditMd: inheritedCanEditMd,
  canShare: inheritedCanShare,
  canManagePermissions,
  canViewChain,
  userId,
}: FilePreviewProps) {
  const queryClient = useQueryClient();
  const type = fileTypeOf(file);
  const isText = type === 'text' || Boolean(file.mimeType?.startsWith('text/'));
  const isMarkdown = isText && /^(md|markdown)$/i.test(file.extension ?? '');
  const streamUrl = fileStreamUrl(file.id);
  const [content, setContent] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [itemPermissionsOpen, setItemPermissionsOpen] = useState(false);
  const effectiveQuery = useQuery({
    queryKey: ['effective-file-permissions', userId, file.id],
    queryFn: () => api.getEffectiveFilePermissions(file.id),
  });
  const filePermissions: PermissionSet = effectiveQuery.data?.permissions ?? {
    read: true,
    download: inheritedCanDownload,
    upload: false,
    edit: false,
    editMd: inheritedCanEditMd,
    share: inheritedCanShare,
  };
  const canDownload = filePermissions.download;
  const canEditMd = filePermissions.editMd;
  const canShare = filePermissions.share;
  const typeLabel = type === 'image'
    ? '图片'
    : type === 'audio'
      ? '音频'
      : type === 'video'
        ? '视频'
        : type === 'text'
          ? (isMarkdown ? 'Markdown' : '文本')
          : file.mimeType === 'application/pdf'
            ? 'PDF'
            : '文件';
  const contentQuery = useQuery({
    queryKey: ['file-content', file.id],
    queryFn: () => api.previewFile(file.id),
    enabled: isText,
  });
  const save = useMutation({
    mutationFn: (nextContent: string) => api.updateFileContent(file.id, { content: nextContent }),
    onSuccess: (_result, nextContent) => {
      setContent(nextContent);
      void queryClient.invalidateQueries({ queryKey: ['file-content', file.id] });
      void queryClient.invalidateQueries({ queryKey: ['files'] });
      setToast({ id: Date.now(), text: 'Markdown 已保存', tone: 'success' });
    },
    onError: (error) => setToast({ id: Date.now(), text: errorMessage(error), tone: 'error' }),
  });
  const share = useMutation({
    mutationFn: () => api.createShareLink({ fileId: file.id, expiresIn: '7d', maxAccesses: null, password: null }),
    onSuccess: async (result) => {
      const url = /^https?:\/\//i.test(result.url) ? result.url : new URL(result.url, window.location.origin).toString();
      setShareUrl(url);
      const ok = await copyToClipboard(url);
      setToast({
        id: Date.now(),
        text: ok ? '分享链接已创建并复制到剪贴板' : '分享链接已创建（复制失败，请手动复制）',
        tone: 'success',
      });
    },
    onError: (error) => setToast({ id: Date.now(), text: errorMessage(error), tone: 'error' }),
  });

  useEffect(() => {
    if (contentQuery.data?.content !== undefined) setContent(contentQuery.data.content);
  }, [contentQuery.data?.content]);
  useEffect(() => {
    if (!toast) return undefined;
    const timeout = window.setTimeout(() => setToast((current) => current?.id === toast.id ? null : current), 4_500);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!save.isPending) save.mutate(content);
  };

  return (
    <Modal title={file.name} description="文件预览、属性与当前授权" onClose={onClose} size="xlarge">
      <div className="preview-layout">
        <header className="preview-summary">
          <div className="preview-summary__file">
            <FileTypeIcon file={file} size={34} />
            <div>
              <strong>{file.name}</strong>
              <span>{typeLabel} · {formatBytes(file.sizeBytes)} · {formatDate(file.updatedAt)}</span>
            </div>
          </div>
          <div className="preview-summary__badges">
            <span>{canDownload ? '允许下载' : '仅可预览'}</span>
            <span>{canShare ? '可分享' : '不可分享'}</span>
            {isMarkdown ? <span>{canEditMd ? '可编辑 MD' : 'MD 只读'}</span> : null}
          </div>
        </header>

        <div className="preview-top">
          <main className="preview-main">
            <div className="preview-main__bar">
              <span>{editorOpen ? 'Markdown 编辑器' : `${typeLabel}预览`}</span>
              {isMarkdown && canEditMd ? (
                <button className="button button--secondary button--sm" type="button" onClick={() => setEditorOpen((open) => !open)}>
                  <Pencil size={14} /> {editorOpen ? '返回预览' : '编辑 Markdown'}
                </button>
              ) : null}
            </div>
            <div className={`preview-stage preview-stage--${type}`}>
              {isMarkdown && editorOpen ? (
                <div className="markdown-editor">
                  <textarea
                    value={content}
                    onChange={(event) => setContent(event.target.value)}
                    spellCheck={false}
                    aria-label="Markdown 内容"
                  />
                  <div className="markdown-editor__actions">
                    <button className="button button--secondary" type="button" onClick={() => setEditorOpen(false)}>返回预览</button>
                    <button className="button button--primary" type="button" onClick={submit} disabled={save.isPending}>
                      {save.isPending ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}保存
                    </button>
                  </div>
                </div>
              ) : null}
              {!editorOpen && type === 'image' ? <img src={streamUrl} alt={file.name} /> : null}
              {!editorOpen && type === 'audio' ? <audio src={streamUrl} controls autoPlay={false}>浏览器不支持音频播放。</audio> : null}
              {!editorOpen && type === 'video' ? <video src={streamUrl} controls playsInline>浏览器不支持视频播放。</video> : null}
              {!editorOpen && type === 'document' && file.mimeType === 'application/pdf' ? (
                <iframe src={streamUrl} title={`${file.name} PDF 预览`} />
              ) : null}
              {!editorOpen && isText && !isMarkdown ? (
                <iframe className="text-preview" sandbox="" src={streamUrl} title={`${file.name} 文本预览`} />
              ) : null}
              {isMarkdown && !editorOpen ? (
                <div className="markdown-preview">
                  {contentQuery.isPending ? <div className="surface-state"><LoaderCircle className="spin" size={24} />正在读取内容…</div> : null}
                  {contentQuery.isError ? <div className="notice notice--error" role="alert">{errorMessage(contentQuery.error)}</div> : null}
                  {contentQuery.data ? <pre className="markdown-plain">{contentQuery.data.content}</pre> : null}
                </div>
              ) : null}
              {!editorOpen && (type === 'other'
                || (type === 'document' && file.mimeType !== 'application/pdf' && !file.mimeType?.startsWith('text/')))
                ? (
                  <div className="preview-fallback">
                    <FileQuestion size={48} strokeWidth={1.4} />
                    <strong>此格式无法在浏览器中直接预览</strong>
                    <span>下载后使用本地应用打开。</span>
                  </div>
                ) : null}
            </div>
          </main>

          <aside className="preview-meta">
            <section className="preview-panel preview-panel--actions">
              <h3>操作</h3>
              <div className="preview-action-grid">
                <a className="button button--secondary" href={fileStreamUrl(file.id)} target="_blank" rel="noopener noreferrer" title="在新标签页中打开">
                  <ExternalLink size={15} /> 新标签页
                </a>
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={async () => {
                    const ok = await copyToClipboard(fileStreamUrl(file.id));
                    setToast({ id: Date.now(), text: ok ? '文件链接已复制' : '复制失败，请手动复制', tone: ok ? 'success' : 'error' });
                  }}
                  title="复制文件流链接"
                >
                  <Link2 size={15} /> 复制链接
                </button>
              </div>
              {canDownload ? (
                <>
                  <a className="button button--primary button--wide" href={`/api/files/${file.id}/download`}><Download size={18} />下载文件</a>
                  {isMarkdown ? <a className="button button--secondary button--wide" href={fileExportPdfUrl(file.id)}>导出 PDF</a> : null}
                </>
              ) : (
                <div className="preview-lock-note">当前目录未授予下载权限，只能在站内预览。</div>
              )}
              {canShare ? (
                <button className="button button--ghost button--wide" type="button" onClick={() => share.mutate()} disabled={share.isPending}>
                  {share.isPending ? <LoaderCircle className="spin" size={16} /> : <Share2 size={17} />}创建 7 天分享
                </button>
              ) : null}
            </section>

            <section className="preview-panel">
              <h3>属性</h3>
              <dl>
                <div><dt><FileQuestion size={13} />类型</dt><dd>{file.mimeType ?? '未知'}</dd></div>
                <div><dt><HardDrive size={13} />大小</dt><dd>{formatBytes(file.sizeBytes)}</dd></div>
                <div><dt><CalendarClock size={13} />修改时间</dt><dd>{formatDate(file.updatedAt)}</dd></div>
                <div><dt><Fingerprint size={13} />校验值</dt><dd className="hash" title={file.sha256 ?? undefined}>{file.sha256?.slice(0, 24) ?? '—'}</dd></div>
              </dl>
            </section>

            <section className="preview-panel preview-perms">
              <div className="preview-perms__head">
                <div className="preview-perms__title">
                  <FolderLock size={16} />
                  <div>
                    <strong>当前权限</strong>
                    <span>当前文件及上级文件夹的有效权限</span>
                  </div>
                </div>
                {canManagePermissions ? <button
                  className="button button--secondary button--sm"
                  type="button"
                  onClick={() => setItemPermissionsOpen(true)}
                >
                  <Pencil size={14} /> 设置
                </button> : null}
              </div>
              <PermissionGrid permissions={filePermissions} onChange={() => {}} disabled />
            </section>
          </aside>
        </div>

        <section className="preview-extras">
          {shareUrl ? (
            <div className="notice notice--invite" role="status">
              <span>已为“{file.name}”生成分享链接（令牌标识，匿名访问）：</span>
              <code title={shareUrl}>{shareUrl}</code>
            </div>
          ) : null}
        </section>

        {itemPermissionsOpen ? (
          <ItemPermissionsDialog
            item={file}
            canViewChain={canViewChain}
            onClose={() => setItemPermissionsOpen(false)}
          />
        ) : null}
      </div>
      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}
    </Modal>
  );
}
