export const schema = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  is_enabled INTEGER NOT NULL DEFAULT 1,
  can_read INTEGER NOT NULL DEFAULT 0,
  can_upload INTEGER NOT NULL DEFAULT 0,
  can_edit INTEGER NOT NULL DEFAULT 0,
  storage_quota_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'folder')),
  object_id TEXT,
  mime_type TEXT,
  extension TEXT,
  size_bytes INTEGER,
  sha256 TEXT,
  is_shared INTEGER NOT NULL DEFAULT 0,
  uploaded_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (parent_id) REFERENCES files(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_files_parent_active
  ON files(parent_id, deleted_at, created_at);

CREATE INDEX IF NOT EXISTS idx_files_name_active
  ON files(name COLLATE NOCASE, deleted_at);

CREATE INDEX IF NOT EXISTS idx_files_mime_active
  ON files(mime_type, deleted_at);

CREATE INDEX IF NOT EXISTS idx_files_size_active
  ON files(size_bytes, deleted_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_files_active_sibling_name_nocase
  ON files(COALESCE(parent_id, ''), name COLLATE NOCASE)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_expiry
  ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  can_read INTEGER NOT NULL DEFAULT 1,
  can_upload INTEGER NOT NULL DEFAULT 0,
  can_edit INTEGER NOT NULL DEFAULT 0,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  used_by TEXT,
  used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_invites_code
  ON invites(code);

CREATE TABLE IF NOT EXISTS activity_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_name TEXT,
  detail TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_activity_user_time
  ON activity_logs(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_activity_time
  ON activity_logs(created_at DESC);

-- v6：文件夹级继承权限。folder_id 指向 files.id，但 'ROOT' 是虚拟默认策略
-- （不指向任何 files 行），因此本表不设外键，由应用层保证 folder_id 有效。
CREATE TABLE IF NOT EXISTS folder_permissions (
  folder_id TEXT PRIMARY KEY,
  can_read INTEGER NOT NULL DEFAULT 0,
  can_download INTEGER NOT NULL DEFAULT 0,
  can_upload INTEGER NOT NULL DEFAULT 0,
  can_edit INTEGER NOT NULL DEFAULT 0,
  can_edit_md INTEGER NOT NULL DEFAULT 0,
  can_share INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

-- v6：公开分享链接（匿名 · 限时 · 只读 · 可撤销）
-- token_hash 为令牌的 sha256 哈希（与 sessions 一致），原始短码仅创建时返回一次；
-- 由旧版明文 token 列迁移/回填而来（见 database.ts migrateShares）。
CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  file_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'folder')),
  created_by TEXT NOT NULL,
  expires_at TEXT,
  max_accesses INTEGER,
  access_count INTEGER NOT NULL DEFAULT 0,
  password_hash TEXT,
  is_revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_access_at TEXT,
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_shares_file
  ON shares(file_id);

CREATE INDEX IF NOT EXISTS idx_shares_created_by
  ON shares(created_by);

-- v6：站点级键值配置（如动态水印参数）
CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
);
`;
