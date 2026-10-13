/**
 * PDF 水印（v0.1.2 §3.4 / §6.3）。
 *
 * 对**原生上传的 PDF**（application/pdf）与 MD→PDF 导出结果套用同一套
 * 「平铺瓦片水印」：把与图像水印一致的旋转瓦片（watermark.ts buildOverlaySvg）
 * 光栅化为 PNG，再由 pdf-lib 在每个页面上一格一格地平铺叠加，确保每一页
 * 都铺满水印，视觉与图像水印完全一致。
 *
 * 为何要光栅化瓦片：pdf-lib 标准字体（Helvetica）无法编码 CJK，且水印文案含
 * 中文用户名；将瓦片经 sharp 用系统中文字体光栅化后按位图平铺，可正确显示中文，
 * 同时把旋转/颜色/透明度一并固定进瓦片字节。
 */
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import {
  buildOverlaySvg,
  rasterizeOverlay,
  resolveWatermarkText,
  WatermarkError,
  type WatermarkStyle,
} from './watermark.js';
import type { LocalObjectStorage } from './storage.js';
import { AppError, payloadTooLarge, tooManyRequests } from './errors.js';
import {
  watermarkStyleFromConfig,
  type WatermarkConfig,
} from './watermark-config.js';

/** 光栅化密度（与图像水印默认一致：144 DPI @ 2x）。 */
const TILE_DENSITY = 144;
const TILE_PIXEL_GUARD = 80_000_000;
export const MAX_WATERMARK_PDF_BYTES = 25 * 1024 * 1024;
const MAX_WATERMARK_PDF_PAGES = 250;
const MAX_WATERMARK_PDF_TILES = 50_000;
const MAX_WATERMARK_PDF_PAGE_DIMENSION_PT = 14_400;
const MAX_CONCURRENT_PDF_WATERMARKS = 2;
let activePdfWatermarks = 0;

function acquirePdfWatermarkSlot(): () => void {
  if (activePdfWatermarks >= MAX_CONCURRENT_PDF_WATERMARKS) {
    throw tooManyRequests(10, 'PDF 水印任务较多，请稍后重试');
  }
  activePdfWatermarks += 1;
  return () => { activePdfWatermarks -= 1; };
}

export interface WatermarkOutputResult {
  data: Buffer;
  mimeType: string;
  label: string;
}

/**
 * 把平铺水印叠加到已存在的 PDF 每一页。
 * @returns 新增水印后的完整 PDF 字节。
 */
export async function applyPdfWatermark(
  pdfBytes: Buffer,
  label: string,
  style: WatermarkStyle,
): Promise<Buffer> {
  if (pdfBytes.length > MAX_WATERMARK_PDF_BYTES) {
    throw payloadTooLarge('PDF 超过水印处理大小限制');
  }
  const release = acquirePdfWatermarkSlot();
  try {
    return await applyPdfWatermarkWithLimit(pdfBytes, label, style);
  } finally {
    release();
  }
}

