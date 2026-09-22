import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileQuestion, LoaderCircle, Save, Share2 } from 'lucide-react';
import { api, fileExportPdfUrl, fileStreamUrl } from '../../api/client';
import { FileTypeIcon } from '../../components/FileTypeIcon';
import { Modal } from '../../components/Modal';
import { Toast, type ToastMessage } from '../../components/Toast';
import type { FileRecord } from '../../types';
import { errorMessage, fileTypeOf, formatBytes, formatDate } from '../../utils/format';

interface FilePreviewProps {
  file: FileRecord;
  onClose: () => void;
  canDownload: boolean;
  canEditMd: boolean;
  canShare: boolean;
}

export function FilePreview({ file, onClose, canDownload, canEditMd, canShare }: FilePreviewProps) {
  const queryClient = useQueryClient();
  const type = fileTypeOf(file);
  const isText = type === 'document' && file.mimeType?.startsWith('text/');
  const isMarkdown = isText && /^(md|markdown)$/i.test(file.extension ?? '');
  const streamUrl = fileStreamUrl(file.id);
  const [content, setContent] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
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
    onSuccess: (result) => {
      const url = /^https?:\/\//i.test(result.url) ? result.url : new URL(result.url, window.location.origin).toString();
      void navigator.clipboard?.writeText(url).catch(() => undefined);
      setToast({ id: Date.now(), text: '分享链接已创建并复制到剪贴板', tone: 'success' });
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
    <Modal title={file.name} description="文件预览与属性" onClose={onClose} size="large">
      <div className="preview-layout">
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
          {type === 'image' ? <img src={streamUrl} alt={file.name} /> : null}
          {type === 'audio' ? <audio src={streamUrl} controls autoPlay={false}>浏览器不支持音频播放。</audio> : null}
          {type === 'video' ? <video src={streamUrl} controls playsInline>浏览器不支持视频播放。</video> : null}
          {type === 'document' && file.mimeType === 'application/pdf' ? (
            <iframe src={streamUrl} title={`${file.name} PDF 预览`} />
          ) : null}
          {isText && !isMarkdown ? (
            <iframe className="text-preview" sandbox="" src={streamUrl} title={`${file.name} 文本预览`} />
          ) : null}
          {isMarkdown && !editorOpen ? (
            <div className="markdown-preview">
              {contentQuery.isPending ? <div className="surface-state"><LoaderCircle className="spin" size={24} />正在读取内容…</div> : null}
              {contentQuery.isError ? <div className="notice notice--error" role="alert">{errorMessage(contentQuery.error)}</div> : null}
              {contentQuery.data ? <pre className="markdown-plain">{contentQuery.data.content}</pre> : null}
            </div>
          ) : null}
          {(type === 'other'
            || (type === 'document' && file.mimeType !== 'application/pdf' && !file.mimeType?.startsWith('text/')))
            ? (
              <div className="preview-fallback">
                <FileQuestion size={48} strokeWidth={1.4} />
                <strong>此格式无法在浏览器中直接预览</strong>
                <span>下载后使用本地应用打开。</span>
              </div>
            ) : null}
        </div>
        <aside className="preview-meta">
          <div className="preview-meta__title"><FileTypeIcon file={file} size={26} /><strong>{file.name}</strong></div>
          <dl>
            <div><dt>类型</dt><dd>{file.mimeType ?? '未知'}</dd></div>
            <div><dt>大小</dt><dd>{formatBytes(file.sizeBytes)}</dd></div>
            <div><dt>修改时间</dt><dd>{formatDate(file.updatedAt)}</dd></div>
            <div><dt>校验值</dt><dd className="hash" title={file.sha256 ?? undefined}>{file.sha256?.slice(0, 16) ?? '—'}</dd></div>
          </dl>
          {canEditMd && isMarkdown ? (
            <button className="button button--secondary button--wide" type="button" onClick={() => setEditorOpen(true)}>编辑 Markdown</button>
          ) : null}
          {canDownload ? (
            <>
              <a className="button button--primary button--wide" href={`/api/files/${file.id}/download`}><Download size={18} />下载文件</a>
              {isMarkdown ? <a className="button button--secondary button--wide" href={fileExportPdfUrl(file.id)}>导出 PDF</a> : null}
            </>
          ) : null}
          <button className="button button--ghost button--wide" type="button" onClick={() => share.mutate()} disabled={share.isPending}>
            <Share2 size={17} />创建 7 天分享
          </button>
        </aside>
      </div>
      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}
    </Modal>
  );
}
