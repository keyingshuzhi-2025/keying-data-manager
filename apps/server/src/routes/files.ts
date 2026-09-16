import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { recordActivity, type ActivityInput } from '../activity-log.js';
import type { AppConfig } from '../config.js';
import type { HubDatabase } from '../db/database.js';
import { badRequest, notFound, unsupportedMediaType } from '../errors.js';
import {
  extensionFromName,
  FileService,
  normalizeFileName,
  normalizeMimeType,
} from '../file-service.js';
import type { LocalObjectStorage } from '../storage.js';
import { requirePermission, type AuthenticatedRequest } from '../auth.js';
import type { FileRecord, ListFilesQuery } from '../types.js';

const idSchema = z.string().uuid();
const optionalParentSchema = z.union([z.string().uuid(), z.null()]).optional();

const listQuerySchema = z.object({
  parentId: z.string().uuid().optional(),
  q: z.string().max(200).optional(),
  type: z.enum(['folder', 'image', 'audio', 'video', 'document', 'other']).optional(),
  sort: z.enum(['name', 'size', 'createdAt', 'updatedAt']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const createFolderSchema = z.object({
  parentId: optionalParentSchema,
  name: z.string().min(1).max(240),
  kind: z.literal('folder').default('folder'),
});

const updateFileSchema = z.object({
  name: z.string().min(1).max(240).optional(),
  parentId: optionalParentSchema,
});

const moveFileSchema = z.object({
  parentId: optionalParentSchema,
});

const copyFileSchema = z.object({
  parentId: optionalParentSchema,
  name: z.string().min(1).max(240).optional(),
});

interface RouteContext {
  config: AppConfig;
  db: HubDatabase;
  storage: LocalObjectStorage;
  files: FileService;
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw badRequest(message, result.error.flatten());
  return result.data;
}

/** 记录当前认证用户的一次文件操作；未登录或失败时静默跳过 */
function logFileActivity(
  request: FastifyRequest,
  db: HubDatabase,
  input: Omit<ActivityInput, 'userId'>,
): void {
  const userId = (request as AuthenticatedRequest).user?.id;
  if (!userId) return;
  recordActivity(db.sqlite, { ...input, userId });
}

function fileIdFromParams(request: FastifyRequest): string {
  return parseOrThrow(
    idSchema,
    (request.params as { id?: unknown } | undefined)?.id,
    '文件 ID 无效',
  );
}

function fieldValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'value' in value) {
    const nested = (value as { value?: unknown }).value;
    return typeof nested === 'string' ? nested : undefined;
  }
  return undefined;
}

function parseParentId(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return parseOrThrow(z.string().uuid(), value, '父目录 ID 无效');
}

function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) throw badRequest('Range 格式无效');

  let start: number;
  let end: number;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) throw badRequest('Range 格式无效');
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
      throw badRequest('Range 超出文件范围');
    }
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

function sendRangeError(reply: FastifyReply, size: number): FastifyReply {
  return reply
    .code(416)
    .header('Content-Range', `bytes */${size}`)
    .header('Accept-Ranges', 'bytes')
    .send({ error: { code: 'RANGE_NOT_SATISFIABLE', message: 'Range 超出文件范围' } });
}

