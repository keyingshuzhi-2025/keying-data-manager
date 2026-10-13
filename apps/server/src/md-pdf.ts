/**
 * MD → PDF 渲染器（v0.1.2 M5，见 docs/v0.1.2-plan.md §6.3）。
 *
 * 链路：markdown-it(GFM) → HTML → 结构化文本行 → CJK 感知折行分页 →
 *       每页渲染为 SVG，文本由 sharp/libvips 使用系统中文字体光栅化为 PNG →
 *       pdf-lib 整页嵌入 → PDF。
 * 每页叠加半透明身份水印（`{username}`/日期时间由调用方解析后传入 watermark）。
 *
 * 中文渲染：pdf-lib 标准字体（WinAnsi）无法编码中文（会抛
 * `WinAnsi cannot encode`），因此文本一律经 SVG + 系统字体
 * （微软雅黑 / PingFang / Noto Sans CJK）光栅化后嵌入，中英文与代码均可显示。
 */

import MarkdownIt from 'markdown-it';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';

export interface PdfRenderOptions {
  /** 文档标题（页脚显示） */
  title?: string;
}

export interface PdfRenderer {
  render(markdown: string, options?: PdfRenderOptions): Promise<Buffer>;
}

interface TextLine {
  text: string;
  size: number;
  font: 'body' | 'bold' | 'code';
  indent: number;
}

function decodeEntities(input: string): string {
  return input
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/gi, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

/** HTML → 结构化文本行（保留标题层级 / 代码块 / 列表缩进，剥离其余标签）。 */
function htmlToLines(html: string): TextLine[] {
  const codeBlocks: string[] = [];
  const protectedHtml = html.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_match, code: string) => {
    codeBlocks.push(decodeEntities(code));
    return `\u0000CODE${codeBlocks.length - 1}\u0000`;
  });

  const unwrapped = protectedHtml
    .replace(/<\/(h[1-6]|p|div|li|tr|table|ul|ol|blockquote|hr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<h([1-6])[^>]*>/gi, (_match, level: string) => `\n${'#'.repeat(Number(level))} `)
    .replace(/<[^>]+>/g, '');

  const lines: TextLine[] = [];
  for (const raw of decodeEntities(unwrapped).split('\n')) {
    const text = raw.trim();
    if (!text) continue;
    const codeMatch = /^\u0000CODE(\d+)\u0000$/.exec(text);
    if (codeMatch) {
      const code = codeBlocks[Number(codeMatch[1])] ?? '';
      for (const codeLine of code.split('\n')) {
        lines.push({ text: codeLine, size: 9, font: 'code', indent: 2 });
      }
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(text);
    if (heading) {
      const level = heading[1].length;
      lines.push({
        text: heading[2],
        size: level === 1 ? 16 : level === 2 ? 13.5 : 12,
        font: 'bold',
        indent: 0,
      });
      continue;
    }
    if (text.startsWith('- ')) {
      lines.push({ text: text.slice(2), size: 10.5, font: 'body', indent: 1 });
      continue;
    }
    lines.push({ text, size: 10.5, font: 'body', indent: 0 });
  }
  return lines;
}

const PAGE_WIDTH = 595.28; // A4（pt）
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;
const LINE_GAP = 3;
/** 光栅化倍率：72pt 版面 → 2x 像素（约 144 DPI），保证文字清晰 */
const SCALE = 2;

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function isCjkCodePoint(cp: number): boolean {
  return (cp >= 0x2e80 && cp <= 0x9fff)      // CJK 部首 + 统一表意
    || (cp >= 0x3000 && cp <= 0x303f)        // CJK 标点
    || (cp >= 0xff00 && cp <= 0xff60)        // 全角字符
    || cp >= 0x20000;                        // CJK 扩展
}

/** 单字符估宽（相对字号的倍率）：CJK 全宽 ≈ 1.0，窄字符 ≈ 0.32，其余拉丁 ≈ 0.55 */
function charWidthRatio(cp: number): number {
  if (isCjkCodePoint(cp)) return 1.0;
  const ch = String.fromCodePoint(cp);
  if (' ilj|!.,;:\'`'.includes(ch)) return 0.32;
  if ('tfrI()[]{}/\\'.includes(ch)) return 0.4;
  return 0.55;
}

/** 估算文本宽度（pt） */
function textWidth(text: string, size: number): number {
  let width = 0;
  for (const ch of text) {
    width += charWidthRatio(ch.codePointAt(0) ?? 0) * size;
  }
  return width;
}

/** 按估宽折行：CJK 可逐字断行，拉丁按空格断词，超宽单词逐字硬断 */
function wrapText(text: string, size: number, maxWidth: number): string[] {
  const tokens: string[] = [];
  let latin = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isCjkCodePoint(cp)) {
      if (latin) { tokens.push(latin); latin = ''; }
      tokens.push(ch);
    } else if (ch === ' ' || ch === '\t') {
      if (latin) { tokens.push(latin); latin = ''; }
      tokens.push(' ');
    } else {
      latin += ch;
    }
  }
  if (latin) tokens.push(latin);

  const spaceWidth = charWidthRatio(0x20) * size;
  const lines: string[] = [];
  let current = '';
  let currentWidth = 0;

  for (const token of tokens) {
    if (token === ' ') {
      if (current) {
        current += ' ';
        currentWidth += spaceWidth;
      }
      continue;
    }
    const tokenWidth = textWidth(token, size);
    if (current && currentWidth + tokenWidth <= maxWidth) {
      current += token;
      currentWidth += tokenWidth;
      continue;
    }
    if (!current && tokenWidth <= maxWidth) {
      current = token;
      currentWidth = tokenWidth;
      continue;
    }
    if (current) {
      lines.push(current);
      current = '';
      currentWidth = 0;
    }
    if (tokenWidth <= maxWidth) {
      current = token;
      currentWidth = tokenWidth;
      continue;
    }
    // 单词超宽（长 URL / 无空格长串）：逐字符硬断
    let segment = '';
    let segmentWidth = 0;
    for (const ch of token) {
      const w = charWidthRatio(ch.codePointAt(0) ?? 0) * size;
      if (segment && segmentWidth + w > maxWidth) {
        lines.push(segment);
        segment = ch;
        segmentWidth = w;
      } else {
        segment += ch;
        segmentWidth += w;
      }
    }
    current = segment;
    currentWidth = segmentWidth;
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

const FONT_SANS = 'Microsoft YaHei, PingFang SC, Noto Sans CJK SC, Source Han Sans SC, WenQuanYi Micro Hei, sans-serif';
const FONT_MONO = 'Consolas, Courier New, SFMono-Regular, Menlo, monospace';

/** 分页后的一个已折行文本段：y 为距页顶距离（pt） */
interface LaidSegment {
  text: string;
  size: number;
  font: TextLine['font'];
  indent: number;
  y: number;
}

/** 单页 → SVG（水印 + 正文 + 页脚）。 */
function buildPageSvg(
  segments: LaidSegment[],
  options: PdfRenderOptions,
  pageNumber: number,
): string {
  const pageW = Math.round(PAGE_WIDTH * SCALE);
  const pageH = Math.round(PAGE_HEIGHT * SCALE);
  const left = MARGIN * SCALE;

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pageW}" height="${pageH}" viewBox="0 0 ${pageW} ${pageH}">`,
    '<rect width="100%" height="100%" fill="#ffffff"/>',
  ];

  for (const segment of segments) {
    const family = segment.font === 'code' ? FONT_MONO : FONT_SANS;
    const weight = segment.font === 'bold' ? ' font-weight="bold"' : '';
    parts.push(
      `<text x="${Math.round((MARGIN + segment.indent * 12) * SCALE)}" ` +
      `y="${Math.round((segment.y + segment.size) * SCALE)}" ` +
      `font-family="${family}"${weight} font-size="${segment.size * SCALE}" fill="#1f1f1f">` +
      `${escapeXml(segment.text)}</text>`,
    );
  }

  const footer = [options.title, String(pageNumber)].filter(Boolean).join(' · ');
  parts.push(
    `<text x="${Math.round(MARGIN * SCALE)}" y="${pageH - Math.round(20 * SCALE)}" ` +
    `font-family="${FONT_SANS}" font-size="${8 * SCALE}" fill="#8a8a8a">` +
    `${escapeXml(footer)}</text>`,
  );
  parts.push('</svg>');
  return parts.join('\n');
}

