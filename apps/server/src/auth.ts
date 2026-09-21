import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import Database from 'better-sqlite3';
import type { AppConfig } from './config.js';
import { forbidden, unauthorized } from './errors.js';
import type { AuthUser, UserPermission } from './types.js';

export const SESSION_COOKIE_NAME = 'lfh_session';

export interface UserRow {
  id: string;
  username: string;
  role: 'admin' | 'user';
  is_enabled: number;
  can_read: number;
  can_upload: number;
  can_edit: number;
  storage_quota_bytes: number;
  created_at: string;
  last_login_at: string | null;
}

export interface AuthenticatedRequest extends FastifyRequest {
  user?: AuthUser;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 对外暴露：按会话令牌生成库中存储的哈希（用于外部查询/删除） */
export function hashSessionToken(token: string): string {
  return hashToken(token);
}

export function mapUser(row: UserRow): AuthUser {
  const isAdmin = row.role === 'admin';
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    isEnabled: Boolean(row.is_enabled),
    permissions: {
      read: isAdmin || Boolean(row.can_read),
      upload: isAdmin || Boolean(row.can_upload),
      edit: isAdmin || Boolean(row.can_edit),
    },
    storageQuotaBytes: row.storage_quota_bytes,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

/** 更新指定用户的最后登录时间为当前时刻 */
export function recordLastLogin(db: Database.Database, userId: string): void {
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    userId,
  );
}

/** Store a salted scrypt password hash in a portable text format. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const [algorithm, salt, expectedHex] = encoded.split('$');
  if (algorithm !== 'scrypt' || !salt || !expectedHex) return false;

  try {
    const expected = Buffer.from(expectedHex, 'hex');
    const actual = scryptSync(password, salt, expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function initializeAdmin(db: Database.Database, config: AppConfig): AuthUser {
  const existing = db.prepare(
    `SELECT id, username, role, is_enabled, can_read, can_upload, can_edit, storage_quota_bytes, created_at, last_login_at
     FROM users WHERE username = ? COLLATE NOCASE LIMIT 1`,
  ).get(config.adminUsername) as UserRow | undefined;
  if (existing) {
    db.prepare(
      `UPDATE users
       SET role = 'admin', is_enabled = 1, can_read = 1, can_upload = 1, can_edit = 1
       WHERE id = ?`,
    ).run(existing.id);
    return mapUser({
      ...existing,
      role: 'admin',
      is_enabled: 1,
      can_read: 1,
      can_upload: 1,
      can_edit: 1,
    });
  }

  const now = new Date().toISOString();
  const id = randomBytes(16).toString('hex');
  db.prepare(
    `INSERT INTO users
      (id, username, password_hash, role, is_enabled, can_read, can_upload, can_edit, created_at)
     VALUES (?, ?, ?, 'admin', 1, 1, 1, 1, ?)`,
  ).run(id, config.adminUsername, hashPassword(config.adminPassword), now);

  return mapUser({
    id,
    username: config.adminUsername,
    role: 'admin',
    is_enabled: 1,
    can_read: 1,
    can_upload: 1,
    can_edit: 1,
    storage_quota_bytes: 0,
    created_at: now,
    last_login_at: null,
  });
}

export function createSession(
  db: Database.Database,
  userId: string,
  ttlMs: number,
  meta?: { ip?: string; userAgent?: string },
): { token: string; expiresAt: string } {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  db.prepare(
    `INSERT INTO sessions (token_hash, user_id, ip, user_agent, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    hashToken(token),
    userId,
    meta?.ip ?? null,
    meta?.userAgent ? meta.userAgent.slice(0, 300) : null,
    expiresAt.toISOString(),
    now.toISOString(),
  );
  return { token, expiresAt: expiresAt.toISOString() };
}

export function deleteSession(db: Database.Database, token: string | undefined): void {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

export function deleteExpiredSessions(db: Database.Database): void {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
}

export async function getSessionUser(
  db: Database.Database,
  request: FastifyRequest,
): Promise<AuthUser | null> {
  const token = request.cookies?.[SESSION_COOKIE_NAME];
  if (!token) return null;

  const row = db.prepare(
    `SELECT u.id, u.username, u.role, u.is_enabled,
            u.can_read, u.can_upload, u.can_edit, u.storage_quota_bytes,
            u.created_at, u.last_login_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.is_enabled = 1`,
  ).get(hashToken(token), new Date().toISOString()) as UserRow | undefined;

  if (!row) return null;
  return mapUser(row);
}

export async function requireUser(
  db: Database.Database,
  request: FastifyRequest,
): Promise<AuthUser> {
  const user = await getSessionUser(db, request);
  if (!user) throw unauthorized();
  (request as AuthenticatedRequest).user = user;
  return user;
}

export async function requirePermission(
  db: Database.Database,
  request: FastifyRequest,
  permission: UserPermission,
): Promise<AuthUser> {
  const user = await requireUser(db, request);
  if (user.role !== 'admin' && !user.permissions[permission]) {
    throw forbidden(permission === 'read'
      ? '管理员尚未授予你读取和下载权限'
      : '当前账号无权执行此操作');
  }
  return user;
}

export async function requireAdmin(
  db: Database.Database,
  request: FastifyRequest,
): Promise<AuthUser> {
  const user = await requireUser(db, request);
  if (user.role !== 'admin') throw forbidden('仅管理员可以管理用户权限');
  return user;
}

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  config: AppConfig,
): void {
  reply.setCookie(SESSION_COOKIE_NAME, token, {
    path: '/',
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict',
    maxAge: Math.floor(config.sessionTtlMs / 1000),
  });
}

export function clearSessionCookie(reply: FastifyReply, config: AppConfig): void {
  reply.clearCookie(SESSION_COOKIE_NAME, {
    path: '/',
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict',
  });
}
