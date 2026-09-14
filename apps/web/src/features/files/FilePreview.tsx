import { Download, FileQuestion } from 'lucide-react';
import { FileTypeIcon } from '../../components/FileTypeIcon';
import { Modal } from '../../components/Modal';
import type { FileRecord } from '../../types';
import { fileTypeOf, formatBytes, formatDate } from '../../utils/format';

export function FilePreview({ file, onClose }: { file: FileRecord; onClose: () => void }) {
  const type = fileTypeOf(file);
  const streamUrl = `/api/files/${file.id}/stream`;
  const downloadUrl = `/api/files/${file.id}/download`;

  return (
    <Modal title={file.name} description="文件预览与属性" onClose={onClose} size="large">
      <div className="preview-layout">
        <div className={`preview-stage preview-stage--${type}`}>
          {type === 'image' ? <img src={streamUrl} alt={file.name} /> : null}
          {type === 'audio' ? <audio src={streamUrl} controls autoPlay={false}>浏览器不支持音频播放。</audio> : null}
          {type === 'video' ? <video src={streamUrl} controls playsInline>浏览器不支持视频播放。</video> : null}
          {type === 'document' && file.mimeType === 'application/pdf' ? (
            <iframe src={streamUrl} title={`${file.name} PDF 预览`} />
          ) : null}
          {type === 'document' && file.mimeType?.startsWith('text/') ? (
            <iframe className="text-preview" sandbox="" src={streamUrl} title={`${file.name} 文本预览`} />
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
          <a className="button button--primary button--wide" href={downloadUrl}><Download size={18} />下载文件</a>
        </aside>
      </div>
    </Modal>
  );
}