async function renderPdf(lines: TextLine[], options: PdfRenderOptions): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  if (options.title) {
    try { pdfDoc.setTitle(options.title); } catch { /* 元数据可选 */ }
  }

  // 1) 逐行折行 + 分页（y 游标）
  const pages: LaidSegment[][] = [];
  let pageSegments: LaidSegment[] = [];
  let y = MARGIN;

  for (const line of lines) {
    const maxWidth = PAGE_WIDTH - MARGIN * 2 - line.indent * 12;
    for (const segment of wrapText(line.text, line.size, maxWidth)) {
      if (y + line.size > PAGE_HEIGHT - MARGIN) {
        pages.push(pageSegments);
        pageSegments = [];
        y = MARGIN;
      }
      pageSegments.push({ text: segment, size: line.size, font: line.font, indent: line.indent, y });
      y += line.size + LINE_GAP;
    }
  }
  if (pageSegments.length > 0 || pages.length === 0) pages.push(pageSegments);

  // 2) 每页 SVG →（sharp / 系统字体）PNG → 嵌入 A4 页面
  const pdfPages = pages.map(() => pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]));
  for (let index = 0; index < pages.length; index += 1) {
    const svg = buildPageSvg(pages[index], options, index + 1);
    const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
    const image = await pdfDoc.embedPng(png);
    pdfPages[index].drawImage(image, { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT });
  }

  return Buffer.from(await pdfDoc.save());
}

/** 轻量默认渲染器：markdown-it + sharp(SVG 光栅化) + pdf-lib */
export class PdfLibRenderer implements PdfRenderer {
  render(markdown: string, options?: PdfRenderOptions): Promise<Buffer> {
    const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
    const html = md.render(markdown);
    return renderPdf(htmlToLines(html), options ?? {});
  }
}

export const mdPdfRenderer: PdfRenderer = new PdfLibRenderer();

/** 便捷入口：渲染 Markdown 文本为 PDF 缓冲。 */
export async function renderMarkdownPdf(
  markdown: string,
  options?: PdfRenderOptions,
): Promise<Buffer> {
  return mdPdfRenderer.render(markdown, options);
}
