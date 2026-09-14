import { resolve } from 'node:path';
import { z } from 'zod';

const nodeEnvironmentSchema = z.enum(['development', 'production', 'test']);

const environmentSchema = z.object({
  NODE_ENV: nodeEnvironmentSchema.default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATA_DIR: z.string().min(1).default('./data'),
  DB_PATH: z.string().min(1).optional(),
  OBJECT_DIR: z.string().min(1).optional(),
  UPLOAD_DIR: z.string().min(1).optional(),
  WEB_DIST_DIR: z.string().min(1).optional(),
  PUBLIC_URL: z.string().min(1).optional(),
  ADMIN_USERNAME: z.string().min(1).default('admin'),
  ADMIN_PASSWORD: z.string().min(1).default('admin123'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(1024 * 1024 * 1024),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(24),
  COOKIE_SECURE: z.string().optional(),
  TRUST_PROXY: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type NodeEnvironment = z.infer<typeof nodeEnvironmentSchema>;

export interface AppConfig {
  nodeEnv: NodeEnvironment;
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  objectDir: string;
  uploadDir: string;
  webDistDir: string;
  publicUrl?: string;
  adminUsername: string;
  adminPassword: string;
  maxUploadBytes: number;
  sessionTtlMs: number;
  cookieSecure: boolean;
  trustProxy: boolean | string | number;
  logLevel: string;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return fallback;
}

function parseTrustProxy(value: string | undefined): boolean | string | number {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  if (/^\d+$/.test(normalized)) return Number(normalized);
  return value;
}

/** Load and validate process environment without logging secrets. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  const value = parsed.data;
  const dataDir = resolve(value.DATA_DIR);
  const isProduction = value.NODE_ENV === 'production';

  if (isProduction && (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD)) {
    throw new Error('ADMIN_USERNAME and ADMIN_PASSWORD are required when NODE_ENV=production');
  }
  if (isProduction && Buffer.byteLength(value.ADMIN_PASSWORD, 'utf8') < 12) {
    throw new Error('ADMIN_PASSWORD must be at least 12 bytes when NODE_ENV=production');
  }

  return {
    nodeEnv: value.NODE_ENV,
    host: value.HOST,
    port: value.PORT,
    dataDir,
    dbPath: resolve(value.DB_PATH ?? resolve(dataDir, 'db/local-file-hub.sqlite')),
    objectDir: resolve(value.OBJECT_DIR ?? resolve(dataDir, 'objects')),
    uploadDir: resolve(value.UPLOAD_DIR ?? resolve(dataDir, 'uploads')),
    webDistDir: resolve(value.WEB_DIST_DIR ?? resolve('dist/web')),
    publicUrl: value.PUBLIC_URL,
    adminUsername: value.ADMIN_USERNAME,
    adminPassword: value.ADMIN_PASSWORD,
    maxUploadBytes: value.MAX_UPLOAD_BYTES,
    sessionTtlMs: value.SESSION_TTL_HOURS * 60 * 60 * 1000,
    cookieSecure: parseBoolean(value.COOKIE_SECURE, isProduction),
    trustProxy: parseTrustProxy(value.TRUST_PROXY),
    logLevel: value.LOG_LEVEL,
  };
}
