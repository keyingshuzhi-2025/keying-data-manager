/**
 * 公开分享链接 —— 匿名（无需登录）访问路由。
 *
 * 设计说明：
 * - 接口形态与 apps/web/src/types.ts 对齐：/info 返回 { share: PublicShareInfo, file: PublicShareFile }；
 *   /tree 返回 { tree, totalCount, totalBytes }；/files/:fileId/content 返回文本内容；
 *   /verify 返回 { ok }；/download、/stream 输出文件流（支持 Range）。
 * - 信息/目录/内容/下载/预览端点统一经 resolveShareForAccess 校验五要素（存在/未撤销/
 *   未过期/次数未超/密码），通过后自增访问次数并刷新 last_access_at；/verify 仅校验
 *   状态与密码（checkSharePassword），不计数。
 * - 密码通过 `x-share-password` 请求头或 /verify 写入的分享专属 HttpOnly Cookie 提供，不接受 URL 参数。
 * - 只读：仅可访问分享指向的单个文件或其文件夹子树，绝不返回内部路径与上传者；
 *   子文件下载/预览/内容通过 ?fileId= / ?path= / :fileId 指定，并校验其确实属于该分享子树。
 * - 文件输出禁止缓存（no-store），保证撤销 / 过期即时生效。
 * - 每次访问 / 下载写入活动审计（userId 记为分享者，便于溯源到内部分享者）。
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { HubDatabase } from '../db/database.js';
import { badRequest, notFound, unauthorized } from '../errors.js';
import { renderMarkdownPdf } from '../md-pdf.js';
import type { LocalObjectStorage } from '../storage.js';
import { loadWatermarkConfig, watermarkStyleFromConfig } from '../watermark-config.js';
import { applyPdfWatermark, maybeWatermarkPdf } from '../watermark-pdf.js';
import { maybeWatermarkImage } from '../watermark-output.js';
import { resolveWatermarkText } from '../watermark.js';
import {
  checkSharePassword,
  isFileWithinShare,
  listShareSubtree,
  recordShareActivity,
  resolveShareForAccess,
  type ShareRootFile,
  type ShareRow,
} from './shares.js';

/** 内容预览的最大读取字节数（超出截断并标记 truncated）。 */
const MAX_CONTENT_BYTES = 1024 * 1024;

/** MD→PDF 渲染的源文件上限（2 MB），超出直接拒绝。 */
const MAX_PDF_SOURCE_BYTES = 2 * 1024 * 1024;

/** 判断公开分享目标是否为 Markdown（按扩展名或 MIME）。 */
function isMarkdownTarget(file: ShareRootFile): boolean {
  return /\.(md|markdown)$/i.test(file.name) || file.mimeType === 'text/markdown';
}

const tokenSchema = z.string().min(8).max(128);
const fileIdParamsSchema = z.object({ fileId: z.string().uuid() });
const verifySchema = z.object({ password: z.string().max(1024) });
const targetQuerySchema = z.object({
  fileId: z.string().uuid().optional(),
  path: z.string().min(1).max(2000).optional(),
});

interface PublicFileRow {
  id: string;
  name: string;
  kind: 'file' | 'folder';
  mime_type: string | null;
  extension: string | null;
  size_bytes: number | null;
  object_id: string | null;
}

export interface PublicShareRouteContext {
  db: HubDatabase;
  storage: LocalObjectStorage;
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw badRequest(message, result.error.flatten());
  return result.data;
}

function tokenFromParams(request: FastifyRequest): string {
  return parseOrThrow(
    tokenSchema,
    (request.params as { token?: unknown } | undefined)?.token,
    '分享链接无效',
  );
}

function sharePasswordCookieName(token: string): string {
  const tokenKey = createHash('sha256').update(token).digest('hex').slice(0, 24);
  return `lfh_share_pw_${tokenKey}`;
}

function passwordFromRequest(request: FastifyRequest, token: string): string | undefined {
  const header = request.headers['x-share-password'];
  if (typeof header === 'string' && header) return header;
  const cookieValue = request.cookies?.[sharePasswordCookieName(token)];
  return typeof cookieValue === 'string' && cookieValue ? cookieValue : undefined;
}

function clientMeta(request: FastifyRequest): string {
  const ua = typeof request.headers['user-agent'] === 'string'
    ? request.headers['user-agent']
    : '';
  return `${request.ip ?? ''} ${ua}`.trim();
}

function mapPublicFile(row: PublicFileRow): ShareRootFile {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    mimeType: row.mime_type,
    extension: row.extension,
    sizeBytes: row.size_bytes,
    objectId: row.object_id,
  };
}

