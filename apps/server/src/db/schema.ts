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
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
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
`;
