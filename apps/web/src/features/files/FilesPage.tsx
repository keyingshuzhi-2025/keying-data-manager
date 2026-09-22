import {
  useCallback,
  useDeferredValue,
  useEffect,
  useState,
  type DragEvent,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CloudOff,
  FolderLock,
  FolderOpen,
  HardDrive,
  KeyRound,
  LoaderCircle,
  LogOut,
  RefreshCw,
  UploadCloud,
  UserCog,
} from 'lucide-react';
import { ApiError, api, uploadFile } from '../../api/client';
import { Toast, type ToastMessage } from '../../components/Toast';
import { ChangePasswordDialog } from '../auth/ChangePasswordDialog';
import { UserManagementDialog } from '../admin/UserManagementDialog';
import { FolderPermissionsDialog } from './FolderPermissionsDialog';
import { ShareDialog } from '../shares/ShareDialog';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import type { AuthUser, FileRecord, FileType, SortField, SortOrder } from '../../types';
import { errorMessage, formatBytes } from '../../utils/format';
import { generateId } from '../../utils/generateId';
import { Breadcrumbs } from './Breadcrumbs';
import {
  CreateFolderDialog,
  DeleteDialog,
  RenameDialog,
  TransferDialog,
} from './FileDialogs';
import { FileList } from './FileList';
import { FilePreview } from './FilePreview';
import { FileToolbar } from './FileToolbar';
import { UploadQueue, type UploadTask } from './UploadQueue';

type DialogState =
  | { type: 'create' }
  | { type: 'rename'; file: FileRecord }
  | { type: 'move'; file: FileRecord }
  | { type: 'copy'; file: FileRecord }
  | { type: 'delete'; file: FileRecord }
  | null;

interface UploadTaskWithDestination extends UploadTask {
  parentId: string | null;
}

const folderIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function folderFromLocation(): string | null {
  const value = new URL(window.location.href).searchParams.get('folder');
  return value && folderIdPattern.test(value) ? value : null;
}

function initialView(): 'list' | 'grid' {
  try {
    const saved = JSON.parse(localStorage.getItem('lfh:preferences:v1') ?? '{}') as { view?: unknown };
    return saved.view === 'grid' ? 'grid' : 'list';
  } catch {
    return 'list';
  }
}

