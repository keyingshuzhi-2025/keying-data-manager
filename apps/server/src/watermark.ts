/**
 * Server-side image watermarking built on `sharp`.
 *
 * Responsibilities:
 * - Resolve watermark label templates (`{username}` `{date}` `{time}` `{shareCode}` `{fileName}`)
 *   for identity (内部身份溯源) and share (分享溯源) contexts.
 * - Sanitize SVG input by stripping scripts, event handlers, `javascript:`/external URLs and
 *   DOCTYPE/ENTITY declarations, then rasterize to PNG (rasterization itself cannot execute code,
 *   so this also removes the classic inline-XSS vector of served SVGs).
 * - Enforce a pixel cap (输出像素上限) so huge images are downscaled and decompression bombs are
 *   rejected, preventing memory exhaustion on the server.
 * - Composite a translucent tile or corner watermark without modifying the original object.
 *
 * Pure sharp + node:fs-free; no Chromium/puppeteer required.
 */
import sharp from 'sharp';

/** Default maximum output pixels (≈24 MP) an image may keep after watermarking. */
export const DEFAULT_MAX_OUTPUT_PIXELS = 24_000_000;
/** Default maximum output dimension (px) on either axis. */
export const DEFAULT_MAX_DIMENSION = 9000;
/**
 * Default hard guard on *input* pixels. Inputs beyond this are rejected outright
 * (decompression-bomb protection); anything between the output cap and this guard
 * is downscaled during decode (`fastShrinkOnLoad`).
 */
export const DEFAULT_MAX_INPUT_PIXELS = 80_000_000;

export type WatermarkKind = 'identity' | 'share';

/** Identity/share context used to resolve label templates. */
export interface WatermarkContext {
  kind: WatermarkKind;
  /** 当前浏览/分享者用户名, e.g. "zhangsan" or "张三". */
  username: string;
  /** 分享链接短码 (share context only). */
  shareCode?: string;
  /** 文件原始名, available as `{fileName}`. */
  fileName?: string;
  /** Defaults to `new Date()`. */
  now?: Date;
}

/** Visual style of the image watermark. All sizes are in base (72 dpi) pixels. */
export interface WatermarkStyle {
  /** 0..1 alpha of the overlay. */
  opacity: number;
  /** 平铺 (tile) or 角落 (corner). */
  position: 'tile' | 'corner';
  /** Corner placement, only used when `position === 'corner'`. */
  corner: 'northwest' | 'northeast' | 'southwest' | 'southeast';
  /** Distance from the image edge for corner placement (scaled with image size). */
  margin: number;
  /** Font size of the label. */
  fontSize: number;
  /** CSS hex color of the label (`#rgb` or `#rrggbb`). */
  color: string;
  /** Rotation of the label, degrees clockwise. */
  angleDeg: number;
  /** Tile canvas size for `position === 'tile'`. */
  tile: { width: number; height: number };
  /** Transparent gap between adjacent tiles. */
  tileSpacing: number;
}

export const DEFAULT_WATERMARK_STYLE: WatermarkStyle = {
  opacity: 0.25,
  position: 'tile',
  corner: 'southeast',
  margin: 16,
  fontSize: 28,
  color: '#3f4a5a',
  angleDeg: 30,
  tile: { width: 420, height: 260 },
  tileSpacing: 32,
};

export type WatermarkOutputFormat = 'jpeg' | 'png' | 'webp' | 'avif';

export interface ImageWatermarkOptions {
  /** Raw image bytes (any format sharp can decode, including SVG). */
  input: Buffer;
  /** Original MIME type, e.g. `image/png`, `image/svg+xml`. Used for format sniffing. */
  mimeType?: string;
  /** Who is viewing/downloading (identity) or sharing (share). */
  context: WatermarkContext;
  /**
   * Label template supporting `{username}` `{date}` `{time}` `{datetime}`
   * `{shareCode}` `{fileName}`. Unknown placeholders are kept verbatim.
   */
  text: string;
  /** Partial style overrides. */
  style?: Partial<WatermarkStyle>;
  /** Output pixel cap (downscale target). Defaults to `DEFAULT_MAX_OUTPUT_PIXELS`. */
  maxOutputPixels?: number;
  /** Output dimension cap. Defaults to `DEFAULT_MAX_DIMENSION`. */
  maxDimension?: number;
  /** Input pixel guard. Defaults to `DEFAULT_MAX_INPUT_PIXELS`. */
  maxInputPixels?: number;
  /** Output format; `'auto'` keeps a sensible format for the input type. */
  format?: WatermarkOutputFormat | 'auto';
  /** Quality for lossy output formats (jpeg/webp/avif). Defaults vary by format. */
  quality?: number;
  /** Background color used to flatten transparency when encoding JPEG. */
  background?: string;
}

