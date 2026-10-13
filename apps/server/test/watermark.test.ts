import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HubDatabase } from '../src/db/database.js';
import {
  resolveWatermarkText,
  sanitizeSvg,
  watermarkImage,
  WatermarkError,
} from '../src/watermark.js';
import {
  DEFAULT_WATERMARK_CONFIG,
  loadWatermarkConfig,
  saveWatermarkConfig,
  watermarkConfigSchema,
  watermarkStyleFromConfig,
} from '../src/watermark-config.js';

describe('resolveWatermarkText 模板解析', () => {
  const now = new Date('2026-09-22T08:05:00Z');

  it('解析全部占位符', () => {
    const text = resolveWatermarkText(
      '{username} {date} {time} {datetime} {shareCode} {fileName}',
      { kind: 'identity', username: '张三', shareCode: 'abc', fileName: '报告.md', now },
    );
    expect(text).toContain('张三');
    expect(text).toContain('2026-09-22');
    expect(text).toContain('16:05:00'); // {time} 按服务器本地时区
    expect(text).toContain('abc');
    expect(text).toContain('报告.md');
  });

  it('缺少 username 且模板含 {username} 时抛 INPUT 错误', () => {
    expect(() => resolveWatermarkText('{username} {date}', {
      kind: 'identity',
      username: '',
      now,
    })).toThrow(expect.objectContaining({ code: 'INPUT' }));
  });

  it('未知占位符原样保留', () => {
    expect(resolveWatermarkText('未知 {foo}', {
      kind: 'identity',
      username: 'u',
      now,
    })).toBe('未知 {foo}');
  });
});

describe('sanitizeSvg 净化', () => {
  it('移除 script / 事件属性 / javascript: 链接', () => {
    const input = '<svg xmlns="http://www.w3.org/2000/svg">'
      + '<script>alert(1)</script>'
      + '<text onmouseover="evil()">hi</text>'
      + '<a href="javascript:alert(1)">x</a>'
      + '</svg>';
    const { svg, changed } = sanitizeSvg(input);
    expect(changed).toBe(true);
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('onmouseover');
    expect(svg).not.toContain('javascript:');
  });

  it('无效根元素抛 SVG 错误', () => {
    expect(() => sanitizeSvg('<html><body>hi</body></html>'))
      .toThrow(expect.objectContaining({ code: 'SVG' }));
  });

  it('合法的纯 SVG 不变更', () => {
    const input = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';
    const { changed } = sanitizeSvg(input);
    expect(changed).toBe(false);
  });
});

describe('watermarkImage 图像水印（sharp）', () => {
  async function makePng(width: number, height: number): Promise<Buffer> {
    const sharp = (await import('sharp')).default;
    return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 200, b: 200 } } })
      .png()
      .toBuffer();
  }

  it('对 PNG 输出水印版本：尺寸不变、像素上限校验、标签解析', async () => {
    const input = await makePng(64, 48);
    const result = await watermarkImage({
      input,
      mimeType: 'image/png',
      context: { kind: 'identity', username: 'tester', now: new Date('2026-09-22T08:05:00Z') },
      text: '{username} {datetime}',
    });
    expect(result.format).toBe('png');
    expect(result.width).toBe(64);
    expect(result.height).toBe(48);
    expect(result.outputPixels).toBe(64 * 48);
    expect(result.inputPixels).toBe(64 * 48);
    expect(result.downscaled).toBe(false);
    expect(result.label).toContain('tester');
    expect(result.data.length).toBeGreaterThan(0);
  });

  it('超出输出像素上限时降采样（downscaled=true）', async () => {
    const input = await makePng(64, 48); // 3072 px
    const result = await watermarkImage({
      input,
      mimeType: 'image/png',
      context: { kind: 'identity', username: 'u', now: new Date() },
      text: '{username}',
      maxOutputPixels: 500,
    });
    expect(result.downscaled).toBe(true);
    expect(result.outputPixels).toBeLessThanOrEqual(500);
  });

  it('SVG 输入被净化后栅格化为 PNG（防注入）', async () => {
    const input = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20">'
      + '<script>alert(1)</script>'
      + '<rect width="40" height="20" fill="blue"/>'
      + '</svg>',
    );
    const result = await watermarkImage({
      input,
      mimeType: 'image/svg+xml',
      context: { kind: 'identity', username: 'u', now: new Date() },
      text: '{username}',
    });
    expect(result.svgSanitized).toBe(true);
    expect(result.format).toBe('png');
  });

  it('不可解码输入抛 DECODE 错误', async () => {
    await expect(watermarkImage({
      input: Buffer.from('this is not an image at all'),
      mimeType: 'image/png',
      context: { kind: 'identity', username: 'u', now: new Date() },
      text: '{username}',
    })).rejects.toBeInstanceOf(WatermarkError);
  });
});

describe('水印配置（app_config 落库）', () => {
  let directory: string;
  let db: HubDatabase;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'local-file-hub-wmcfg-'));
    db = new HubDatabase(join(directory, 'hub.sqlite'));
    // app_config.updated_by 外键引用 users(id)，需先有真实用户
    db.sqlite.prepare(
      `INSERT INTO users (id, username, password_hash, role, is_enabled, can_read, can_upload, can_edit, created_at)
       VALUES ('u-admin', 'admin', 'x', 'admin', 1, 1, 1, 1, ?)`,
    ).run(new Date().toISOString());
  });

  afterEach(async () => {
    db.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('未配置时返回默认配置', () => {
    expect(loadWatermarkConfig(db)).toEqual(DEFAULT_WATERMARK_CONFIG);
  });

  it('保存后可读回，配置即时生效', () => {
    const custom = watermarkConfigSchema.parse({
      enabled: true,
      text: '内部资料 {username} {datetime}',
      opacity: 0.4,
      position: 'corner',
      color: '#ff0000',
      applyToDownload: false,
    });
    const saved = saveWatermarkConfig(db, custom, 'u-admin');
    expect(saved.text).toBe('内部资料 {username} {datetime}');
    expect(loadWatermarkConfig(db)).toEqual(saved);
    // app_config 行确实落库
    const row = db.sqlite.prepare(
      "SELECT value FROM app_config WHERE key = 'watermark_config'",
    ).get() as { value: string };
    expect(JSON.parse(row.value).opacity).toBe(0.4);
  });

  it('存储损坏时回退默认，不抛错', () => {
    db.sqlite.prepare(
      `INSERT INTO app_config (key, value, updated_by, updated_at)
       VALUES ('watermark_config', '{bad json', 'u-admin', ?)`,
    ).run(new Date().toISOString());
    expect(loadWatermarkConfig(db)).toEqual(DEFAULT_WATERMARK_CONFIG);
  });

  it('watermarkStyleFromConfig 映射视觉样式', () => {
    const style = watermarkStyleFromConfig(watermarkConfigSchema.parse({
      position: 'corner',
      corner: 'northeast',
      color: '#112233',
      tileWidth: 500,
      tileHeight: 300,
    }));
    expect(style.position).toBe('corner');
    expect(style.corner).toBe('northeast');
    expect(style.color).toBe('#112233');
    expect(style.tile).toEqual({ width: 500, height: 300 });
  });
});
