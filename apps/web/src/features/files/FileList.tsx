import { memo } from 'react';
import {
  Copy,
  Download,
  Eye,
  FolderInput,
  Pencil,
  Share2,
  Trash2,
} from 'lucide-react';
import { FileTypeIcon } from '../../components/FileTypeIcon';
import type { FileRecord } from '../../types';
import { formatBytes, formatDate } from '../../utils/format';

interface FileListProps {
  files: FileRecord[];
  view: 'list' | 'grid';
  canEdit: boolean;
  canDownload: boolean;
  canShare: boolean;
  onOpen: (file: FileRecord) => void;
  onPreview: (file: FileRecord) => void;
  onRename: (file: FileRecord) => void;
  onMove: (file: FileRecord) => void;
  onCopy: (file: FileRecord) => void;
  onDelete: (file: FileRecord) => void;
  onShare: (file: FileRecord) => void;
}

interface ActionsProps extends Omit<FileListProps, 'files' | 'view' | 'onOpen'> {
  file: FileRecord;
}

function FileActions({
  file,
  canEdit,
  canDownload,
  canShare,
  onPreview,
  onRename,
  onMove,
  onCopy,
  onDelete,
  onShare,
}: ActionsProps) {
  return (
    <div
      className="file-actions"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {file.kind === 'file' ? (
        <>
          <button type="button" onClick={() => onPreview(file)} aria-label={`预览 ${file.name}`} title="预览">
            <Eye size={17} />
          </button>
          {canDownload ? (
            <a href={`/api/files/${file.id}/download`} aria-label={`下载 ${file.name}`} title="下载">
              <Download size={17} />
            </a>
          ) : null}
        </>
      ) : null}
      {canShare ? (
        <button type="button" onClick={() => onShare(file)} aria-label={`分享 ${file.name}`} title="分享">
          <Share2 size={17} />
        </button>
      ) : null}
      {canEdit ? (
        <>
          <button type="button" onClick={() => onRename(file)} aria-label={`重命名 ${file.name}`} title="重命名">
            <Pencil size={16} />
          </button>
          <button type="button" onClick={() => onMove(file)} aria-label={`移动 ${file.name}`} title="移动">
            <FolderInput size={17} />
          </button>
          <button type="button" onClick={() => onCopy(file)} aria-label={`复制 ${file.name}`} title="复制">
            <Copy size={16} />
          </button>
          <button className="danger-action" type="button" onClick={() => onDelete(file)} aria-label={`删除 ${file.name}`} title="删除">
            <Trash2 size={16} />
          </button>
        </>
      ) : null}
    </div>
  );
}

function fileSubtitle(file: FileRecord): string {
  if (file.kind === 'folder') return '文件夹';
  return [file.extension?.toUpperCase(), formatBytes(file.sizeBytes)].filter(Boolean).join(' · ');
}

export const FileList = memo(function FileList(props: FileListProps) {
  if (props.view === 'grid') {
    return (
      <div className="file-grid">
        {props.files.map((file) => (
          <article
            className="file-card"
            key={file.id}
            onDoubleClick={() => props.onOpen(file)}
          >
            <button className="file-card__main" type="button" onClick={() => props.onOpen(file)}>
              <FileTypeIcon file={file} size={30} />
              <span className="file-card__name" title={file.name}>{file.name}</span>
              <span className="file-card__meta">{fileSubtitle(file)}</span>
            </button>
            <div className="file-card__footer">
              <span>{formatDate(file.updatedAt)}</span>
              <FileActions {...props} file={file} />
            </div>
          </article>
        ))}
      </div>
    );
  }

  return (
    <div className="file-table-wrap">
      <table className="file-table">
        <thead>
          <tr><th>名称</th><th>大小</th><th>修改时间</th><th><span className="sr-only">操作</span></th></tr>
        </thead>
        <tbody>
          {props.files.map((file) => (
            <tr key={file.id} onDoubleClick={() => props.onOpen(file)}>
              <td>
                <button className="file-name-button" type="button" onClick={() => props.onOpen(file)}>
                  <FileTypeIcon file={file} />
                  <span>
                    <strong title={file.name}>{file.name}</strong>
                    <small>{file.kind === 'folder' ? '文件夹' : file.mimeType ?? '未知类型'}</small>
                  </span>
                </button>
              </td>
              <td>{file.kind === 'folder' ? '—' : formatBytes(file.sizeBytes)}</td>
              <td>{formatDate(file.updatedAt)}</td>
              <td><FileActions {...props} file={file} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});