export interface WatermarkResult {
  data: Buffer;
  mimeType: string;
  format: WatermarkOutputFormat;
  width: number;
  height: number;
  inputPixels: number;
  outputPixels: number;
  /** True when the output was downscaled to respect the pixel cap. */
  downscaled: boolean;
  /** True when the input was SVG and had to be sanitized/rasterized. */
  svgSanitized: boolean;
  /** The fully resolved watermark label that was composited. */
  label: string;
}

export type WatermarkErrorCode = 'INPUT' | 'SVG' | 'DECODE' | 'LIMIT' | 'ENCODE';

export class WatermarkError extends Error {
  constructor(
    public readonly code: WatermarkErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WatermarkError';
  }
}

const PLACEHOLDER_RE = /\{(\w+)\}/g;

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * Resolve a watermark label template against an identity/share context.
 * Date/time are formatted in the server's local timezone (documented assumption).
 */
export function resolveWatermarkText(template: string, context: WatermarkContext): string {
  if (template.includes('{username}') && !context.username) {
    throw new WatermarkError('INPUT', '身份水印模板包含 {username}，但缺少用户名');
  }
  const now = context.now ?? new Date();
  const date = formatDate(now);
  const time = formatTime(now);
  const values: Record<string, string> = {
    username: context.username,
    date,
    time,
    datetime: `${date} ${time}`,
    shareCode: context.shareCode ?? '',
    fileName: context.fileName ?? '',
  };
  return template.replace(PLACEHOLDER_RE, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match,
  );
}

/** Detect whether a buffer is (textual) SVG by MIME or by content sniffing. */
export function isSvgBuffer(input: Buffer, mimeType?: string): boolean {
  if (mimeType && mimeType.toLowerCase().includes('svg')) return true;
  const head = input.subarray(0, 1024).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  return head.startsWith('<svg') || head.startsWith('<?xml');
}

/**
 * Belt-and-suspenders sanitization pass over SVG source. Rasterization is the primary
 * defense (librsvg never executes scripts); this pass additionally strips:
 * - `<script>` blocks,
 * - `on*` event-handler attributes,
 * - `href`/`src` values with dangerous schemes (`javascript:`, `vbscript:`, `data:text/html`,
 *   `file:`, `//`, `http(s):`),
 * - `<!DOCTYPE>` / `<!ENTITY>` declarations (entity-expansion risk).
 * Fragment references (`#...`) and relative URLs are preserved.
 */
export function sanitizeSvg(xml: string): { svg: string; changed: boolean } {
  let changed = false;
  let out = xml.replace(/^\uFEFF/, '');

  const replace = (pattern: RegExp, replacement: string): string => {
    const next = out.replace(pattern, replacement);
    if (next !== out) changed = true;
    return next;
  };

  out = replace(/<!DOCTYPE[\s\S]*?>/gi, '');
  out = replace(/<!ENTITY[\s\S]*?>/gi, '');
  out = replace(/<script\b[\s\S]*?<\/script\s*>/gi, '');
  out = replace(/\s+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  out = out.replace(
    /\b(href|xlink:href|src)\s*=\s*("[^"]*"|'[^']*')/gi,
    (attr: string, name: string, quoted: string): string => {
      const value = quoted.slice(1, -1).trim().toLowerCase();
      if (
        /^(javascript|vbscript|data:text\/html|file):/i.test(value) ||
        /^\/\//.test(value) ||
        /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
      ) {
        changed = true;
        return '';
      }
      return attr;
    },
  );

  const trimmed = out.trimStart();
  if (!/^<svg[\s>]/i.test(trimmed)) {
    throw new WatermarkError('SVG', 'SVG 内容在净化后不再包含有效的 <svg> 根元素');
  }
  return { svg: out, changed };
}

function parseHexColor(hex: string): { r: number; g: number; b: number } {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new WatermarkError('INPUT', `无效的水印颜色: ${hex}（仅支持 #rgb / #rrggbb）`);
  const h = m[1];
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Rough per-character advance estimate (CJK ≈ 1.0em, Latin ≈ 0.55em). */
function estimateTextWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const ch of text) {
    units += /[\u2E80-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/.test(ch) ? 1 : 0.55;
  }
  return units * fontSize;
}

/**
 * Build the watermark overlay as an SVG tile (rasterized at the chosen density by sharp).
 * Font size shrinks automatically when the label is wider than the tile.
 */
function buildOverlaySvg(label: string, style: WatermarkStyle): string {
  const { r, g, b } = parseHexColor(style.color);
  const tileWidth = style.tile.width;
  const tileHeight = style.tile.height;
  const canvasWidth = tileWidth + style.tileSpacing;
  const canvasHeight = tileHeight + style.tileSpacing;

  let fontSize = style.fontSize;
  const estimated = estimateTextWidth(label, fontSize);
  if (estimated > tileWidth && fontSize > 10) {
    fontSize = Math.max(10, Math.floor((tileWidth * fontSize) / estimated));
  }

  const cx = canvasWidth / 2;
  const cy = canvasHeight / 2;
  const opacity = Math.min(1, Math.max(0, style.opacity));

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" ` +
    `viewBox="0 0 ${canvasWidth} ${canvasHeight}">` +
    `<text x="${cx}" y="${cy}" dy="0.35em" text-anchor="middle" ` +
    `font-family="system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', sans-serif" ` +
    `font-size="${fontSize}" fill="rgb(${r},${g},${b})" fill-opacity="${opacity}" ` +
    `transform="rotate(${style.angleDeg} ${cx} ${cy})">${escapeXml(label)}</text>` +
    `</svg>`
  );
}

