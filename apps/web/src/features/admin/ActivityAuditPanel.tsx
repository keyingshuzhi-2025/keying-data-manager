import { useDeferredValue, useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Activity, Download, LoaderCircle, RefreshCw, Search } from 'lucide-react';
import { api } from '../../api/client';
import { Toast } from '../../components/Toast';
import { ACTIVITY_LABELS } from '../../utils/activityLabels';
import { errorMessage, formatDate } from '../../utils/format';
import type { ActivityListParams } from '../../types';
import { usePanelToast } from './usePanelToast';

const PAGE_SIZE = 20;

/** utils/activityLabels 尚未收录的动作（与 apps/server/src/activity-log.ts 对齐） */
const EXTRA_ACTIVITY_LABELS: Record<string, string> = {
  session_revoke: '强制下线会话',
  sessions_revoke: '强制下线全部会话',
  quota_change: '调整存储配额',
};

/** 审计筛选下拉的动作选项（按中文文案排序） */
const ACTIVITY_ACTION_OPTIONS: Array<{ value: string; label: string }> = Object
  .entries({ ...ACTIVITY_LABELS, ...EXTRA_ACTIVITY_LABELS })
  .sort((a, b) => a[1].localeCompare(b[1], 'zh-CN'))
  .map(([value, label]) => ({ value, label }));

function activityLabel(action: string): string {
  return ACTIVITY_LABELS[action] ?? EXTRA_ACTIVITY_LABELS[action] ?? action;
}

function dayStartIso(date: string): string {
  return new Date(`${date}T00:00:00`).toISOString();
}

function dayEndIso(date: string): string {
  return new Date(`${date}T23:59:59.999`).toISOString();
}