/** 按相对路径（/ 连接、大小写不敏感）解析分享根下的目标文件 ID。 */
function resolvePath(db: HubDatabase, rootId: string, path: string): string {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  let parentId = rootId;
  for (const segment of segments) {
    const row = db.sqlite.prepare(
      `SELECT id FROM files
       WHERE parent_id = ? AND name = ? COLLATE NOCASE AND deleted_at IS NULL LIMIT 1`,
    ).get(parentId, segment) as { id: string } | undefined;
    if (!row) throw notFound('文件');
    parentId = row.id;
  }
  return parentId;
}

/**
 * 按 fileId 解析分享内的目标文件：文件分享只能指向根文件；文件夹分享须为子树内文件，
 * 并校验其确实位于分享子树内（防止越权访问其他文件）。
 */
function targetFromFileId(
  db: HubDatabase,
  share: ShareRow,
  root: ShareRootFile,
  fileId: string,
): ShareRootFile {
  if (share.kind === 'file') {
    if (fileId !== root.id) throw badRequest('参数与分享不匹配');
    return root;
  }
  if (!isFileWithinShare(db, share, fileId)) throw badRequest('参数与分享不匹配');
  const row = db.sqlite.prepare(
    `SELECT id, name, kind, mime_type, extension, size_bytes, object_id
     FROM files WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
  ).get(fileId) as PublicFileRow | undefined;
  if (!row) throw notFound('文件');
  if (row.kind !== 'file') throw badRequest('请指定分享目录中的文件（文件夹不可下载）');
  return mapPublicFile(row);
}

/** 解析下载/预览目标（?fileId= 或 ?path=）：文件分享缺省指向根文件；文件夹分享必须指定。 */
function resolvePublicTarget(
  db: HubDatabase,
  share: ShareRow,
  root: ShareRootFile,
  request: FastifyRequest,
): ShareRootFile {
  const query = parseOrThrow(targetQuerySchema, request.query, '下载参数无效');
  if (query.fileId !== undefined) return targetFromFileId(db, share, root, query.fileId);
  if (query.path !== undefined) {
    const targetId = resolvePath(db, share.file_id, query.path);
    return targetFromFileId(db, share, root, targetId);
  }
  if (share.kind === 'folder') throw badRequest('请指定分享目录中的文件（文件夹不可下载）');
  return root;
}

// ----- Range 与响应流（与 routes/files.ts 保持一致） -----

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

function isSafeInlineType(mimeType: string): boolean {
  const type = mimeType.toLowerCase();
  return (type.startsWith('image/') && type !== 'image/svg+xml')
    || type.startsWith('audio/')
    || type.startsWith('video/')
    || type === 'application/pdf'
    || type === 'text/plain';
}

/** 分享者用户名（溯源水印用）；用户已删除时返回占位符 */
function sharerUsername(db: HubDatabase, share: ShareRow): string {
  const row = db.sqlite.prepare(
    'SELECT username FROM users WHERE id = ? LIMIT 1',
  ).get(share.created_by) as { username: string } | undefined;
  return row?.username ?? '已删除用户';
}

/** 以分享溯源水印后的图像字节响应（全量 200，禁止缓存） */
function sendShareWatermarkedImage(
  reply: FastifyReply,
  result: { data: Buffer; mimeType: string },
  file: ShareRootFile,
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

async function sendPublicFile(
  file: ShareRootFile,
  request: FastifyRequest,
  reply: FastifyReply,
  attachment: boolean,
  storage: LocalObjectStorage,
): Promise<FastifyReply> {
  const objectId = file.objectId;
  if (!objectId) throw notFound('文件内容');

  let size: number;
  try {
    size = (await storage.stat(objectId)).size;
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
    // 公开分享链接禁止缓存，确保撤销/过期即时生效
    .header('Cache-Control', 'private, no-store');

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
    return reply.send(storage.read(objectId, { start: range.start, end: range.end }));
  }

  reply.header('Content-Length', String(size));
  return reply.send(storage.read(objectId));
}

export function registerPublicShareRoutes(
  app: FastifyInstance,
  context: PublicShareRouteContext,
): void {
  // ----- 元数据：根文件/目录信息（不暴露内部路径与上传者） -----
  app.get('/api/public/shares/:token/info', async (request) => {
    const token = tokenFromParams(request);
    const { share, root } = resolveShareForAccess(
      context.db,
      token,
      passwordFromRequest(request, token),
    );

    recordShareActivity(context.db, {
      userId: share.created_by,
      action: 'share_access',
      targetType: root.kind,
      targetName: root.name,
      detail: `公开访问 ${clientMeta(request)}`,
    });

    return {
      share: {
        fileId: root.id,
        kind: root.kind,
        fileName: root.name,
        createdAt: share.created_at,
        expiresAt: share.expires_at,
        maxAccesses: share.max_accesses,
        accessCount: share.access_count,
        hasPassword: share.password_hash !== null,
        isRevoked: Boolean(share.is_revoked),
        lastAccessAt: share.last_access_at,
        expired: share.expires_at !== null && share.expires_at <= new Date().toISOString(),
      },
      file: {
        id: root.id,
        name: root.name,
        kind: root.kind,
        mimeType: root.mimeType,
        extension: root.extension,
        sizeBytes: root.sizeBytes,
      },
    };
  });

  // ----- 目录子树（文件夹分享的完整递归列表） -----
  app.get('/api/public/shares/:token/tree', async (request) => {
    const token = tokenFromParams(request);
    const { share, root } = resolveShareForAccess(
      context.db,
      token,
      passwordFromRequest(request, token),
    );
    const subtree = listShareSubtree(context.db, root.id);

    recordShareActivity(context.db, {
      userId: share.created_by,
      action: 'share_access',
      targetType: root.kind,
      targetName: root.name,
      detail: `公开浏览目录 ${clientMeta(request)}`,
    });

    return {
      tree: subtree.tree,
      totalCount: subtree.totalCount,
      totalBytes: subtree.totalBytes,
    };
  });

  // ----- 文本内容预览（UTF-8；二进制返回空 content 并标记 isBinary） -----
  app.get('/api/public/shares/:token/files/:fileId/content', async (request) => {
    const token = tokenFromParams(request);
    const { fileId } = parseOrThrow(fileIdParamsSchema, request.params, '文件 ID 无效');
    const { share, root } = resolveShareForAccess(
      context.db,
      token,
      passwordFromRequest(request, token),
    );
    const target = targetFromFileId(context.db, share, root, fileId);
    if (!target.objectId) throw notFound('文件内容');

    const { data, truncated } = await context.storage.readBytes(target.objectId, MAX_CONTENT_BYTES);
    const isBinary = data.includes(0);

    recordShareActivity(context.db, {
      userId: share.created_by,
      action: 'share_access',
      targetType: 'file',
      targetName: target.name,
      detail: `公开查看内容 ${clientMeta(request)}`,
    });

    return {
      token,
      fileId: target.id,
      name: target.name,
      mimeType: target.mimeType,
      content: isBinary ? '' : data.toString('utf8'),
      isBinary,
      truncated,
    };
  });

  // ----- 密码验证（不计数，供落地页表单使用） -----
  app.post('/api/public/shares/:token/verify', async (request, reply) => {
    const token = tokenFromParams(request);
    const input = parseOrThrow(verifySchema, request.body, '验证参数无效');
    const ok = checkSharePassword(context.db, token, input.password);
    if (!ok) throw unauthorized('访问密码错误');
    reply.setCookie(sharePasswordCookieName(token), input.password, {
      path: `/api/public/shares/${token}`,
      httpOnly: true,
      sameSite: 'strict',
      secure: request.protocol === 'https',
      maxAge: 15 * 60,
    });
    return reply.send({ ok: true });
  });

  // ----- Markdown → PDF 渲染预览（inline；分享者溯源水印，v0.1.2 §3.4） -----
  app.get('/api/public/shares/:token/export-pdf', async (request, reply) => {
    const token = tokenFromParams(request);
    const { share, root } = resolveShareForAccess(
      context.db,
      token,
      passwordFromRequest(request, token),
    );
    const target = resolvePublicTarget(context.db, share, root, request);
    if (!target.objectId) throw notFound('文件内容');
    if (!isMarkdownTarget(target)) throw badRequest('仅支持 Markdown 文件的 PDF 预览');

    const { data, truncated } = await context.storage.readBytes(target.objectId, MAX_PDF_SOURCE_BYTES);
    if (truncated) throw badRequest('文件过大，无法渲染 PDF');
    if (data.includes(0)) throw badRequest('该文件不是文本文件');

    // 分享场景：使用管理员配置的水印模板与开关，叠加分享者 + 分享码溯源水印
    const watermarkConfig = loadWatermarkConfig(context.db);
    const watermarkLabel = resolveWatermarkText(watermarkConfig.text, {
      kind: 'share',
      username: sharerUsername(context.db, share),
      shareCode: token,
      fileName: target.name,
    });
    let pdf = await renderMarkdownPdf(data.toString('utf8'), {
      title: target.name,
    });
    if (watermarkConfig.enabled) {
      pdf = await applyPdfWatermark(pdf, watermarkLabel, watermarkStyleFromConfig(watermarkConfig));
    }

    recordShareActivity(context.db, {
      userId: share.created_by,
      action: 'share_access',
      targetType: 'file',
      targetName: target.name,
      detail: `公开 PDF 预览 ${clientMeta(request)}`,
    });

    const baseName = target.name.replace(/\.(md|markdown)$/i, '');
    const encodedName = encodeURIComponent(baseName).replace(/'/g, '%27');
    return reply
      .code(200)
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `inline; filename*=UTF-8''${encodedName}.pdf`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, no-store')
      .send(pdf);
  });

  // ----- 下载（附件；可指定文件夹分享中的子文件） -----
  app.get('/api/public/shares/:token/download', async (request, reply) => {
    const token = tokenFromParams(request);
    const { share, root } = resolveShareForAccess(
      context.db,
      token,
      passwordFromRequest(request, token),
    );
    const target = resolvePublicTarget(context.db, share, root, request);
    if (!target.objectId) throw notFound('文件内容');

    // v0.1.2 §3.4：分享输出叠加分享者溯源水印（分享者 + 短码 + 时间）
    // 图像走 maybeWatermarkImage；原生 PDF 走 maybeWatermarkPdf（平铺瓦片水印）。
    const watermarkConfig = loadWatermarkConfig(context.db);
    const watermarkContext = { kind: 'share' as const, username: sharerUsername(context.db, share), shareCode: token, now: new Date() };
    const watermarkedImage = await maybeWatermarkImage(target, context.storage, watermarkConfig, watermarkContext, 'download');
    if (watermarkedImage) {
      recordShareActivity(context.db, {
        userId: share.created_by,
        action: 'share_download',
        targetType: 'file',
        targetName: target.name,
        detail: `公开下载（水印版） ${clientMeta(request)}`,
      });
      return sendShareWatermarkedImage(reply, watermarkedImage, target, true);
    }

    const watermarkedPdf = await maybeWatermarkPdf(target, context.storage, watermarkConfig, watermarkContext, 'download');
    if (watermarkedPdf) {
      recordShareActivity(context.db, {
        userId: share.created_by,
        action: 'share_download',
        targetType: 'file',
        targetName: target.name,
        detail: `公开下载（PDF 水印版） ${clientMeta(request)}`,
      });
      return sendShareWatermarkedImage(reply, watermarkedPdf, target, true);
    }

    recordShareActivity(context.db, {
      userId: share.created_by,
      action: 'share_download',
      targetType: 'file',
      targetName: target.name,
      detail: `公开下载 ${clientMeta(request)}`,
    });

    return sendPublicFile(target, request, reply, true, context.storage);
  });

  // ----- 预览流（内联；可指定文件夹分享中的子文件，支持 Range） -----
  app.get('/api/public/shares/:token/stream', async (request, reply) => {
    const token = tokenFromParams(request);
    const { share, root } = resolveShareForAccess(
      context.db,
      token,
      passwordFromRequest(request, token),
    );
    const target = resolvePublicTarget(context.db, share, root, request);
    if (!target.objectId) throw notFound('文件内容');

    // v0.1.2 §3.4：分享预览叠加分享者溯源水印（图像 / 原生 PDF）
    const watermarkConfig = loadWatermarkConfig(context.db);
    const watermarkContext = { kind: 'share' as const, username: sharerUsername(context.db, share), shareCode: token, now: new Date() };
    const watermarkedImage = await maybeWatermarkImage(target, context.storage, watermarkConfig, watermarkContext, 'preview');
    if (watermarkedImage) {
      recordShareActivity(context.db, {
        userId: share.created_by,
        action: 'share_access',
        targetType: 'file',
        targetName: target.name,
        detail: `公开预览（水印版） ${clientMeta(request)}`,
      });
      return sendShareWatermarkedImage(reply, watermarkedImage, target, false);
    }

    const watermarkedPdf = await maybeWatermarkPdf(target, context.storage, watermarkConfig, watermarkContext, 'preview');
    if (watermarkedPdf) {
      recordShareActivity(context.db, {
        userId: share.created_by,
        action: 'share_access',
        targetType: 'file',
        targetName: target.name,
        detail: `公开预览（PDF 水印版） ${clientMeta(request)}`,
      });
      return sendShareWatermarkedImage(reply, watermarkedPdf, target, false);
    }

    recordShareActivity(context.db, {
      userId: share.created_by,
      action: 'share_access',
      targetType: 'file',
      targetName: target.name,
      detail: `公开预览 ${clientMeta(request)}`,
    });

    return sendPublicFile(target, request, reply, false, context.storage);
  });
}
