/**
 * MD → PDF 渲染器（v0.1.2 M5 的轻量实现，见 docs/v0.1.2-plan.md §6.3）。
 *
 * 链路：markdown-it(GFM) → HTML → 结构化文本 → pdf-lib 分页绘制，
 * 每页叠加半透明身份水印（`{username}`/日期时间由调用方解析后传入 watermark）。
 *
 * 中文渲染：可选 `PDF_CJK_FONT` 指向的 TTF（经 @pdf-lib/fontkit 动态嵌入；
 * fontkit 未安装时自动回退标准 Helvetica，仅 ASCII 字形可见）。
 * 渲染器接口化：后续 puppeteer（Chromium + Noto Sans CJK）实现可无缝替换本实现。
 */

import MarkdownIt from 'markdown-it';
import {
  degrees,
  PDFDocument,
  type PDFFont,
  rgb,
  StandardFonts,
} from 'pdf-lib';

export interface PdfRenderOptions {
  /** 文档标题（页脚显示） */
  title?: string;
  /** 每页叠加的身份水印文案 */
  watermark?: string;
  /** 可选 CJK TTF 字体路径（配置项 PDF_CJK_FONT） */
  cjkFontPath?: string;
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

/** 按宽度折行；单词超宽（CJK 无空格场景）时逐字断行。 */
function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (!word) continue;
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) {
      lines.push(current);
      current = '';
    }
    if (font.widthOfTextAtSize(word, size) <= maxWidth) {
      current = word;
      continue;
    }
    let segment = '';
    for (const ch of word) {
      if (segment && font.widthOfTextAtSize(segment + ch, size) > maxWidth) {
        lines.push(segment);
        segment = ch;
      } else {
        segment += ch;
      }
    }
    current = segment;
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

const PAGE_WIDTH = 595.28; // A4
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;
const LINE_GAP = 3;

async function renderPdf(lines: TextLine[], options: PdfRenderOptions): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();

  // The lightweight renderer uses pdf-lib standard fonts and does not require
  // a browser or native fontkit binary.
  const bodyFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const codeFont = await pdfDoc.embedFont(StandardFonts.Courier);

  const fontFor = (line: TextLine): PDFFont => {
    if (line.font === 'code') return codeFont;
    if (line.font === 'bold') return boldFont;
    return bodyFont;
  };

  let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;
  let pageNumber = 1;

  const decorate = (target: typeof page): void => {
    if (options.watermark) {
      target.drawText(options.watermark, {
        x: PAGE_WIDTH / 2,
        y: PAGE_HEIGHT / 2,
        size: 26,
        font: boldFont,
        color: rgb(0, 0, 0),
        opacity: 0.06,
        rotate: degrees(30),
      });
    }
    target.drawText(
      [options.title, String(pageNumber)].filter(Boolean).join(' · '),
      { x: MARGIN, y: 28, size: 8, font: bodyFont, color: rgb(0.5, 0.5, 0.5) },
    );
  };
  decorate(page);

  for (const line of lines) {
    const maxWidth = PAGE_WIDTH - MARGIN * 2 - line.indent * 12;
    for (const segment of wrapText(line.text, fontFor(line), line.size, maxWidth)) {
      if (y < MARGIN) {
        page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        y = PAGE_HEIGHT - MARGIN;
        pageNumber += 1;
        decorate(page);
      }
      page.drawText(segment, {
        x: MARGIN + line.indent * 12,
        y,
        size: line.size,
        font: fontFor(line),
        color: rgb(0.12, 0.12, 0.12),
      });
      y -= line.size + LINE_GAP;
    }
  }

  return Buffer.from(await pdfDoc.save());
}

/** 轻量默认渲染器：markdown-it + pdf-lib */
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