function downloadCsv(filename: string, csv: string): void {
  // \uFEFF BOM：让 Excel 以 UTF-8 正确识别中文
  const blob = new Blob([csv.startsWith('\uFEFF') ? csv : `\uFEFF${csv}`], {
    type: 'text/csv;charset=utf-8;',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  link.download = filename || `activity-audit-${stamp}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * 全局活动审计面板：用户 / 操作 / 日期 / 关键词筛选 + 分页 + CSV 导出。
 * 使用 api.listActivity（GET /api/admin/activity）与
 * api.exportActivityCsv（GET /api/admin/activity/export，服务端生成 CSV）。
 * 通常作为“用户与权限”对话框中的一个标签页挂载。
 */
export function ActivityAuditPanel() {
  const { toast, showToast, dismissToast } = usePanelToast();
  const [userId, setUserId] = useState('');
  const [action, setAction] = useState('');
  const [keyword, setKeyword] = useState('');
  const deferredKeyword = useDeferredValue(keyword.trim());
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);

  // 用户下拉选项复用现有接口
  const users = useQuery({
    queryKey: ['admin-users'],
    queryFn: api.listUsers,
    staleTime: 60_000,
  });

  const filters: ActivityListParams = {
    userId: userId || undefined,
    action: action || undefined,
    q: deferredKeyword || undefined,
    from: from ? dayStartIso(from) : undefined,
    to: to ? dayEndIso(to) : undefined,
  };

  const logs = useQuery({
    queryKey: ['admin-activity', filters, page],
    queryFn: () => api.listActivity({ ...filters, page, limit: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });

  const totalPages = Math.max(1, Math.ceil((logs.data?.pagination.total ?? 0) / PAGE_SIZE));

  // 筛选后总页数变小时，将页码收敛到有效范围
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const resetFilters = () => {
    setKeyword('');
    setUserId('');
    setAction('');
    setFrom('');
    setTo('');
    setPage(1);
  };

  const exportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const csv = await api.exportActivityCsv(filters);
      downloadCsv(`activity-audit-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}.csv`, csv);
      showToast('活动记录已导出为 CSV');
    } catch (error) {
      showToast(errorMessage(error), 'error');
    } finally {
      setExporting(false);
    }
  };

  const currentCount = logs.data?.activities.length ?? 0;

  return (
    <div className="activity-audit-panel">
      <div className="user-management__toolbar">
        <label className="search-field">
          <Search size={16} />
          <input
            type="search"
            value={keyword}
            onChange={(event) => { setKeyword(event.target.value); setPage(1); }}
            placeholder="搜索用户名 / 对象 / 详情"
            aria-label="搜索活动记录"
          />
        </label>
        <select
          className="select-field"
          value={userId}
          onChange={(event) => { setUserId(event.target.value); setPage(1); }}
          aria-label="按用户筛选"
        >
          <option value="">全部用户</option>
          {users.data?.users.map((user) => (
            <option key={user.id} value={user.id}>{user.username}</option>
          ))}
        </select>
        <select
          className="select-field"
          value={action}
          onChange={(event) => { setAction(event.target.value); setPage(1); }}
          aria-label="按操作筛选"
        >
          <option value="">全部操作</option>
          {ACTIVITY_ACTION_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <label className="field audit-filter-date">
          <span>起始日期</span>
          <input
            type="date"
            value={from}
            max={to || undefined}
            onChange={(event) => { setFrom(event.target.value); setPage(1); }}
            aria-label="起始日期"
          />
        </label>
        <label className="field audit-filter-date">
          <span>结束日期</span>
          <input
            type="date"
            value={to}
            min={from || undefined}
            onChange={(event) => { setTo(event.target.value); setPage(1); }}
            aria-label="结束日期"
          />
        </label>
        <button
          className="button button--secondary"
          type="button"
          onClick={resetFilters}
          title="清除所有筛选条件"
        >
          <RefreshCw size={16} /> 重置筛选
        </button>
        <button
          className="button button--primary"
          type="button"
          onClick={() => void exportCsv()}
          disabled={exporting}
        >
          {exporting ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}
          {exporting ? '导出中…' : '导出 CSV'}
        </button>
      </div>

      {logs.isError ? (
        <div className="notice notice--error" role="alert">
          <span>{errorMessage(logs.error)}</span>
          <button className="button button--secondary" type="button" onClick={() => logs.refetch()}>重试</button>
        </div>
      ) : null}

      {logs.isPending ? (
        <div className="surface-state audit-state">
          <LoaderCircle className="spin" size={24} />
          <span>正在读取活动记录…</span>
        </div>
      ) : null}

      {!logs.isPending && !logs.isError && currentCount === 0 ? (
        <div className="surface-state surface-state--empty audit-state">
          <Activity size={26} />
          <strong>没有匹配的记录</strong>
          <span>调整用户、操作、日期或搜索条件后再试。</span>
        </div>
      ) : null}

      {logs.data && logs.data.activities.length > 0 ? (
        <>
          <div className="audit-table-wrap">
            <table className="audit-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>用户</th>
                  <th>操作</th>
                  <th>对象</th>
                  <th>详情</th>
                </tr>
              </thead>
              <tbody>
                {logs.data.activities.map((record) => (
                  <tr key={record.id}>
                    <td><time dateTime={record.createdAt}>{formatDate(record.createdAt)}</time></td>
                    <td>{record.username ?? record.userId}</td>
                    <td><strong>{activityLabel(record.action)}</strong></td>
                    <td>{record.targetName ?? '—'}</td>
                    <td className="audit-table__detail">{record.detail ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <nav className="pagination" aria-label="活动记录分页">
            <button type="button" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>上一页</button>
            <span>第 {logs.data.pagination.page} / {totalPages} 页 · 共 {logs.data.pagination.total} 条</span>
            <button type="button" disabled={!logs.data.pagination.hasNext} onClick={() => setPage((current) => current + 1)}>下一页</button>
          </nav>
        </>
      ) : null}

      {toast ? <Toast message={toast} onDismiss={dismissToast} /> : null}
    </div>
  );
}
