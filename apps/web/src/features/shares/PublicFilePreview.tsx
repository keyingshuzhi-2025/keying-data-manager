import { Download, FileQuestion } from 'lucide-react';
import { publicShareDownloadUrl, publicShareStreamUrl } from '../../api/client';
import { FileTypeIcon } from '../../components/FileTypeIcon';
import { Modal } from '../../components/Modal';
import { fileTypeOf, formatBytes } from '../../utils/format';
import { publicTargetUrl, toFileRecord } from './utils';
import type { ShareTreeNode } from '../../types';
import './shares.css';

/**
 * 匿名公开分享的单项预览（文件夹分享子树内的文件）。
 * 与站内 FilePreview 保持一致的外观（复用全局 preview-* 样式），
 * 数据源为公开接口 /api/public/shares/:token/stream|download（按相对路径定位）。
 */
export function PublicFilePreview({
  node,
  token,
  onClose,
}: {
  node: ShareTreeNode;
  token: string;
  onClose: () => void;
}) {
  const type = fileTypeOf(node);
  const streamUrl = publicTargetUrl(publicShareStreamUrl(token), node);
  const downloadUrl = publicTargetUrl(publicShareDownloadUrl(token), node);

  return (
    <Modal title={node.name} description="匿名只读预览" onClose={onClose} size="large">
      <div className="preview-layout">
        <div className={`preview-stage preview-stage--${type}`}>
          {type === 'image' ? <img src={streamUrl} alt={node.name} /> : null}
          {type === 'audio' ? <audio src={streamUrl} controls autoPlay={false}>浏览器不支持音频播放。</audio> : null}
          {type === 'video' ? <video src={streamUrl} controls playsInline>浏览器不支持视频播放。</video> : null}
          {type === 'document' && node.mimeType === 'application/pdf' ? (
            <iframe src={streamUrl} title={`${node.name} PDF 预览`} />
          ) : null}
          {type === 'document' && node.mimeType?.startsWith('text/') ? (
            <iframe className="text-preview" sandbox="" src={streamUrl} title={`${node.name} 文本预览`} />
          ) : null}
          {(type === 'other'
            || (type === 'document' && node.mimeType !== 'application/pdf' && !node.mimeType?.startsWith('text/')))
            ? (
              <div className="preview-fallback">
                <FileQuestion size={48} strokeWidth={1.4} />
                <strong>此格式无法在浏览器中直接预览</strong>
                <span>下载后使用本地应用打开。</span>
              </div>
            ) : null}
        </div>
        <aside className="preview-meta">
          <div className="preview-meta__title">
            <FileTypeIcon file={toFileRecord(node)} size={26} />
            <strong>{node.name}</strong>
          </div>
          <dl>
            <div><dt>类型</dt><dd>{node.mimeType ?? '未知'}</dd></div>
            <div><dt>大小</dt><dd>{formatBytes(node.sizeBytes)}</dd></div>
            <div><dt>所在目录</dt><dd>{node.path.slice(0, node.path.lastIndexOf('/')) || '分享根目录'}</dd></div>
          </dl>
          <a className="button button--primary button--wide" href={downloadUrl}>
            <Download size={18} />下载文件
          </a>
        </aside>
      </div>
    </Modal>
  );
}
