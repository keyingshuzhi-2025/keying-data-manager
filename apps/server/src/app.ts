import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ZodError } from 'zod';
import { loadConfig, type AppConfig } from './config.js';
import { HubDatabase } from './db/database.js';
import { AppError } from './errors.js';
import { FileService } from './file-service.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerFileRoutes } from './routes/files.js';
import { LocalObjectStorage } from './storage.js';

export interface HubApp {
  app: FastifyInstance;
  config: AppConfig;
  db: HubDatabase;
  storage: LocalObjectStorage;
  files: FileService;
}

export async function buildApp(config: AppConfig = loadConfig()): Promise<HubApp> {
  const db = new HubDatabase(config.dbPath);
  const storage = new LocalObjectStorage(config.objectDir, config.uploadDir);
  const files = new FileService(db.sqlite, storage);
  const trustProxy = config.trustProxy;
  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel },
    bodyLimit: config.maxUploadBytes + 1024 * 1024,
    trustProxy: typeof trustProxy === 'number'
      ? (_address, hop) => hop < trustProxy
      : trustProxy,
  });

  await app.register(cookie);
  await app.register(multipart, {
    limits: {
      fileSize: config.maxUploadBytes,
      files: 1,
      fields: 20,
      fieldSize: 1024 * 1024,
    },
  });

  app.addHook('onSend', async (_request, reply) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('X-Frame-Options', 'SAMEORIGIN')
      .header('Referrer-Policy', 'no-referrer')
      .header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (config.nodeEnv === 'production') {
      reply.header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'",
      );
    }
  });

  registerAuthRoutes(app, { config, db });
  registerAdminRoutes(app, { db });
  registerFileRoutes(app, { config, db, storage, files });

  const [temporaryUploadsRemoved, orphanedObjectsRemoved] = await Promise.all([
    storage.cleanupTemporaryUploads(),
    files.cleanupOrphanedObjects(),
  ]);
  if (temporaryUploadsRemoved || orphanedObjectsRemoved) {
    app.log.info(
      { temporaryUploadsRemoved, orphanedObjectsRemoved },
      '已清理未完成上传和孤立文件对象',
    );
  }

  app.get('/api/health', async () => ({
    status: 'ok',
    time: new Date().toISOString(),
    service: 'local-file-hub',
  }));

  if (config.nodeEnv === 'production') {
    const indexPath = join(config.webDistDir, 'index.html');
    if (!existsSync(indexPath)) {
      throw new Error(`Web build not found: ${indexPath}. Run npm run build first.`);
    }
    await app.register(fastifyStatic, {
      root: config.webDistDir,
      prefix: '/',
      setHeaders(reply, filePath) {
        if (
          filePath.endsWith('index.html')
          || filePath.endsWith('manifest.webmanifest')
          || filePath.endsWith('/sw.js')
        ) {
          reply.header('Cache-Control', 'no-cache');
        } else {
          reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url === '/api' || request.url.startsWith('/api/')) {
        return reply.code(404).send({
          error: { code: 'NOT_FOUND', message: '接口不存在' },
        });
      }
      return reply.type('text/html').sendFile('index.html', { cacheControl: false });
    });
  }

  app.setErrorHandler((error, request, reply) => {
    request.log.debug(error);
    if (error instanceof AppError) {
      reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      });
      return;
    }
    if (error instanceof ZodError) {
      reply.code(400).send({
        error: {
          code: 'BAD_REQUEST',
          message: '请求参数无效',
          details: error.flatten(),
        },
      });
      return;
    }
    if ((error as { code?: string; statusCode?: number }).code === 'FST_REQ_BODY_TOO_LARGE'
      || (error as { code?: string; statusCode?: number }).statusCode === 413) {
      reply.code(413).send({
        error: { code: 'PAYLOAD_TOO_LARGE', message: '请求体超过大小限制' },
      });
      return;
    }
    request.log.error(error);
    reply.code(500).send({
      error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' },
    });
  });

  app.addHook('onClose', async () => {
    db.close();
  });

  return { app, config, db, storage, files };
}
