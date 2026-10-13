import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { recordActivity, type ActivityInput } from '../activity-log.js';
import type { AppConfig } from '../config.js';
import type { HubDatabase } from '../db/database.js';
import { badRequest, conflict, notFound, unsupportedMediaType } from '../errors.js';
import {
  extensionFromName,
  FileService,
  isAllowedUploadExtension,
  normalizeFileName,
  normalizeMimeType,
} from '../file-service.js';
import type { LocalObjectStorage } from '../storage.js';
import type { AuthenticatedRequest } from '../auth.js';
import { requireUser } from '../auth.js';
import {
  resolveEffectivePermissions,
  requireFilePermission,
  requireFilePermissions,
  requireFolderPermission,
  requireRootPermission,
} from '../authz.js';
import { renderMarkdownPdf } from '../md-pdf.js';
import { loadWatermarkConfig, watermarkStyleFromConfig } from '../watermark-config.js';
import { applyPdfWatermark, maybeWatermarkPdf } from '../watermark-pdf.js';
import { maybeWatermarkImage } from '../watermark-output.js';
import { resolveWatermarkText } from '../watermark.js';
import type { FileRecord, ListFilesQuery } from '../types.js';

const idSchema = z.string().uuid();
const optionalParentSchema = z.union([z.string().uuid(), z.null()]).optional();
const effectivePermissionsQuerySchema = z.object({
  folderId: z.union([z.literal('ROOT'), z.string().uuid()]).optional(),
  fileId: z.string().uuid().optional(),
}).refine((value) => !(value.folderId && value.fileId), {
  message: '只能指定一个权限目标',
});

