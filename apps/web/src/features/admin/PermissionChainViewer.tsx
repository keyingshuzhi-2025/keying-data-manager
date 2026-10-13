import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronRight,
  Eye,
  FolderOpen,
  LoaderCircle,
  ShieldCheck,
  ShieldQuestion,
} from 'lucide-react';
import { api } from '../../api/client';
import { Modal } from '../../components/Modal';
import type { PermissionSet } from '../../types';
import { errorMessage } from '../../utils/format';
import { PermissionGrid } from '../common/PermissionCard';
import type { AclHopInfo, FolderAclListEntry, PermissionsHealth } from '../../types';
import './permission-chain.css';

interface PermissionChainViewerProps {
  onClose: () => void;
  initialFolderId?: string;
}

export function PermissionChainViewer({ onClose, initialFolderId = 'ROOT' }: PermissionChainViewerProps) {
  const [selectedUserId, setSelectedUserId] = useState<string>('');
  const [selectedFolderId, setSelectedFolderId] = useState<string>(initialFolderId);
  const [showDetails, setShowDetails] = useState(false);

  const users = useQuery({ queryKey: ['admin-users'], queryFn: api.listUsers });
  const usersData = users.data?.users ?? [];
  const effectiveUserId = selectedUserId || usersData.find((user) => user.role !== 'admin')?.id || '';

  const chainQuery = useQuery({
    queryKey: ['permission-chain', effectiveUserId, selectedFolderId],
    queryFn: () => api.getPermissionChain(effectiveUserId, selectedFolderId),
    enabled: Boolean(effectiveUserId && selectedFolderId),
  });

  const health = useQuery({ queryKey: ['permissions-health'], queryFn: api.getPermissionsHealth });
  const acls = useQuery({ queryKey: ['permissions-all'], queryFn: api.getFolderAcls });

  const chain = chainQuery.data?.chain;

  return (
    <Modal
      title="权限链与 ACL 总览"
      description="管理员视图：逐跳展示目录链上的显式 ACL、命中点与生效权限，并给出配置健康检查。"
      onClose={onClose}
      size="xlarge"
    >
      <div className="permission-chain-viewer">
        <section className="chain-viewer__controls">
          <div className="chain-viewer__field">
            <label>查看用户</label>
            <select
              value={effectiveUserId}
              onChange={(e) => setSelectedUserId(e.target.value)}
              disabled={users.isPending}
            >
              <option value="">— 选择用户 —</option>
              {usersData.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.username} ({u.role})
                </option>
              ))}
            </select>
          </div>
          <div className="chain-viewer__field">
            <label>目标条目</label>
            <select
              value={selectedFolderId}
              onChange={(e) => setSelectedFolderId(e.target.value)}
            >
              <option value="ROOT">根目录（默认策略）</option>
              {initialFolderId !== 'ROOT' && !acls.data?.acls.some((a) => a.folderId === initialFolderId) ? (
                <option value={initialFolderId}>{initialFolderId}</option>
              ) : null}
              {[...new Map((acls.data?.acls ?? []).filter((a) => a.folderId !== 'ROOT').map((a) => [a.folderId, a])).values()]
                .map((a) => <option key={a.folderId} value={a.folderId}>{a.name}</option>)}
            </select>
          </div>
          <div className="chain-viewer__field chain-viewer__field--actions">
            <button
              className="button button--secondary"
              type="button"
              onClick={() => {
                setSelectedUserId('');
                setSelectedFolderId('ROOT');
              }}
              disabled={chainQuery.isPending}
            >
              重置
            </button>
            <button
              className="button button--primary"
              type="button"
              onClick={() => setShowDetails(Boolean(chain))}
              disabled={!effectiveUserId || chainQuery.isPending || !chain}
            >
              {chainQuery.isPending ? <LoaderCircle className="spin" size={16} /> : <Eye size={16} />}
              查看权限链
            </button>
          </div>
        </section>

        {chainQuery.isError ? (
          <div className="notice notice--error" role="alert">
            <span>{errorMessage(chainQuery.error)}</span>
            <button className="button button--secondary" type="button" onClick={() => void chainQuery.refetch()}>
              重试
            </button>
          </div>
        ) : null}

        <section className="chain-viewer__panel">
          <h3 className="chain-viewer__heading">
            <ShieldCheck size={18} /> 配置健康检查
          </h3>
          {health.isPending ? (
            <div className="surface-state"><LoaderCircle className="spin" size={24} /><span>正在读取健康状态…</span></div>
          ) : health.isError ? (
            <div className="notice notice--error" role="alert">{errorMessage(health.error)}</div>
          ) : health.data ? (
            <HealthReport health={health.data} />
          ) : null}
        </section>

        <section className="chain-viewer__panel">
          <h3 className="chain-viewer__heading">
            <FolderOpen size={18} /> 所有已配置 ACL
          </h3>
          {acls.isPending ? (
            <div className="surface-state"><LoaderCircle className="spin" size={24} /><span>正在读取 ACL…</span></div>
          ) : acls.isError ? (
            <div className="notice notice--error" role="alert">{errorMessage(acls.error)}</div>
          ) : acls.data ? (
            <AclListTable entries={acls.data.acls} rowCount={acls.data.totalCount} />
          ) : null}
        </section>
      </div>

      {showDetails && chain ? (
        <PermissionChainDetails
          chain={chain}
          onClose={() => setShowDetails(false)}
        />
      ) : null}

    </Modal>
  );
}