export function FilesPage({
  user,
  onLogout,
  loggingOut,
}: {
  user: AuthUser;
  onLogout: () => void;
  loggingOut: boolean;
}) {
  const queryClient = useQueryClient();
  const online = useOnlineStatus();
  const [folderId, setFolderId] = useState<string | null>(folderFromLocation);
  const baseCanRead = user.permissions.read;
  const folderAcl = useQuery({
    queryKey: ['folder-permissions', folderId ?? 'ROOT'],
    queryFn: () => api.getFolderPermissions(folderId ?? 'ROOT'),
    enabled: online && baseCanRead,
  });
  const effectivePermissions = user.role === 'admin'
    ? { read: true, download: true, upload: true, edit: true, editMd: true, share: true }
    : (folderAcl.data?.acl.effective ?? {
      read: baseCanRead,
      download: Boolean(user.permissions.download ?? baseCanRead),
      upload: Boolean(user.permissions.upload),
      edit: Boolean(user.permissions.edit),
      editMd: Boolean(user.permissions.editMd),
      share: Boolean(user.permissions.share),
    });
  const canRead = Boolean(effectivePermissions.read);
  const canUpload = Boolean(effectivePermissions.upload);
  const canEdit = Boolean(effectivePermissions.edit);
  const canDownload = Boolean(effectivePermissions.download);
  const canEditMd = Boolean(effectivePermissions.editMd);
  const canShare = Boolean(effectivePermissions.share);
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search.trim());
  const [type, setType] = useState<FileType | ''>('');
  const [sort, setSort] = useState<SortField>('createdAt');
  const [order, setOrder] = useState<SortOrder>('desc');
  const [page, setPage] = useState(1);
  const [view, setView] = useState<'list' | 'grid'>(initialView);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [preview, setPreview] = useState<FileRecord | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [uploadTasks, setUploadTasks] = useState<UploadTaskWithDestination[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [showUserManagement, setShowUserManagement] = useState(false);
  const [showFolderPermissions, setShowFolderPermissions] = useState(false);
  const [shareTarget, setShareTarget] = useState<FileRecord | null>(null);
  const [showChangePassword, setShowChangePassword] = useState(false);

  const showToast = useCallback((text: string, tone: ToastMessage['tone'] = 'success') => {
    setToast({ id: Date.now(), text, tone });
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('lfh:preferences:v1', JSON.stringify({ view }));
    } catch {
      // Preferences are optional when browser storage is unavailable.
    }
  }, [view]);

  useEffect(() => {
    const onPopState = () => {
      setFolderId(folderFromLocation());
      setPage(1);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timeout = window.setTimeout(() => setToast((current) => current?.id === toast.id ? null : current), 4_500);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const files = useQuery({
    queryKey: ['files', folderId, deferredSearch, type, sort, order, page],
    queryFn: () => api.listFiles({
      parentId: folderId,
      q: deferredSearch || undefined,
      type: type || undefined,
      sort,
      order,
      page,
      limit: 100,
    }),
    enabled: online && canRead,
  });
  const path = useQuery({
    queryKey: ['path', folderId],
    queryFn: () => api.getPath(folderId!),
    enabled: online && canRead && Boolean(folderId),
  });

  useEffect(() => {
    if (files.error instanceof ApiError && (files.error.status === 401 || files.error.status === 403)) {
      void queryClient.invalidateQueries({ queryKey: ['session'] });
    }
  }, [files.error, queryClient]);

  const refresh = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['files'] }),
      queryClient.invalidateQueries({ queryKey: ['folder-picker'] }),
      queryClient.invalidateQueries({ queryKey: ['path'] }),
    ]);
  }, [queryClient]);

  const closeWithSuccess = useCallback(async (message: string) => {
    setDialog(null);
    showToast(message);
    await refresh();
  }, [refresh, showToast]);

  const createFolder = useMutation({
    mutationFn: (name: string) => api.createFolder(name, folderId),
    onSuccess: () => closeWithSuccess('文件夹已创建'),
    onError: (error) => showToast(errorMessage(error), 'error'),
  });
  const renameFile = useMutation({
    mutationFn: ({ file, name }: { file: FileRecord; name: string }) => api.updateFile(file.id, { name }),
    onSuccess: () => closeWithSuccess('名称已更新'),
    onError: (error) => showToast(errorMessage(error), 'error'),
  });
  const deleteFile = useMutation({
    mutationFn: (file: FileRecord) => api.deleteFile(file.id),
    onSuccess: () => closeWithSuccess('项目已删除'),
    onError: (error) => showToast(errorMessage(error), 'error'),
  });
  const transferFile = useMutation({
    mutationFn: ({
      mode,
      file,
      parentId,
      name,
    }: {
      mode: 'move' | 'copy';
      file: FileRecord;
      parentId: string | null;
      name?: string;
    }) => mode === 'move'
      ? api.moveFile(file.id, parentId)
      : api.copyFile(file.id, parentId, name),
    onSuccess: (_data, variables) => closeWithSuccess(variables.mode === 'move' ? '项目已移动' : '副本已创建'),
    onError: (error) => showToast(errorMessage(error), 'error'),
  });

  const navigateFolder = useCallback((id: string | null) => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('folder', id);
    else url.searchParams.delete('folder');
    window.history.pushState({}, '', `${url.pathname}${url.search}${url.hash}`);
    setFolderId(id);
    setSearch('');
    setPage(1);
  }, []);

  const openFile = useCallback((file: FileRecord) => {
    if (file.kind === 'folder') navigateFolder(file.id);
    else setPreview(file);
  }, [navigateFolder]);
  const openRename = useCallback((file: FileRecord) => setDialog({ type: 'rename', file }), []);
  const openMove = useCallback((file: FileRecord) => setDialog({ type: 'move', file }), []);
  const openCopy = useCallback((file: FileRecord) => setDialog({ type: 'copy', file }), []);
  const openDelete = useCallback((file: FileRecord) => setDialog({ type: 'delete', file }), []);

  const updateUploadTask = useCallback((id: string, patch: Partial<UploadTaskWithDestination>) => {
    setUploadTasks((current) => current.map((task) => {
      if (task.id !== id) return task;
      if (patch.progress !== undefined && patch.progress === task.progress && Object.keys(patch).length === 1) return task;
      return { ...task, ...patch };
    }));
  }, []);

  const uploadOne = useCallback(async (task: UploadTaskWithDestination) => {
    updateUploadTask(task.id, { status: 'uploading', progress: 0, error: undefined });
    try {
      await uploadFile(task.file, task.parentId, (progress) => updateUploadTask(task.id, { progress: progress.percent }));
      updateUploadTask(task.id, { status: 'done', progress: 100 });
      return true;
    } catch (error) {
      updateUploadTask(task.id, { status: 'error', error: errorMessage(error) });
      return false;
    }
  }, [updateUploadTask]);

  const beginUploads = useCallback(async (selected: File[]) => {
    if (selected.length === 0 || isUploading || !online || !canUpload) return;
    const tasks: UploadTaskWithDestination[] = selected.map((file) => ({
      id: generateId(),
      file,
      parentId: folderId,
      progress: 0,
      status: 'queued',
    }));
    setUploadTasks(tasks);
    setIsUploading(true);
    let failed = 0;
    for (const task of tasks) {
      if (!await uploadOne(task)) failed += 1;
    }
    setIsUploading(false);
    await refresh();
    showToast(
      failed > 0 ? `${tasks.length - failed} 个上传成功，${failed} 个失败` : `${tasks.length} 个文件上传完成`,
      failed > 0 ? 'error' : 'success',
    );
  }, [canUpload, folderId, isUploading, online, refresh, showToast, uploadOne]);

  const retryUpload = useCallback(async (task: UploadTaskWithDestination) => {
    if (isUploading || !online || !canUpload) return;
    setIsUploading(true);
    const succeeded = await uploadOne(task);
    setIsUploading(false);
    if (succeeded) {
      await refresh();
      showToast(`${task.file.name} 上传完成`);
    }
  }, [canUpload, isUploading, online, refresh, showToast, uploadOne]);

  const selectFiles = (selected: File[]) => {
    void beginUploads(selected);
  };

  const dropFiles = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    if (!canUpload) return;
    void beginUploads(Array.from(event.dataTransfer.files));
  };

  const currentItems = files.data?.items ?? [];
  const currentTitle = path.data?.path.at(-1)?.name ?? '全部文件';
  const currentPageBytes = currentItems.reduce((total, file) => total + (file.sizeBytes ?? 0), 0);
  const totalPages = Math.max(1, Math.ceil((files.data?.pagination.total ?? 0) / 100));
  const mutationPending = createFolder.isPending || renameFile.isPending || deleteFile.isPending || transferFile.isPending;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar__brand">
          <div className="brand-mark"><FolderLock size={23} /></div>
          <div><strong>柯影文件站</strong><span>LOCAL FILE HUB</span></div>
        </div>
        <nav className="sidebar__nav" aria-label="主导航">
          <button className="is-active" type="button" onClick={() => navigateFolder(null)}>
            <FolderOpen size={19} /><span>文件库</span>
          </button>
          {user.role === 'admin' ? (
            <button type="button" onClick={() => setShowUserManagement(true)}>
              <UserCog size={19} /><span>用户权限</span>
            </button>
          ) : null}
        </nav>
        <div className="sidebar__node">
          <HardDrive size={18} />
          <div><strong>本地存储节点</strong><span>{online ? '连接正常' : '等待网络'}</span></div>
          <span className={`node-dot ${online ? '' : 'is-offline'}`} />
        </div>
      </aside>

      <main
        className={`workspace ${dragging ? 'is-dragging' : ''}`}
        onDragEnter={(event) => { event.preventDefault(); if (canUpload) setDragging(true); }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={dropFiles}
      >
        {dragging ? (
          <div className="drop-overlay"><UploadCloud size={36} /><strong>松开即可上传</strong><span>文件将保存到“{currentTitle}”</span></div>
        ) : null}

        <header className="topbar">
          <div className="mobile-brand"><div className="brand-mark"><FolderLock size={20} /></div><strong>柯影文件站</strong></div>
          <div className="topbar__spacer" />
          {!online ? <span className="offline-badge"><CloudOff size={15} />离线</span> : null}
          {user.role === 'admin' ? (
            <>
              <button className="button button--secondary topbar-admin-button" type="button" onClick={() => setShowFolderPermissions(true)}>
                <FolderLock size={17} /><span>目录权限</span>
              </button>
              <button className="button button--secondary topbar-admin-button" type="button" onClick={() => setShowUserManagement(true)}>
                <UserCog size={17} /><span>用户权限</span>
              </button>
            </>
          ) : null}
          <div className="user-chip"><span>{user.username.slice(0, 1).toUpperCase()}</span><div><strong>{user.username}</strong><small>{user.role === 'admin' ? '管理员' : '普通用户'}</small></div></div>
          <button className="icon-button" type="button" onClick={() => setShowChangePassword(true)} aria-label="修改密码" title="修改密码">
            <KeyRound size={19} />
          </button>
          <button className="icon-button" type="button" onClick={onLogout} disabled={loggingOut} aria-label="退出登录" title="退出登录">
            {loggingOut ? <LoaderCircle className="spin" size={19} /> : <LogOut size={19} />}
          </button>
        </header>

        <section className="content">
          <div className="content-heading">
            <Breadcrumbs path={path.data?.path ?? []} onNavigate={navigateFolder} />
            <div className="content-heading__title">
              <div><span className="eyebrow">当前目录</span><h1>{currentTitle}</h1></div>
              <div className="folder-summary">
                <span><strong>{files.data?.pagination.total ?? 0}</strong> 个项目</span>
                <span><strong>{formatBytes(currentPageBytes)}</strong> 本页文件</span>
              </div>
            </div>
          </div>

          {!online ? (
            <div className="offline-panel"><CloudOff size={22} /><div><strong>网络已断开</strong><span>应用界面仍可使用；重新连接后刷新文件列表。</span></div></div>
          ) : null}

          {canRead ? (
            <>
              <FileToolbar
                search={search}
                onSearch={(value) => { setSearch(value); setPage(1); }}
                type={type}
                onTypeChange={(value) => { setType(value); setPage(1); }}
                sort={sort}
                onSortChange={(value) => { setSort(value); setPage(1); }}
                order={order}
                onOrderChange={setOrder}
                view={view}
                onViewChange={setView}
                onCreateFolder={() => setDialog({ type: 'create' })}
                onFilesSelected={selectFiles}
                canUpload={canUpload}
                disabled={!online || isUploading}
              />
            </>
          ) : null}

          {!canRead ? (
            <section className="access-panel" aria-live="polite">
              <div className="access-panel__icon"><FolderLock size={30} /></div>
              <span className="eyebrow">等待授权</span>
              <h2>管理员尚未开通文件访问</h2>
              <p>你的账号已创建成功。请联系管理员授予“读取与下载”权限，授权后此页会自动更新。</p>
              <div className="access-panel__account"><span>当前账号</span><strong>{user.username}</strong></div>
            </section>
          ) : (
          <section className="file-surface" aria-live="polite" aria-busy={files.isFetching}>
            {files.isPending && online ? <div className="surface-state"><LoaderCircle className="spin" size={28} /><span>正在读取文件…</span></div> : null}
            {files.isError && online ? (
              <div className="surface-state surface-state--error">
                <strong>文件列表加载失败</strong><span>{errorMessage(files.error)}</span>
                <button className="button button--secondary" type="button" onClick={() => files.refetch()}><RefreshCw size={17} />重试</button>
              </div>
            ) : null}
            {!files.isPending && !files.isError && currentItems.length === 0 ? (
              <div className="surface-state surface-state--empty">
                <div className="empty-illustration"><FolderOpen size={34} /></div>
                <strong>{deferredSearch || type ? '没有找到匹配的项目' : '这个文件夹还是空的'}</strong>
                <span>{deferredSearch || type
                  ? '试试修改搜索词或筛选条件。'
                  : (canUpload ? '拖放文件到这里，或从上方新建文件夹。' : '你拥有读取与下载权限，暂无文件可查看。')}</span>
              </div>
            ) : null}
            {currentItems.length > 0 ? (
              <FileList
                files={currentItems}
                view={view}
                canEdit={canEdit}
                canDownload={canDownload}
                canShare={canShare}
                onOpen={openFile}
                onPreview={setPreview}
                onRename={openRename}
                onMove={openMove}
                onCopy={openCopy}
                onDelete={openDelete}
                onShare={setShareTarget}
              />
            ) : null}
          </section>
          )}

          {totalPages > 1 ? (
            <nav className="pagination" aria-label="文件分页">
              <button type="button" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>上一页</button>
              <span>第 {page} / {totalPages} 页</span>
              <button type="button" disabled={page >= totalPages} onClick={() => setPage((current) => current + 1)}>下一页</button>
            </nav>
          ) : null}
        </section>
      </main>

      {canUpload && dialog?.type === 'create' ? (
        <CreateFolderDialog onClose={() => setDialog(null)} onSubmit={(name) => createFolder.mutate(name)} pending={createFolder.isPending} />
      ) : null}
      {canEdit && dialog?.type === 'rename' ? (
        <RenameDialog file={dialog.file} onClose={() => setDialog(null)} onSubmit={(name) => renameFile.mutate({ file: dialog.file, name })} pending={renameFile.isPending} />
      ) : null}
      {canEdit && dialog?.type === 'delete' ? (
        <DeleteDialog file={dialog.file} onClose={() => setDialog(null)} onConfirm={() => deleteFile.mutate(dialog.file)} pending={deleteFile.isPending} />
      ) : null}
      {canEdit && (dialog?.type === 'move' || dialog?.type === 'copy') ? (
        <TransferDialog
          file={dialog.file}
          mode={dialog.type}
          currentParentId={folderId}
          onClose={() => setDialog(null)}
          onConfirm={(parentId, name) => transferFile.mutate({ mode: dialog.type, file: dialog.file, parentId, name })}
          pending={transferFile.isPending}
        />
      ) : null}
      {preview ? <FilePreview file={preview} onClose={() => setPreview(null)} canDownload={canDownload} canEditMd={canEditMd} canShare={canShare} /> : null}
      {shareTarget ? <ShareDialog file={shareTarget} onClose={() => setShareTarget(null)} /> : null}
      {showFolderPermissions ? <FolderPermissionsDialog folderId={folderId ?? 'ROOT'} onClose={() => setShowFolderPermissions(false)} /> : null}
      {showUserManagement ? <UserManagementDialog currentUser={user} onClose={() => setShowUserManagement(false)} /> : null}
      {showChangePassword ? (
        <ChangePasswordDialog
          onClose={() => setShowChangePassword(false)}
          onChanged={() => {
            setShowChangePassword(false);
            showToast('密码已修改，其他设备已退出登录');
          }}
        />
      ) : null}
      <UploadQueue tasks={uploadTasks} onRetry={(task) => void retryUpload(task as UploadTaskWithDestination)} onDismiss={() => setUploadTasks([])} />
      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}
      {mutationPending ? <span className="sr-only" role="status">正在处理操作</span> : null}
    </div>
  );
}