async function applyPdfWatermarkWithLimit(
  pdfBytes: Buffer,
  label: string,
  style: WatermarkStyle,
): Promise<Buffer> {
  const tile = await rasterizeOverlay(
    buildOverlaySvg(label, style),
    TILE_DENSITY,
    TILE_PIXEL_GUARD,
  );

  const pdf = await PDFDocument.load(pdfBytes);
  const pages = pdf.getPages();
  if (pages.length > MAX_WATERMARK_PDF_PAGES) {
    throw payloadTooLarge('PDF 页数超过水印处理限制');
  }

  // 瓦片 PNG（rasterizeOverlay）在密度 TILE_DENSITY 下光栅化，其像素尺寸已包含瓦片间距
  // （buildOverlaySvg 的 canvas = tileWidth+tileSpacing）。pdf-lib 以 point 为坐标单位：
  // pt = px * (72 / TILE_DENSITY)。步长必须等于整块瓦片 canvas（含间距），
  // 即 tile.width * ptPerPixel，与 sharp 的 composite(tile:true) 边到边平铺完全一致；
  // 先前误用「不含间距的 tileWidth * ptPerPixel」导致步长=瓦片一半，水印重叠过密。
  const ptPerPixel = 72 / TILE_DENSITY;
  const tileWpt = tile.width * ptPerPixel;
  const tileHpt = tile.height * ptPerPixel;
  const stepX = tile.width * ptPerPixel;
  const stepY = tile.height * ptPerPixel;

  const image = await pdf.embedPng(tile.data);

  let totalTiles = 0;
  for (const page of pages) {
    const width = page.getWidth();
    const height = page.getHeight();
    if (!Number.isFinite(width) || !Number.isFinite(height)
      || width <= 0 || height <= 0
      || width > MAX_WATERMARK_PDF_PAGE_DIMENSION_PT
      || height > MAX_WATERMARK_PDF_PAGE_DIMENSION_PT) {
      throw payloadTooLarge('PDF 页面尺寸超过水印处理限制');
    }
    const columns = Math.ceil(width / stepX) + 2;
    const rows = Math.ceil(height / stepY) + 2;
    totalTiles += columns * rows;
    if (totalTiles > MAX_WATERMARK_PDF_TILES) {
      throw payloadTooLarge('PDF 水印绘制量超过处理限制');
    }
  }

  for (const page of pages) {
    // 平铺瓦片，向四周各扩展一块，保证全页铺满（瓦片自带透明间距，视觉不拥挤）。
    for (let top = -tileHpt; top < page.getHeight(); top += stepY) {
      for (let left = -tileWpt; left < page.getWidth(); left += stepX) {
        page.drawImage(image, {
          x: left,
          y: top,
          width: tileWpt,
          height: tileHpt,
        });
      }
    }
  }

  return Buffer.from(await pdf.save());
}

/**
 * 为 PDF 输出叠加平铺水印。命中「PDF + 配置启用 + 对应输出方向开启」时
 * 返回水印字节；未命中处理条件时返回 null。水印处理失败时拒绝输出原文件，避免绕过水印。
 */
export async function maybeWatermarkPdf(
  file: { name: string; mimeType: string | null; objectId: string | null },
  storage: LocalObjectStorage,
  config: WatermarkConfig,
  context: { kind: 'identity' | 'share'; username: string; shareCode?: string; fileName?: string; now?: Date },
  apply: 'preview' | 'download',
): Promise<WatermarkOutputResult | null> {
  if (!file.objectId) return null;
  if ((file.mimeType ?? '').toLowerCase() !== 'application/pdf') return null;
  if (!config.enabled) return null;
  if (apply === 'preview' && !config.applyToPreview) return null;
  if (apply === 'download' && !config.applyToDownload) return null;

  const release = acquirePdfWatermarkSlot();
  try {
    const { data, truncated } = await storage.readBytes(file.objectId, MAX_WATERMARK_PDF_BYTES);
    if (truncated) throw payloadTooLarge('PDF 超过水印处理大小限制');
    if (data.length === 0) return null;

    // 解析水印文案（与图像水印一致）
    const label = resolveWatermarkText(config.text, {
      kind: context.kind,
      username: context.username,
      shareCode: context.shareCode,
      fileName: context.fileName ?? file.name,
      now: context.now,
    });

    try {
      const pdf = await applyPdfWatermarkWithLimit(data, label, watermarkStyleFromConfig(config));
      return { data: pdf, mimeType: 'application/pdf', label };
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof WatermarkError) {
        throw new AppError(500, 'INTERNAL_ERROR', '无法安全应用 PDF 水印');
      }
      // PDF 解析/保存失败时拒绝输出，不能回退到未加水印的原始文件。
      throw new AppError(500, 'INTERNAL_ERROR', '无法安全应用 PDF 水印');
    }
  } finally {
    release();
  }
}
