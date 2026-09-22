import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';

export type ActivityAction =
  | 'login'
  | 'register'
  | 'logout'
  | 'change_password'
  | 'reset_password'
  | 'upload'
  | 'download'
  | 'create_folder'
  | 'rename'
  | 'move'
  | 'copy'
  | 'delete'
  | 'create_user'
  | 'enable_user'
  | 'disable_user'
  | 'delete_user'
  | 'role_change'
  | 'invite_create'
  | 'invite_revoke'
  | 'session_revoke'
  | 'sessions_revoke'
  | 'quota_change'
  | 'acl_change'
  | 'md_edit'
  | 'md_export'
  | 'share_create'
  | 'share_update'
  | 'share_revoke'
  | 'share_delete'
  | 'share_access'
  | 'share_download';

export type ActivityTargetType = 'file' | 'folder' | 'user' | 'invite' | 'share';

export interface ActivityRecord {
  id: string;
  userId: string;
  username?: string;
  action: ActivityAction;
  targetType: ActivityTargetType | null;
  targetName: string | null;
  detail: string | null;
  createdAt: string;
}

export interface ActivityInput {
  userId: string;
  action: ActivityAction;
  targetType?: ActivityTargetType;
  targetName?: string;
  detail?: string;
}

export interface ActivityListParams {
  userId?: string;
  action?: string;
  q?: string;
  /** 起始时间（ISO 字符串，含当天起始时刻）；筛选 created_at >= from */
  from?: string;
  /** 截止时间（ISO 字符串）；筛选 created_at <= to */
  to?: string;
  page: number;
  limit: number;
}

export interface ActivityListResult {
  activities: ActivityRecord[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    hasNext: boolean;
  };
}

function mapActivityRow(row: {
  id: string;
  user_id: string;
  username?: string;
  action: ActivityAction;
  target_type: ActivityTargetType | null;
  target_name: string | null;
  detail: string | null;
  created_at: string;
}): ActivityRecord {
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    action: row.action,
    targetType: row.target_type,
    targetName: row.target_name,
    detail: row.detail,
    createdAt: row.created_at,
  };
}

/** 写入一条活动日志（不主动抛错，失败静默，避免影响主流程） */
export function recordActivity(db: Database.Database, input: ActivityInput): void {
  try {
    db.prepare(
      `INSERT INTO activity_logs (id, user_id, action, target_type, target_name, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomBytes(16).toString('hex'),
      input.userId,
      input.action,
      input.targetType ?? null,
      input.targetName ?? null,
      input.detail ?? null,
      new Date().toISOString(),
    );
  } catch {
    // 活动日志记录失败不应阻断业务操作
  }
}

export function listActivityForUser(
  db: Database.Database,
  userId: string,
  limit: number,
): ActivityRecord[] {
  return listActivity(db, { userId, page: 1, limit }).activities;
}

export function listActivity(
  db: Database.Database,
  params: ActivityListParams,
): ActivityListResult {
  const page = Math.max(1, params.page);
  const limit = Math.min(200, Math.max(1, params.limit));
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (params.userId) {
    clauses.push('al.user_id = ?');
    values.push(params.userId);
  }
  if (params.action) {
    clauses.push('al.action = ?');
    values.push(params.action);
  }
  if (params.q?.trim()) {
    const escaped = params.q.trim().replace(/[\\%_]/g, '\\$&');
    const like = `%${escaped}%`;
    clauses.push(`(u.username LIKE ? ESCAPE '\\' OR al.target_name LIKE ? ESCAPE '\\' OR al.detail LIKE ? ESCAPE '\\' OR al.action LIKE ? ESCAPE '\\')`);
    values.push(like, like, like, like);
  }
  if (params.from) {
    clauses.push('al.created_at >= ?');
    values.push(params.from);
  }
  if (params.to) {
    clauses.push('al.created_at <= ?');
    values.push(params.to);
  }

  const from = 'FROM activity_logs al JOIN users u ON u.id = al.user_id';
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS total ${from} ${where}`).get(...values) as { total: number }).total;
  const rows = db.prepare(
    `SELECT al.id, al.user_id, u.username, al.action, al.target_type,
            al.target_name, al.detail, al.created_at
     ${from} ${where}
     ORDER BY al.created_at DESC
     LIMIT ? OFFSET ?`,
  ).all(...values, limit, (page - 1) * limit) as Array<{
    id: string;
    user_id: string;
    username?: string;
    action: ActivityAction;
    target_type: ActivityTargetType | null;
    target_name: string | null;
    detail: string | null;
    created_at: string;
  }>;

  return {
    activities: rows.map(mapActivityRow),
    pagination: {
      page,
      limit,
      total,
      hasNext: page * limit < total,
    },
  };
}

/** 活动动作的中文描述（供前端与详情展示使用） */
export const ACTIVITY_LABELS: Record<ActivityAction, string> = {
  login: '登录',
  register: '注册账号',
  logout: '退出登录',
  change_password: '修改密码',
  reset_password: '重置密码',
  upload: '上传文件',
  download: '下载文件',
  create_folder: '新建文件夹',
  rename: '重命名',
  move: '移动',
  copy: '复制',
  delete: '删除',
  create_user: '创建用户',
  enable_user: '启用账号',
  disable_user: '停用账号',
  delete_user: '删除用户',
  role_change: '变更角色',
  invite_create: '生成邀请',
  invite_revoke: '撤销邀请',
  session_revoke: '强制下线会话',
  sessions_revoke: '强制下线全部会话',
  quota_change: '调整存储配额',
  acl_change: '调整文件夹权限',
  md_edit: '编辑 Markdown',
  md_export: '导出 PDF',
  share_create: '创建分享链接',
  share_update: '更新分享链接',
  share_revoke: '撤销分享链接',
  share_delete: '删除分享链接',
  share_access: '访问分享链接',
  share_download: '下载分享文件',
};
