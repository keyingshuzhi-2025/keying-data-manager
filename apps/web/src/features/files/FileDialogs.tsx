import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Folder, Home, LoaderCircle } from 'lucide-react';
import { api } from '../../api/client';
import { Modal } from '../../components/Modal';
import type { FileRecord } from '../../types';

interface FormDialogProps {
  onClose: () => void;
  onSubmit: (name: string) => void;
  pending: boolean;
}

export function CreateFolderDialog({ onClose, onSubmit, pending }: FormDialogProps) {
  const [name, setName] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim()) onSubmit(name.trim());
  };
  return (
    <Modal title="新建文件夹" description="文件夹将创建在当前目录中。" onClose={onClose} size="small">
      <form className="dialog-form" onSubmit={submit}>
        <label className="field">
          <span>文件夹名称</span>
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={240} autoFocus required />
        </label>
        <div className="dialog-actions">
          <button className="button button--ghost" type="button" onClick={onClose}>取消</button>
          <button className="button button--primary" type="submit" disabled={pending || !name.trim()}>
            {pending ? <LoaderCircle className="spin" size={17} /> : null}创建
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function RenameDialog({ file, onClose, onSubmit, pending }: FormDialogProps & { file: FileRecord }) {
  const [name, setName] = useState(file.name);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() && name.trim() !== file.name) onSubmit(name.trim());
  };
  return (
    <Modal title="重命名" description={`为“${file.name}”输入一个新名称。`} onClose={onClose} size="small">
      <form className="dialog-form" onSubmit={submit}>
        <label className="field">
          <span>新名称</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={240}
            autoFocus
            required
            onFocus={(event) => {
              const dot = file.kind === 'file' ? event.currentTarget.value.lastIndexOf('.') : -1;
              event.currentTarget.setSelectionRange(0, dot > 0 ? dot : event.currentTarget.value.length);
            }}
          />
        </label>
        <div className="dialog-actions">
          <button className="button button--ghost" type="button" onClick={onClose}>取消</button>
          <button className="button button--primary" type="submit" disabled={pending || !name.trim() || name.trim() === file.name}>
            {pending ? <LoaderCircle className="spin" size={17} /> : null}保存
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function DeleteDialog({
  file,
  onClose,
  onConfirm,
  pending,
}: {
  file: FileRecord;
  onClose: () => void;
  onConfirm: () => void;
  pending: boolean;
}) {
  return (
    <Modal title="确认删除" description="此操作会从文件列表中移除项目。" onClose={onClose} size="small">
      <div className="delete-confirmation">
        <p>确定删除<strong>“{file.name}”</strong>吗？</p>
        {file.kind === 'folder' ? <p className="muted">仅空文件夹可以删除。</p> : null}
        <div className="dialog-actions">
          <button className="button button--ghost" type="button" onClick={onClose}>取消</button>
          <button className="button button--danger" type="button" onClick={onConfirm} disabled={pending}>
            {pending ? <LoaderCircle className="spin" size={17} /> : null}删除
          </button>
        </div>
      </div>
    </Modal>
  );
}

function FolderPicker({
  browserId,
  onBrowse,
}: {
  browserId: string | null;
  onBrowse: (id: string | null) => void;
}) {
  const folders = useQuery({
    queryKey: ['folder-picker', browserId],
    queryFn: () => api.listFiles({ parentId: browserId, type: 'folder', sort: 'name', order: 'asc', limit: 200 }),
  });
  const path = useQuery({
    queryKey: ['path', browserId],
    queryFn: () => api.getPath(browserId!),
    enabled: Boolean(browserId),
  });

  return (
    <div className="folder-picker">
      <nav className="folder-picker__path" aria-label="目标目录">
        <button type="button" onClick={() => onBrowse(null)} title="根目录"><Home size={16} />全部文件</button>
        {path.data?.path.map((item) => (
          <span key={item.id}><ChevronRight size={14} /><button type="button" onClick={() => onBrowse(item.id)}>{item.name}</button></span>
        ))}
      </nav>
      <div className="folder-picker__list">
        {folders.isPending ? <div className="inline-loading"><LoaderCircle className="spin" size={18} />载入目录…</div> : null}
        {folders.isError ? <p className="notice notice--error">无法读取目录</p> : null}
        {folders.data?.items.length === 0 ? <p className="folder-picker__empty">这里没有子文件夹</p> : null}
        {folders.data?.items.map((folder) => (
          <button type="button" key={folder.id} onClick={() => onBrowse(folder.id)}>
            <Folder size={19} /><span>{folder.name}</span><ChevronRight size={16} />
          </button>
        ))}
      </div>
    </div>
  );
}

export function TransferDialog({
  file,
  mode,
  currentParentId,
  onClose,
  onConfirm,
  pending,
}: {
  file: FileRecord;
  mode: 'move' | 'copy';
  currentParentId: string | null;
  onClose: () => void;
  onConfirm: (parentId: string | null, name?: string) => void;
  pending: boolean;
}) {
  const [browserId, setBrowserId] = useState<string | null>(currentParentId);
  const isCopy = mode === 'copy';
  const [name, setName] = useState(() => {
    if (!isCopy) return file.name;
    const dot = file.kind === 'file' ? file.name.lastIndexOf('.') : -1;
    return dot > 0
      ? `${file.name.slice(0, dot)} - 副本${file.name.slice(dot)}`
      : `${file.name} - 副本`;
  });

  return (
    <Modal
      title={isCopy ? '复制项目' : '移动项目'}
      description={`选择“${file.name}”的目标目录。`}
      onClose={onClose}
      size="medium"
    >
      <div className="dialog-form">
        {isCopy ? (
          <label className="field">
            <span>副本名称</span>
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={240} required />
          </label>
        ) : null}
        <FolderPicker browserId={browserId} onBrowse={setBrowserId} />
        <div className="destination-summary">
          <span>当前目标</span><strong>{browserId ? '所选文件夹' : '全部文件（根目录）'}</strong>
        </div>
        <div className="dialog-actions">
          <button className="button button--ghost" type="button" onClick={onClose}>取消</button>
          <button
            className="button button--primary"
            type="button"
            onClick={() => onConfirm(browserId, isCopy ? name.trim() : undefined)}
            disabled={pending || (isCopy && !name.trim())}
          >
            {pending ? <LoaderCircle className="spin" size={17} /> : null}{isCopy ? '复制到这里' : '移动到这里'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