const listQuerySchema = z.object({
  parentId: z.string().uuid().optional(),
  q: z.string().max(200).optional(),
  type: z.enum(['folder', 'text', 'document', 'image', 'audio', 'video', 'other']).optional(),
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

const contentUpdateSchema = z.object({
  content: z.string().max(20 * 1024 * 1024),
});

interface RouteContext {
  config: AppConfig;
  db: HubDatabase;
  storage: LocalObjectStorage;
  files: FileService;
}

/** 文本内容/预览读取上限（防止大文件拖垮内存） */
const MAX_TEXT_BYTES = 1024 * 1024;
/** MD→PDF 源文件读取上限；超限拒绝导出 */
const MAX_PDF_SOURCE_BYTES = 5 * 1024 * 1024;

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

function isMarkdownFile(file: FileRecord): boolean {
  const extension = (file.extension ?? '').toLowerCase();
  return extension === 'md' || extension === 'markdown';
}

/** 以水印后图像字节响应（全量 200，不拆分 Range；防泄密优先） */
function sendWatermarkedImage(
  reply: FastifyReply,
  result: { data: Buffer; mimeType: string },
  file: FileRecord,
  attachment: boolean,
): FastifyReply {
  const encodedName = encodeURIComponent(file.name).replace(/'/g, '%27');
  return reply
    .code(200)
    .header('Content-Type', result.mimeType)
    .header('Content-Disposition', `${attachment ? 'attachment' : 'inline'}; filename*=UTF-8''${encodedName}`)
    .header('Content-Length', String(result.data.length))
    .header('X-Content-Type-Options', 'nosniff')
    .header('Cache-Control', 'private, no-store')
    .send(result.data);
}

export function registerFileRoutes(app: FastifyInstance, context: RouteContext): void {
  // v0.1.2：对象级授权统一走 authz 模块（管理员绕过；目录链继承 + ROOT 兜底 + 遗留回退）。
  const requireFile = (permission: Parameters<typeof requireFilePermission>[2]) => (
    request: FastifyRequest,
  ) => requireFilePermission(context.db.sqlite, request, permission, fileIdFromParams(request));

  const requireFileAll = (permissions: Parameters<typeof requireFilePermissions>[2]) => (
    request: FastifyRequest,
  ) => requireFilePermissions(context.db.sqlite, request, permissions, fileIdFromParams(request));

  const requireUploadAt = (request: FastifyRequest, parentId: string | null | undefined) => (
    parentId
      ? requireFolderPermission(context.db.sqlite, request, 'upload', parentId)
      : requireRootPermission(context.db.sqlite, request, 'upload')
  );

  // 当前用户读取自己的实际 ACL，不暴露管理端 ACL 编辑接口。
  app.get('/api/permissions/effective', async (request) => {
    const user = await requireUser(context.db.sqlite, request);
    const input = parseOrThrow(effectivePermissionsQuerySchema, request.query, '权限查询参数无效');
    const target = input.fileId
      ? { kind: 'file' as const, id: input.fileId }
      : input.folderId === undefined || input.folderId === 'ROOT'
      ? { kind: 'root' as const }
      : { kind: 'folder' as const, id: input.folderId };
    return { permissions: resolveEffectivePermissions(context.db.sqlite, user, target) };
  });

  app.get('/api/files', async (request) => {
    const query = parseOrThrow(listQuerySchema, request.query, '查询参数无效') as ListFilesQuery;
    if (query.parentId) {
      await requireFolderPermission(context.db.sqlite, request, 'read', query.parentId);
    } else {
      await requireRootPermission(context.db.sqlite, request, 'read');
    }
    return context.files.list(query);
  });

  app.post('/api/files', async (request) => {
    const input = parseOrThrow(createFolderSchema, request.body, '创建目录参数无效');
    await requireUploadAt(request, input.parentId ?? null);
    const file = context.files.createFolder(input.parentId ?? null, input.name);
    logFileActivity(request, context.db, {
      action: 'create_folder',
      targetType: 'folder',
      targetName: file.name,
    });
    return { file };
  });

  app.get('/api/files/:id', { preHandler: requireFile('read') }, async (request) => {
    return { file: context.files.get(fileIdFromParams(request)) };
  });

  app.get('/api/files/:id/path', { preHandler: requireFile('read') }, async (request) => {
    return { path: context.files.getPath(fileIdFromParams(request)) };
  });

  app.patch('/api/files/:id', { preHandler: requireFile('edit') }, async (request) => {
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

  app.post('/api/files/:id/move', { preHandler: requireFile('edit') }, async (request) => {
    const input = parseOrThrow(moveFileSchema, request.body, '移动参数无效');
    const id = fileIdFromParams(request);
    await requireUploadAt(request, input.parentId ?? null);
    const file = context.files.move(id, input.parentId ?? null);
    logFileActivity(request, context.db, {
      action: 'move',
      targetType: file.kind === 'folder' ? 'folder' : 'file',
      targetName: file.name,
    });
    return { file };
  });

  app.post('/api/files/:id/copy', { preHandler: requireFile('edit') }, async (request) => {
    const input = parseOrThrow(copyFileSchema, request.body, '复制参数无效');
    const id = fileIdFromParams(request);
    await requireUploadAt(request, input.parentId ?? null);
    const file = context.files.copy(id, input.parentId ?? null, input.name);
    logFileActivity(request, context.db, {
      action: 'copy',
      targetType: file.kind === 'folder' ? 'folder' : 'file',
      targetName: file.name,
    });
    return { file };
  });

  app.delete('/api/files/:id', { preHandler: requireFile('edit') }, async (request) => {
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

  // ----- 文本内容 / 预览 / 在线编辑 / MD 导出（v0.1.2 §6–§7） -----

  app.get('/api/files/:id/content', { preHandler: requireFile('read') }, async (request) => {
    const id = fileIdFromParams(request);
    const file = context.files.get(id);
    if (file.kind !== 'file' || !file.objectId) throw notFound('文件内容');
    const result = await context.files.readText(id, MAX_TEXT_BYTES);
    return {
      fileId: file.id,
      name: file.name,
      mimeType: file.mimeType,
      content: result.content,
      sizeBytes: result.sizeBytes,
      encoding: result.encoding,
      isBinary: result.isBinary,
      truncated: result.truncated,
    };
  });

  app.get('/api/files/:id/preview', { preHandler: requireFile('read') }, async (request) => {
    const id = fileIdFromParams(request);
    const file = context.files.get(id);
    if (file.kind !== 'file' || !file.objectId) throw notFound('文件内容');
    const result = await context.files.readText(id, MAX_TEXT_BYTES);
    if (result.isBinary) throw badRequest('该文件不是文本文件');
    return {
      fileId: file.id,
      name: file.name,
      kind: isMarkdownFile(file) ? 'markdown' : 'text',
      content: result.content,
      sizeBytes: result.sizeBytes,
      truncated: result.truncated,
    };
  });

  app.put('/api/files/:id/content', { preHandler: requireFile('editMd') }, async (request) => {
    const id = fileIdFromParams(request);
    const input = parseOrThrow(contentUpdateSchema, request.body, '内容参数无效');
    const file = context.files.get(id);
    if (!isMarkdownFile(file)) throw badRequest('仅支持编辑 Markdown 文件');
    const updated = await context.files.updateContent(id, input.content);
    logFileActivity(request, context.db, {
      action: 'md_edit',
      targetType: 'file',
      targetName: file.name,
    });
    return { ok: true, file: updated };
  });

  app.get('/api/files/:id/export-pdf', { preHandler: requireFileAll(['read', 'download']) }, async (request, reply) => {
    const id = fileIdFromParams(request);
    const file = context.files.get(id);
    if (!isMarkdownFile(file)) throw badRequest('仅支持导出 Markdown 文件');
    const result = await context.files.readText(id, MAX_PDF_SOURCE_BYTES);
    if (result.isBinary) throw badRequest('该文件不是文本文件');
    if (result.truncated) throw badRequest('文件过大，无法导出 PDF');

    const user = (request as AuthenticatedRequest).user;
    // v0.1.2 §6.1：MD→PDF 身份水印使用管理员配置的模板与开关（平铺瓦片水印）
    const watermarkConfig = loadWatermarkConfig(context.db);
    const watermarkLabel = resolveWatermarkText(watermarkConfig.text, {
      kind: 'identity',
      username: user?.username ?? '',
      fileName: file.name,
    });
    let pdf = await renderMarkdownPdf(result.content, {
      title: file.name,
    });
    if (watermarkConfig.enabled) {
      pdf = await applyPdfWatermark(pdf, watermarkLabel, watermarkStyleFromConfig(watermarkConfig));
    }

    logFileActivity(request, context.db, {
      action: 'md_export',
      targetType: 'file',
      targetName: file.name,
    });

    const baseName = file.name.replace(/\.(md|markdown)$/i, '');
    const encodedName = encodeURIComponent(baseName).replace(/'/g, '%27');
    reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodedName}.pdf`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, no-store');
    return reply.send(pdf);
  });

  // ----- 上传（v0.1.2：目标目录 upload 授权 + 扩展名白名单） -----

  app.post('/api/uploads', async (request, reply) => {
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
      // 授权在落库前完成：parentId 来自 multipart 字段（可能晚于文件流），
      // 此处校验后若拒绝，将由下方 catch 清理已暂存对象。
      await requireUploadAt(request, parentId ?? null);
      const requestedName = fieldValue(nameField) || uploadedFilename;
      if (!requestedName) throw badRequest('文件名无效');
      const safeName = normalizeFileName(requestedName);
      const mimeType = normalizeMimeType(safeName, claimedMimeType);
      const extension = extensionFromName(safeName);
      if (!isAllowedUploadExtension(extension)) {
        throw unsupportedMediaType('该文件类型已被禁用（上传白名单）');
      }
      if (mimeType === 'application/octet-stream' && !safeName.includes('.')) {
        throw unsupportedMediaType('无法识别文件类型，请提供扩展名');
      }

      // 存储配额校验：管理员不受限；超出配额时拒绝并清理已暂存对象
      const uploader = (request as AuthenticatedRequest).user;
      if (uploader && uploader.role !== 'admin') {
        const quotaRow = context.db.sqlite.prepare(
          'SELECT storage_quota_bytes FROM users WHERE id = ? LIMIT 1',
        ).get(uploader.id) as { storage_quota_bytes: number } | undefined;
        const quota = quotaRow?.storage_quota_bytes ?? 0;
        if (quota > 0) {
          const used = context.files.uploadedBytesByUser(uploader.id);
          if (used + stored.sizeBytes > quota) {
            await context.storage.remove(stored.objectId).catch(() => undefined);
            throw conflict('存储配额不足，无法上传该文件');
          }
        }
      }

      const record = context.files.createFile({
        id: stored.objectId,
        parentId: parentId ?? null,
        name: safeName,
        objectId: stored.objectId,
        mimeType,
        extension,
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
      }, (request as AuthenticatedRequest).user?.id);
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

  // ----- 下载 / 预览流（v0.1.2：需 read + download；原始流可被保存，故 download=false 一律 403） -----

  app.get('/api/files/:id/download', { preHandler: requireFileAll(['read', 'download']) }, async (request, reply) => {
    const file = context.files.get(fileIdFromParams(request));
    if (file.kind !== 'file' || !file.objectId) throw notFound('文件内容');
    const user = (request as AuthenticatedRequest).user;
    // v0.1.2 §6.2：图像 / 原生 PDF 下载叠加身份水印（服务端强约束）
    const watermarkConfig = loadWatermarkConfig(context.db);
    const watermarkContext = { kind: 'identity' as const, username: user?.username ?? '', shareCode: undefined, now: new Date() };
    const watermarked = await maybeWatermarkImage(file, context.storage, watermarkConfig, watermarkContext, 'download');
    if (watermarked) return sendWatermarkedImage(reply, watermarked, file, true);
    const watermarkedPdf = await maybeWatermarkPdf(file, context.storage, watermarkConfig, watermarkContext, 'download');
    if (watermarkedPdf) return sendWatermarkedImage(reply, watermarkedPdf, file, true);
    logFileActivity(request, context.db, {
      action: 'download',
      targetType: 'file',
      targetName: file.name,
    });
    return sendFile(file, request, reply, true, context.storage);
  });

  app.get('/api/files/:id/stream', { preHandler: requireFileAll(['read', 'download']) }, async (request, reply) => {
    const file = context.files.get(fileIdFromParams(request));
    if (file.kind !== 'file' || !file.objectId) throw notFound('文件内容');
    const user = (request as AuthenticatedRequest).user;
    // v0.1.2 §6.2：图像 / 原生 PDF 在线预览叠加身份水印
    const watermarkConfig = loadWatermarkConfig(context.db);
    const watermarkContext = { kind: 'identity' as const, username: user?.username ?? '', shareCode: undefined, now: new Date() };
    const watermarked = await maybeWatermarkImage(file, context.storage, watermarkConfig, watermarkContext, 'preview');
    if (watermarked) return sendWatermarkedImage(reply, watermarked, file, false);
    const watermarkedPdf = await maybeWatermarkPdf(file, context.storage, watermarkConfig, watermarkContext, 'preview');
    if (watermarkedPdf) return sendWatermarkedImage(reply, watermarkedPdf, file, false);
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
