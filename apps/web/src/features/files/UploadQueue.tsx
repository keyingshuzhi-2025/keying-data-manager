import { Check, CircleAlert, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { formatBytes } from '../../utils/format';

export interface UploadTask {
  id: string;
  file: File;
  progress: number;
  status: 'queued' | 'uploading' | 'done' | 'error';
  error?: string;
}

export function UploadQueue({
  tasks,
  onRetry,
  onDismiss,
}: {
  tasks: UploadTask[];
  onRetry: (task: UploadTask) => void;
  onDismiss: () => void;
}) {
  if (tasks.length === 0) return null;
  const active = tasks.some((task) => task.status === 'uploading' || task.status === 'queued');
  return (
    <aside className="upload-queue" aria-label="上传任务">
      <header>
        <div><strong>{active ? '正在上传' : '上传任务'}</strong><span>{tasks.length} 个文件</span></div>
        {!active ? <button type="button" onClick={onDismiss} aria-label="关闭上传列表"><X size={18} /></button> : null}
      </header>
      <div className="upload-queue__items">
        {tasks.map((task) => (
          <div className="upload-task" key={task.id}>
            <div className={`upload-task__status upload-task__status--${task.status}`}>
              {task.status === 'done' ? <Check size={16} /> : null}
              {task.status === 'error' ? <CircleAlert size={16} /> : null}
              {task.status === 'uploading' ? <LoaderCircle className="spin" size={16} /> : null}
              {task.status === 'queued' ? <span /> : null}
            </div>
            <div className="upload-task__content">
              <div><strong title={task.file.name}>{task.file.name}</strong><span>{formatBytes(task.file.size)}</span></div>
              <progress className="progress-track" max={100} value={task.progress} aria-label={`${task.file.name} 上传进度`} />
              {task.error ? <small>{task.error}</small> : null}
            </div>
            {task.status === 'error' ? (
              <button type="button" onClick={() => onRetry(task)} aria-label={`重试 ${task.file.name}`}><RefreshCw size={16} /></button>
            ) : null}
          </div>
        ))}
      </div>
    </aside>
  );
}
