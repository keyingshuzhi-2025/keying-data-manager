import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import Database from 'better-sqlite3';
import mime from 'mime-types';
import { conflict, notFound } from './errors.js';
import type { LocalObjectStorage } from './storage.js';
import type {
  CreateFileInput,
  FileRecord,
  FileType,
  ListFilesQuery,
  ListFilesResult,
} from './types.js';

interface FileRow {
  id: string;
  parent_id: string | null;
  name: string;
  kind: 'file' | 'folder';
  object_id: string | null;
  mime_type: string | null;
  extension: string | null;
  size_bytes: number | null;
  sha256: string | null;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface FilePatch {
  name?: string;
  parentId?: string | null;
}

const maxFileNameBytes = 240;

function nowIso(): string {
  return new Date().toISOString();
}

function mapFile(row: FileRow): FileRecord {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    kind: row.kind,
    objectId: row.object_id,
    mimeType: row.mime_type,
    extension: row.extension,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

/** Reject path separators, control characters, and names that could alias filesystem paths. */
export function normalizeFileName(name: string): string {
  const normalized = name.trim();
  if (
    !normalized
    || normalized === '.'
    || normalized === '..'
    || normalized.includes('/')
    || normalized.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new Error('文件名不能为空、路径分隔符或控制字符');
  }
  if (Buffer.byteLength(normalized, 'utf8') > maxFileNameBytes) {
    throw new Error(`文件名不能超过 ${maxFileNameBytes} 字节`);
  }
  return normalized;
}

export function normalizeMimeType(filename: string, claimedMimeType?: string): string {
  const fromExtension = mime.lookup(filename);
  if (fromExtension) return fromExtension;

  if (
    claimedMimeType
    && /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(claimedMimeType)
    && !/^(application\/(x-msdownload|x-executable|msdos|powershell))$/i.test(claimedMimeType)
  ) {
    return claimedMimeType.toLowerCase();
  }
  return 'application/octet-stream';
}

export function classifyFileType(record: Pick<FileRecord, 'kind' | 'mimeType'>): FileType {
  if (record.kind === 'folder') return 'folder';
  const mimeType = (record.mimeType ?? '').toLowerCase();
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  if (
    mimeType.startsWith('text/')
    || mimeType === 'application/pdf'
    || mimeType.includes('wordprocessingml')
    || mimeType.includes('msword')
    || mimeType.includes('excel')
    || mimeType.includes('zip')
  ) {
    return 'document';
  }
  return 'other';
}

function escapeLike(value: string): string {
  return value.replace(/([\\%_])/g, '\\$1');
}

function typeCondition(type: ListFilesQuery['type']): string | null {
  switch (type) {
    case 'folder':
      return "kind = 'folder'";
    case 'image':
      return "kind = 'file' AND mime_type LIKE 'image/%'";
    case 'audio':
      return "kind = 'file' AND mime_type LIKE 'audio/%'";
    case 'video':
      return "kind = 'file' AND mime_type LIKE 'video/%'";
    case 'document':
      return "kind = 'file' AND (mime_type LIKE 'text/%' OR mime_type = 'application/pdf' OR mime_type LIKE '%word%' OR mime_type LIKE '%excel%' OR mime_type LIKE '%zip%')";
    case 'other':
      return "kind = 'file' AND mime_type NOT LIKE 'image/%' AND mime_type NOT LIKE 'audio/%' AND mime_type NOT LIKE 'video/%' AND mime_type NOT LIKE 'text/%' AND mime_type <> 'application/pdf'";
    default:
      return null;
  }
}

export class FileService {
  constructor(
    private readonly db: Database.Database,
    private readonly storage: LocalObjectStorage,
  ) {}

  list(query: ListFilesQuery): ListFilesResult {
    const conditions = ["deleted_at IS NULL"];
    const parameters: Array<string | number> = [];

    if (!query.parentId) {
      conditions.push('parent_id IS NULL');
    } else {
      conditions.push('parent_id = ?');
      parameters.push(query.parentId);
    }

    if (query.q) {
      conditions.push("name COLLATE NOCASE LIKE ? ESCAPE '\\'");
      parameters.push(`%${escapeLike(query.q)}%`);
    }

    const typeExpression = typeCondition(query.type);
    if (typeExpression) {
      conditions.push(typeExpression);
    }

    const where = conditions.join(' AND ');
    const sortColumns: Record<ListFilesQuery['sort'], string> = {
      name: 'name COLLATE NOCASE',
      size: 'size_bytes',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    };
    const sort = sortColumns[query.sort];
    const order = query.order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const offset = (query.page - 1) * query.limit;

    const total = (
      this.db.prepare(`SELECT COUNT(*) AS count FROM files WHERE ${where}`).get(...parameters) as { count: number }
    ).count;
    const rows = this.db.prepare(
      `SELECT * FROM files WHERE ${where} ORDER BY ${sort} ${order}, id ASC LIMIT ? OFFSET ?`,
    ).all(...parameters, query.limit, offset) as FileRow[];

    return {
      items: rows.map(mapFile),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        hasNext: offset + rows.length < total,
      },
    };
  }

  get(id: string): FileRecord {
    const row = this.db.prepare(
      'SELECT * FROM files WHERE id = ? AND deleted_at IS NULL',
    ).get(id) as FileRow | undefined;
    if (!row) throw notFound('文件');
    return mapFile(row);
  }

  getPath(id: string): FileRecord[] {
    const current = this.get(id);
    const path: FileRecord[] = [current];
    const visited = new Set([current.id]);
    let parentId = current.parentId;

    while (parentId) {
      if (visited.has(parentId)) throw conflict('目录结构存在循环引用');
      const parent = this.get(parentId);
      visited.add(parent.id);
      path.unshift(parent);
      parentId = parent.parentId;
    }

    return path;
  }

  createFolder(parentId: string | null, name: string): FileRecord {
    const safeName = normalizeFileName(name);
    this.assertParentFolder(parentId);
    const id = randomUUID();
    const timestamp = nowIso();
    try {
      this.db.prepare(
        `INSERT INTO files
         (id, parent_id, name, kind, object_id, mime_type, extension, size_bytes, sha256, created_at, updated_at)
         VALUES (?, ?, ?, 'folder', NULL, 'application/x-directory', NULL, 0, NULL, ?, ?)`,
      ).run(id, parentId, safeName, timestamp, timestamp);
    } catch (error) {
      if (this.isUniqueConflict(error)) throw conflict('同名目录已存在');
      throw error;
    }
    return this.get(id);
  }

  createFile(input: CreateFileInput, uploadedBy?: string): FileRecord {
    const safeName = normalizeFileName(input.name);
    this.assertParentFolder(input.parentId);
    const timestamp = nowIso();

    try {
      this.db.prepare(
        `INSERT INTO files
         (id, parent_id, name, kind, object_id, mime_type, extension, size_bytes, sha256, uploaded_by, created_at, updated_at)
         VALUES (?, ?, ?, 'file', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.parentId,
        safeName,
        input.objectId,
        input.mimeType,
        input.extension,
        input.sizeBytes,
        input.sha256,
        uploadedBy ?? null,
        timestamp,
        timestamp,
      );
    } catch (error) {
      this.storage.remove(input.objectId).catch(() => undefined);
      if (this.isUniqueConflict(error)) throw conflict('同名文件已存在');
      throw error;
    }

    return this.get(input.id);
  }

  /** 返回某用户上传的未删除文件总字节数 */
  uploadedBytesByUser(userId: string): number {
    const row = this.db.prepare(
      `SELECT COALESCE(SUM(size_bytes), 0) AS total
       FROM files
       WHERE uploaded_by = ? AND kind = 'file' AND deleted_at IS NULL`,
    ).get(userId) as { total: number };
    return row.total;
  }

  update(id: string, patch: FilePatch): FileRecord {
    const current = this.get(id);
    const name = patch.name === undefined ? current.name : normalizeFileName(patch.name);
    const parentId = patch.parentId === undefined ? current.parentId : patch.parentId;

    if (parentId !== current.parentId) {
      this.assertParentFolder(parentId);
      if (parentId) this.assertNotDescendant(id, parentId);
    }

    const timestamp = nowIso();
    try {
      this.db.prepare(
        'UPDATE files SET name = ?, parent_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
      ).run(name, parentId, timestamp, id);
    } catch (error) {
      if (this.isUniqueConflict(error)) throw conflict('目标位置已存在同名文件');
      throw error;
    }
    return this.get(id);
  }

  move(id: string, parentId: string | null): FileRecord {
    return this.update(id, { parentId });
  }

  copy(id: string, parentId: string | null, name?: string): FileRecord {
    const source = this.get(id);
    this.assertParentFolder(parentId);
    if (source.kind === 'folder') this.assertNotDescendant(id, parentId ?? '');

    const copyTree = (sourceId: string, targetParentId: string | null, rootName?: string): string => {
      const sourceRow = this.db.prepare(
        'SELECT * FROM files WHERE id = ? AND deleted_at IS NULL',
      ).get(sourceId) as FileRow | undefined;
      if (!sourceRow) throw notFound('文件');

      const newId = randomUUID();
      const timestamp = nowIso();
      this.db.prepare(
        `INSERT INTO files
         (id, parent_id, name, kind, object_id, mime_type, extension, size_bytes, sha256, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newId,
        targetParentId,
        rootName ?? sourceRow.name,
        sourceRow.kind,
        sourceRow.object_id,
        sourceRow.mime_type,
        sourceRow.extension,
        sourceRow.size_bytes,
        sourceRow.sha256,
        timestamp,
        timestamp,
      );

      if (sourceRow.kind === 'folder') {
        const children = this.db.prepare(
          'SELECT id FROM files WHERE parent_id = ? AND deleted_at IS NULL ORDER BY created_at, id',
        ).all(sourceId) as Array<{ id: string }>;
        for (const child of children) copyTree(child.id, newId);
      }
      return newId;
    };

    let newId: string;
    try {
      newId = this.db.transaction(() => copyTree(
        source.id,
        parentId,
        name ? normalizeFileName(name) : undefined,
      ))();
    } catch (error) {
      if (this.isUniqueConflict(error)) throw conflict('目标位置已存在同名文件');
      throw error;
    }
    return this.get(newId);
  }

  async delete(id: string): Promise<void> {
    const file = this.get(id);
    if (file.kind === 'folder') {
      const child = this.db.prepare(
        'SELECT id FROM files WHERE parent_id = ? AND deleted_at IS NULL LIMIT 1',
      ).get(id);
      if (child) throw conflict('目录包含文件，不能直接删除');
    }

    this.db.prepare(
      'UPDATE files SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
    ).run(nowIso(), nowIso(), id);

    if (file.objectId) {
      const active = this.db.prepare(
        'SELECT 1 FROM files WHERE object_id = ? AND deleted_at IS NULL LIMIT 1',
      ).get(file.objectId);
      if (!active) await this.storage.remove(file.objectId);
    }
  }

  cleanupOrphanedObjects(): Promise<number> {
    const rows = this.db.prepare(
      'SELECT DISTINCT object_id FROM files WHERE object_id IS NOT NULL AND deleted_at IS NULL',
    ).all() as Array<{ object_id: string }>;
    return this.storage.removeOrphans(new Set(rows.map((row) => row.object_id)));
  }

  private assertParentFolder(parentId: string | null): void {
    if (!parentId) return;
    const row = this.db.prepare(
      "SELECT id FROM files WHERE id = ? AND deleted_at IS NULL AND kind = 'folder'",
    ).get(parentId) as { id: string } | undefined;
    if (!row) throw notFound('父目录');
  }

  private assertNotDescendant(sourceId: string, parentId: string): void {
    const row = this.db.prepare(
      `WITH RECURSIVE descendants(id) AS (
         SELECT id FROM files WHERE id = ? AND deleted_at IS NULL
         UNION ALL
         SELECT f.id FROM files f JOIN descendants d ON f.parent_id = d.id
         WHERE f.deleted_at IS NULL
       )
       SELECT id FROM descendants WHERE id = ? LIMIT 1`,
    ).get(sourceId, parentId) as { id: string } | undefined;
    if (row) throw conflict('不能将目录移动到自身或其子目录');
  }

  private isUniqueConflict(error: unknown): boolean {
    const message = error instanceof Error ? error.message : '';
    return message.includes('UNIQUE constraint failed') || message.includes('idx_files_active_sibling_name');
  }
}

export function extensionFromName(name: string): string | null {
  const extension = extname(name);
  return extension ? extension.slice(1).toLowerCase() : null;
}