/** Rasterize the overlay SVG to a PNG buffer with the requested density. */
async function rasterizeOverlay(
  svgXml: string,
  density: number,
  maxInputPixels: number,
): Promise<{ data: Buffer; width: number; height: number }> {
  try {
    const { data, info } = await sharp(Buffer.from(svgXml, 'utf8'), {
      density,
      limitInputPixels: maxInputPixels,
    })
      .png()
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } catch (error) {
    throw new WatermarkError(
      'ENCODE',
      `水印叠加层渲染失败: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const MIME_TO_FORMAT: Record<string, WatermarkOutputFormat> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

function formatMime(format: WatermarkOutputFormat): string {
  return format === 'jpeg' ? 'image/jpeg' : `image/${format}`;
}

/**
 * Watermark an image buffer in memory.
 *
 * Pipeline: sniff/sanitize SVG → metadata + pixel-cap planning → decode (auto-orient,
 * fast-shrink on load when downscaling) → composite overlay → re-encode.
 * The original bytes are never modified; output is a fresh buffer.
 */
export async function watermarkImage(options: ImageWatermarkOptions): Promise<WatermarkResult> {
  const {
    input,
    mimeType,
    context,
    text,
    maxOutputPixels = DEFAULT_MAX_OUTPUT_PIXELS,
    maxDimension = DEFAULT_MAX_DIMENSION,
    maxInputPixels = DEFAULT_MAX_INPUT_PIXELS,
    format: requestedFormat = 'auto',
    quality,
    background = '#ffffff',
  } = options;

  if (!Buffer.isBuffer(input) || input.length === 0) {
    throw new WatermarkError('INPUT', '图像输入为空');
  }
  if (maxOutputPixels < 1 || maxDimension < 1 || maxInputPixels < maxOutputPixels) {
    throw new WatermarkError('INPUT', '像素上限配置无效');
  }

  const label = resolveWatermarkText(text, context);
  const style: WatermarkStyle = { ...DEFAULT_WATERMARK_STYLE, ...options.style };

  // ---- SVG sanitization path -------------------------------------------------
  let svgSanitized = false;
  let decodeSource = input;
  let decodeMime = mimeType;
  if (isSvgBuffer(input, mimeType)) {
    const { svg, changed } = sanitizeSvg(input.toString('utf8'));
    svgSanitized = changed;
    decodeSource = Buffer.from(svg, 'utf8');
    decodeMime = 'image/svg+xml';
  }

  // ---- Metadata + pixel-cap planning ------------------------------------------
  let meta;
  try {
    meta = await sharp(decodeSource, { limitInputPixels: maxInputPixels }).metadata();
  } catch (error) {
    throw new WatermarkError(
      'DECODE',
      `无法解析图像元数据: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!meta.width || !meta.height) {
    throw new WatermarkError('DECODE', '图像缺少尺寸信息');
  }

  // metadata() reports pre-rotation dimensions; orientations 5-8 swap axes.
  const orientation = meta.orientation ?? 1;
  const swapped = orientation >= 5 && orientation <= 8;
  const effWidth = swapped ? meta.height : meta.width;
  const effHeight = swapped ? meta.width : meta.height;
  const inputPixels = effWidth * effHeight;

  if (inputPixels > maxInputPixels) {
    throw new WatermarkError(
      'LIMIT',
      `图像像素 ${inputPixels} 超过输入上限 ${maxInputPixels}，已拒绝处理（防内存耗尽）`,
    );
  }

  const ratio = Math.min(
    Math.sqrt(maxOutputPixels / inputPixels),
    maxDimension / effWidth,
    maxDimension / effHeight,
    1,
  );
  const targetWidth = Math.max(1, Math.round(effWidth * ratio));
  const targetHeight = Math.max(1, Math.round(effHeight * ratio));
  const downscaled = targetWidth < effWidth || targetHeight < effHeight;

  // ---- Output format -----------------------------------------------------------
  const sourceFormat = (meta.format ?? '').toLowerCase();
  let format: WatermarkOutputFormat;
  if (requestedFormat !== 'auto') {
    format = requestedFormat;
  } else if (decodeMime && MIME_TO_FORMAT[decodeMime.toLowerCase()]) {
    format = MIME_TO_FORMAT[decodeMime.toLowerCase()];
  } else if (sourceFormat === 'jpeg' || sourceFormat === 'jpg') {
    format = 'jpeg';
  } else if (sourceFormat === 'webp') {
    format = 'webp';
  } else if (sourceFormat === 'avif') {
    format = 'avif';
  } else {
    // svg / gif / tiff / heif / ico / unknown → rasterized PNG (static first frame for gif)
    format = 'png';
  }

  // ---- Overlay ------------------------------------------------------------------
  // Scale the overlay with image size so watermarks stay proportionally visible.
  const scale = clamp(Math.max(effWidth, effHeight) / 1600, 1, 4);
  const density = Math.round(72 * scale);
  const overlay = await rasterizeOverlay(buildOverlaySvg(label, style), density, maxInputPixels);

  // 叠加层必须不超出目标图像（sharp composite 限制）。小图时按比例缩放叠加层，
  // 保证图幅小于水印瓦片（如缩略图）也能正常合成，而非直接报错。
  // 输出尺寸按下方 pipeline 的 fit:'inside' 精确推算（保留宽高比），叠加层拟合到该尺寸。
  const outRatio = downscaled ? Math.min(targetWidth / effWidth, targetHeight / effHeight) : 1;
  const outWidth = Math.max(1, Math.round(effWidth * outRatio));
  const outHeight = Math.max(1, Math.round(effHeight * outRatio));
  if (overlay.width > outWidth || overlay.height > outHeight) {
    const fitted = await sharp(overlay.data)
      .resize(outWidth, outHeight, { fit: 'inside', withoutEnlargement: true })
      .toBuffer({ resolveWithObject: true });
    overlay.data = fitted.data;
    overlay.width = fitted.info.width;
    overlay.height = fitted.info.height;
  }

  let overlayOptions: Parameters<ReturnType<typeof sharp>['composite']>[0];
  if (style.position === 'tile') {
    overlayOptions = [{ input: overlay.data, tile: true, gravity: 'northwest' as const }];
  } else {
    const pad = Math.round(style.margin * scale);
    const left =
      style.corner === 'northwest' || style.corner === 'southwest'
        ? pad
        : Math.max(0, targetWidth - overlay.width - pad);
    const top =
      style.corner === 'northwest' || style.corner === 'northeast'
        ? pad
        : Math.max(0, targetHeight - overlay.height - pad);
    overlayOptions = [{ input: overlay.data, left, top }];
  }

  // ---- Decode + composite + encode ------------------------------------------------
  let pipeline = sharp(decodeSource, {
    limitInputPixels: maxInputPixels,
    failOn: 'warning',
  }).autoOrient();
  if (downscaled) {
    pipeline = pipeline.resize(targetWidth, targetHeight, {
      fit: 'inside',
      withoutEnlargement: true,
      fastShrinkOnLoad: true,
    });
  }
  pipeline = pipeline.composite(overlayOptions);
  if (format === 'jpeg') {
    pipeline = pipeline.flatten({ background });
    pipeline = pipeline.jpeg({ quality: quality ?? 85, mozjpeg: true });
  } else if (format === 'png') {
    pipeline = pipeline.png();
  } else if (format === 'webp') {
    pipeline = pipeline.webp({ quality: quality ?? 85, effort: 4 });
  } else {
    pipeline = pipeline.avif({ quality: quality ?? 60, effort: 4 });
  }

  let data: Buffer;
  let info: { width: number; height: number };
  try {
    const result = await pipeline.toBuffer({ resolveWithObject: true });
    data = result.data;
    info = result.info;
  } catch (error) {
    throw new WatermarkError(
      'ENCODE',
      `图像水印合成失败: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    data,
    mimeType: formatMime(format),
    format,
    width: info.width,
    height: info.height,
    inputPixels,
    outputPixels: info.width * info.height,
    downscaled,
    svgSanitized,
    label,
  };
}