export function HealthReport({ health }: { health: PermissionsHealth }) {
  return (
    <div className="health-report">
      <div className="health-report__status">
        <span className={`status-pill ${health.ok ? 'status-pill--enabled' : 'status-pill--danger'}`}>
          {health.ok ? '健康' : '存在严重问题'}
        </span>
        <span>ACL 表版本 {health.tableVersion} · {health.aclRowCount} 条记录</span>
        {health.tableExists ? (
          <span>ROOT 模式：{health.rootMode === 'open' ? '账号基线范围内开放' : health.rootMode === 'tighten' ? '仅读 + 下载（受账号基线约束）' : '未知'}</span>
        ) : null}
      </div>
      {health.findings.length === 0 ? (
        <div className="notice notice--success">所有检查项通过，权限配置完整且一致。</div>
      ) : (
        <ul className="health-report__findings">
          {health.findings.map((f) => (
            <li key={f.code} className={`health-report__finding health-report__finding--${f.severity}`}>
              <strong>[{f.code}]</strong>{' '}
              <span className="health-report__severity">{f.severity.toUpperCase()}</span>{' '}
              <span>{f.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AclListTable({ entries, rowCount }: { entries: FolderAclListEntry[]; rowCount: number }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <div className="acl-list-table">
      <div className="acl-list-table__header">
        <span className="acl-list-table__col acl-list-table__col--name">ACL 条目 / 员工</span>
        <span className="acl-list-table__col acl-list-table__col--perms">权限</span>
        <span className="acl-list-table__col acl-list-table__col--meta">最后修改</span>
      </div>
      {entries.length === 0 ? (
        <div className="surface-state surface-state--empty">
          <span>尚未配置任何 ACL（迁移完成后会自动预置 ROOT 默认策略）。</span>
        </div>
      ) : (
        <>
          {entries.map((entry) => {
            const rowKey = `${entry.userId ?? 'global'}:${entry.folderId}`;
            const isExpanded = expanded === rowKey;
            return (
              <div key={rowKey} className={`acl-list-table__row ${isExpanded ? 'is-expanded' : ''}`}>
                <span className="acl-list-table__cell acl-list-table__cell--name">
                  <span className="acl-list-table__name">{entry.name}</span>
                  {entry.username ? <span className="acl-list-table__tag">{entry.username}</span> : null}
                  {entry.folderId === 'ROOT' && (
                    <span className="acl-list-table__tag acl-list-table__tag--info">默认策略</span>
                  )}
                </span>
                <span className="acl-list-table__cell acl-list-table__cell--perms">
                  <PermissionGrid
                    permissions={entry.permissions}
                    onChange={() => {}}
                    disabled
                    clickable={false}
                  />
                </span>
                <span className="acl-list-table__cell acl-list-table__cell--meta">
                  {entry.updatedAt
                    ? `由 ${entry.updatedBy ?? '迁移'} 于 ${new Date(entry.updatedAt).toLocaleString('zh-CN')}`
                    : '迁移时预置'}
                </span>
                <button
                  className="icon-button acl-list-table__expand"
                  type="button"
                  onClick={() => setExpanded(isExpanded ? null : rowKey)}
                  title={isExpanded ? '收起' : '详情'}
                  aria-expanded={isExpanded}
                >
                  <ChevronRight size={14} className={isExpanded ? 'spin' : ''} />
                </button>
              </div>
            );
          })}
          {rowCount > entries.length ? (
            <div className="acl-list-table__footer">
              共 {rowCount} 条，显示前 {entries.length} 条
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

export function PermissionChainDetails({ chain, onClose }: {
  chain: { hops: AclHopInfo[]; effective: PermissionSet; source: string; folderId: string | null };
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(chain.hops[0]?.folderId ?? null);

  return (
    <Modal title="权限链详情" description={`用户基线权限来源：${chain.source}`} onClose={onClose} size="large">
      <div className="permission-chain-details">
        <div className="chain-details__effective">
          <h4>生效权限（最终命中）</h4>
          <PermissionGrid permissions={chain.effective} onChange={() => {}} disabled />
          <small className="chain-details__effective-source">
            命中来源：{chain.source === 'admin' ? '管理员绕过' : chain.source === 'item' ? '员工条目 ACL' : chain.source === 'root' ? '根目录默认策略' : chain.source === 'folder' ? '最近显式 ACL' : '用户全局遗留权限（迁移过渡）'}
            {chain.folderId ? `（${chain.folderId === 'ROOT' ? '根目录' : chain.folderId}）` : ''}
          </small>
        </div>

        <div className="chain-details__chain">
          <h4>权限链（从目标目录到根目录）</h4>
          {chain.hops.map((hop, idx) => {
            const isExpanded = expanded === hop.folderId;
            return (
              <div key={hop.folderId} className={`chain-details__hop ${hop.isEffective ? 'is-effective' : ''} ${isExpanded ? 'is-expanded' : ''}`}>
                <div className="chain-details__hop-head" onClick={() => setExpanded(isExpanded ? null : hop.folderId)}>
                  <span className="chain-details__jump">{idx + 1}</span>
                  <span className="chain-details__name">
                    {hop.name}
                    {hop.folderId === 'ROOT' && <span className="chain-details__tag">默认策略</span>}
                  </span>
                  {hop.parentId && hop.parentId !== 'ROOT' && (
                    <span className="chain-details__parent">← 继承自 {hop.parentId.slice(0, 8)}…</span>
                  )}
                  {hop.inheritedFromNearby && <span className="chain-details__inher">继承自更近的 ACL</span>}
                  {hop.inheritedFromRoot && <span className="chain-details__inher">继承自 ROOT</span>}
                  {hop.isEffective && <span className="chain-details__flag is-effective-flag">● 命中点</span>}
                </div>
                {isExpanded && (
                  <div className="chain-details__hop-body">
                    {hop.configured ? (
                      <>
                        <strong>本跳显式配置：</strong>
                        <PermissionGrid permissions={hop.configured} onChange={() => {}} disabled clickable={false} />
                      </>
                    ) : (
                      <span className="chain-details__none">
                        <ShieldQuestion size={14} /> 本跳未配置（继承上级）
                      </span>
                    )}
                    <small className="chain-details__configured-source">
                      配置来源：{hop.configuredSource === 'item' ? '员工条目 ACL' : hop.configuredSource === 'root' ? '根目录默认策略' : hop.configuredSource === 'folder' ? '本条目显式配置' : '无'}
                    </small>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="user-create-form__footer">
        <button className="button button--primary" type="button" onClick={onClose}>关闭</button>
      </div>
    </Modal>
  );
}
