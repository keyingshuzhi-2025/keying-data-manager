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
  | 'invite_revoke';

export type ActivityTargetType = 'file' | 'folder' | 'user' | 'invite';

export interface ActivityRecord {
  id: string;
  userId: string;
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
  const rows = db.prepare(
    `SELECT id, user_id, action, target_type, target_name, detail, created_at
     FROM activity_logs
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT ?`,
  ).all(userId, limit) as Array<{
    id: string;
    user_id: string;
    action: ActivityAction;
    target_type: ActivityTargetType | null;
    target_name: string | null;
    detail: string | null;
    created_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    action: row.action,
    targetType: row.target_type,
    targetName: row.target_name,
    detail: row.detail,
    createdAt: row.created_at,
  }));
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
};
