/**
 * 管理员动态水印配置（v0.1.2 §6.1）。
 *
 * 配置落库于 app_config 键值表（key = 'watermark_config'，value = JSON），
 * 变更即时生效（每次输出时读取）。未配置时使用与 watermark.ts 默认样式一致的默认值。
 */
import { z } from 'zod';
import type { HubDatabase } from './db/database.js';
import type { WatermarkStyle } from './watermark.js';

export const WATERMARK_CONFIG_KEY = 'watermark_config';

/** 管理员可配置的水印参数（对应 docs/v0.1.2-plan.md §6.1 与 watermark.ts WatermarkStyle） */
export const watermarkConfigSchema = z.object({
  /** 全局开关：关闭后服务端图像水印与 MD→PDF 身份水印均不叠加 */
  enabled: z.boolean().default(true),
  /** 文案模板，占位符：{username} {date} {time} {datetime} {shareCode} {fileName} */
  text: z.string().min(1).max(200).default('{username} {datetime}'),
  /** 透明度 0..1 */
  opacity: z.number().min(0).max(1).default(0.25),
  /** 平铺或角落 */
  position: z.enum(['tile', 'corner']).default('tile'),
  /** 角落方位（position=corner 时生效） */
  corner: z.enum(['northwest', 'northeast', 'southwest', 'southeast']).default('southeast'),
  /** 角落距图像边缘距离 */
  margin: z.number().int().min(0).max(200).default(16),
  /** 字号 */
  fontSize: z.number().int().min(8).max(200).default(28),
  /** 颜色（#rgb / #rrggbb） */
  color: z.string().regex(/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/).default('#3f4a5a'),
  /** 旋转角度（顺时针，度） */
  angleDeg: z.number().min(-90).max(90).default(30),
  /** 平铺瓦片宽高 */
  tileWidth: z.number().int().min(100).max(2000).default(420),
  tileHeight: z.number().int().min(100).max(2000).default(260),
  /** 平铺瓦片间距 */
  tileSpacing: z.number().int().min(0).max(500).default(32),
  /** 是否作用于图像预览（内部 /stream 与公开 /stream） */
  applyToPreview: z.boolean().default(true),
  /** 是否作用于图像下载（内部 /download 与公开 /download） */
  applyToDownload: z.boolean().default(true),
});

export type WatermarkConfig = z.infer<typeof watermarkConfigSchema>;

export const DEFAULT_WATERMARK_CONFIG: WatermarkConfig = watermarkConfigSchema.parse({});

function parseStoredConfig(value: string | undefined): WatermarkConfig {
  if (value === undefined || value === '') return DEFAULT_WATERMARK_CONFIG;
  try {
    return watermarkConfigSchema.parse(JSON.parse(value));
  } catch {
    // 存储损坏时回退默认，不阻断输出
    return DEFAULT_WATERMARK_CONFIG;
  }
}

/** 读取当前生效的水印配置（无缓存，保证变更即时生效） */
export function loadWatermarkConfig(db: HubDatabase): WatermarkConfig {
  const row = db.sqlite.prepare(
    'SELECT value FROM app_config WHERE key = ? LIMIT 1',
  ).get(WATERMARK_CONFIG_KEY) as { value: string } | undefined;
  return parseStoredConfig(row?.value);
}

/** 保存水印配置（upsert；记录配置变更审计由调用方负责） */
export function saveWatermarkConfig(
  db: HubDatabase,
  config: WatermarkConfig,
  updatedBy: string,
): WatermarkConfig {
  const normalized = watermarkConfigSchema.parse(config);
  db.sqlite.prepare(
    `INSERT INTO app_config (key, value, updated_by, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run(
    WATERMARK_CONFIG_KEY,
    JSON.stringify(normalized),
    updatedBy,
    new Date().toISOString(),
  );
  return normalized;
}

/** 将水印配置映射为 watermark.ts 的视觉样式 */
export function watermarkStyleFromConfig(config: WatermarkConfig): WatermarkStyle {
  return {
    opacity: config.opacity,
    position: config.position,
    corner: config.corner,
    margin: config.margin,
    fontSize: config.fontSize,
    color: config.color,
    angleDeg: config.angleDeg,
    tile: { width: config.tileWidth, height: config.tileHeight },
    tileSpacing: config.tileSpacing,
  };
}