export function registerFileRoutes(app: FastifyInstance, context: RouteContext): void {
  const requireRead = async (request: FastifyRequest) => {
    await requirePermission(context.db.sqlite, request, 'read');
  };
  const requireUpload = async (request: FastifyRequest) => {
    await requirePermission(context.db.sqlite, request, 'upload');
  };
  const requireEdit = async (request: FastifyRequest) => {
    await requirePermission(context.db.sqlite, request, 'edit');
  };

  app.get('/api/files', { preHandler: requireRead }, async (request) => {
    const query = parseOrThrow(listQuerySchema, request.query, '查询参数无效') as ListFilesQuery;
    return context.files.list(query);
  });

  app.post('/api/files', { preHandler: requireUpload }, async (request) => {
    const input = parseOrThrow(createFolderSchema, request.body, '创建目录参数无效');
    const file = context.files.createFolder(input.parentId ?? null, input.name);
    logFileActivity(request, context.db, {
      action: 'create_folder',
      targetType: 'folder',
      targetName: file.name,
    });
    return { file };
  });

  app.get('/api/files/:id', { preHandler: requireRead }, async (request) => {
    return { file: context.files.get(fileIdFromParams(request)) };
  });

  app.get('/api/files/:id/path', { preHandler: requireRead }, async (request) => {
    return { path: context.files.getPath(fileIdFromParams(request)) };
  });

  app.patch('/api/files/:id', { preHandler: requireEdit }, async (request) => {
    const input = parseOrThrow(updateFileSchema, request.body, '更新参数无效');
    const id = fileIdFromParams(request);
    const file = context.files.update(id, {
      name: input.name === undefined ? undefined : normalizeFileName(input.name),
      parentId: input.parentId === undefined ? undefined : (input.parentId ?? null),
    });
    logFileActivity(request, context.db, {
      action: 'rename',
      targetType: file.kind === 'folder' ? 'folder' : 'file',
      targetName: file.name,
    });
    return { file };
  });

  app.post('/api/files/:id/move', { preHandler: requireEdit }, async (request) => {
    const input = parseOrThrow(moveFileSchema, request.body, '移动参数无效');
    const file = context.files.move(fileIdFromParams(request), input.parentId ?? null);
    logFileActivity(request, context.db, {
      action: 'move',
      targetType: file.kind === 'folder' ? 'folder' : 'file',
      targetName: file.name,
    });
    return { file };
  });

  app.post('/api/files/:id/copy', { preHandler: requireEdit }, async (request) => {
    const input = parseOrThrow(copyFileSchema, request.body, '复制参数无效');
    const file = context.files.copy(fileIdFromParams(request), input.parentId ?? null, input.name);
    logFileActivity(request, context.db, {
      action: 'copy',
      targetType: file.kind === 'folder' ? 'folder' : 'file',
      targetName: file.name,
    });
    return { file };
  });

  app.delete('/api/files/:id', { preHandler: requireEdit }, async (request) => {
    const id = fileIdFromParams(request);
    const file = context.files.get(id);
    await context.files.delete(id);
    logFileActivity(request, context.db, {
      action: 'delete',
      targetType: file.kind === 'folder' ? 'folder' : 'file',
      targetName: file.name,
    });
    return { ok: true };
  });

  app.post('/api/uploads', { preHandler: requireUpload }, async (request, reply) => {
    if (!request.isMultipart()) throw unsupportedMediaType('请使用 multipart/form-data 上传文件');

    let stored: Awaited<ReturnType<LocalObjectStorage['storeStream']>> | undefined;
    let uploadedFilename: string | undefined;
    let claimedMimeType: string | undefined;
    let parentField: unknown;
    let nameField: unknown;
    try {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          if (stored) throw badRequest('每次只能上传一个文件');
          uploadedFilename = part.filename;
          claimedMimeType = part.mimetype;
          stored = await context.storage.storeStream(part.file, context.config.maxUploadBytes);
          continue;
        }
        if (part.fieldname === 'parentId') parentField = part.value;
        if (part.fieldname === 'name') nameField = part.value;
      }

      if (!stored) throw badRequest('请选择要上传的文件');
      const parentId = parseParentId(parentField);
      const requestedName = fieldValue(nameField) || uploadedFilename;
      if (!requestedName) throw badRequest('文件名无效');
      const safeName = normalizeFileName(requestedName);
      const mimeType = normalizeMimeType(safeName, claimedMimeType);
      if (mimeType === 'application/octet-stream' && !safeName.includes('.')) {
        throw unsupportedMediaType('无法识别文件类型，请提供扩展名');
      }

      const record = context.files.createFile({
        id: stored.objectId,
        parentId: parentId ?? null,
        name: safeName,
        objectId: stored.objectId,
        mimeType,
        extension: extensionFromName(safeName),
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
      });
      logFileActivity(request, context.db, {
        action: 'upload',
        targetType: 'file',
        targetName: record.name,
      });
      return reply.code(201).send({ file: record });
    } catch (error) {
      if (stored) await context.storage.remove(stored.objectId).catch(() => undefined);
      if (error instanceof Error && error.name === 'AppError') throw error;
      if ((error as { statusCode?: number }).statusCode === 413) throw error;
      if (error instanceof Error && error.message.startsWith('文件名')) {
        throw badRequest(error.message);
      }
      throw error;
    }
  });

  app.get('/api/files/:id/download', { preHandler: requireRead }, async (request, reply) => {
    const file = context.files.get(fileIdFromParams(request));
    if (file.kind !== 'file' || !file.objectId) throw notFound('文件内容');
    logFileActivity(request, context.db, {
      action: 'download',
      targetType: 'file',
      targetName: file.name,
    });
    return sendFile(file, request, reply, true, context.storage);
  });

  app.get('/api/files/:id/stream', { preHandler: requireRead }, async (request, reply) => {
    const file = context.files.get(fileIdFromParams(request));
    if (file.kind !== 'file' || !file.objectId) throw notFound('文件内容');
    return sendFile(file, request, reply, false, context.storage);
  });
}

async function sendFile(
  file: FileRecord,
  request: FastifyRequest,
  reply: FastifyReply,
  attachment: boolean,
  storage: LocalObjectStorage,
): Promise<FastifyReply> {
  if (!file.objectId) throw notFound('文件内容');
  let size: number;
  try {
    size = (await storage.stat(file.objectId)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw notFound('文件内容');
    throw error;
  }

  const encodedName = encodeURIComponent(file.name).replace(/'/g, '%27');
  const forceAttachment = !isSafeInlineType(file.mimeType ?? 'application/octet-stream');
  const disposition = attachment || forceAttachment
    ? `attachment; filename*=UTF-8''${encodedName}`
    : `inline; filename*=UTF-8''${encodedName}`;
  reply
    .header('Accept-Ranges', 'bytes')
    .header('Content-Disposition', disposition)
    .header('Content-Type', file.mimeType ?? 'application/octet-stream')
    .header('X-Content-Type-Options', 'nosniff')
    .header('Cache-Control', attachment ? 'private, no-store' : 'private, max-age=3600');

  let range: { start: number; end: number } | null = null;
  try {
    range = parseRange(request.headers.range, size);
  } catch (error) {
    if (error instanceof Error && error.name === 'AppError') {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 400 || statusCode === 416) return sendRangeError(reply, size);
    }
    throw error;
  }

  if (range) {
    reply
      .code(206)
      .header('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
      .header('Content-Length', String(range.end - range.start + 1));
    return reply.send(storage.read(file.objectId, { start: range.start, end: range.end }));
  }

  reply.header('Content-Length', String(size));
  return reply.send(storage.read(file.objectId));
}

function isSafeInlineType(mimeType: string): boolean {
  const type = mimeType.toLowerCase();
  return (type.startsWith('image/') && type !== 'image/svg+xml')
    || type.startsWith('audio/')
    || type.startsWith('video/')
    || type === 'application/pdf'
    || type === 'text/plain';
}

export type { RouteContext as FileRouteContext };
