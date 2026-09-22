/**
 * Markdown → PDF renderer built on `markdown-it` (parsing) and `pdf-lib` (drawing).
 *
 * Unlike the original plan's Chromium/puppeteer print pipeline, this module lays out
 * Markdown blocks (headings, paragraphs, lists, blockquotes, code fences, tables, hr)
 * directly onto A4 pages with pdf-lib standard fonts, adds per-page text watermarks
 * and optional page-number footers, and never spawns a browser.
 *
 * CJK note: pdf-lib standard fonts (Helvetica/Courier) cannot encode CJK glyphs. Pass
 * a TTF/OTF buffer via `options.font` together with an `@pdf-lib/fontkit` instance
 * (`options.fontkit`) to embed a real CJK font; otherwise non-Latin characters are
 * replaced with `?` and reported in the result's `warning`.
 */
import MarkdownIt, { type MarkdownItOptions, type Token } from 'markdown-it';
import {
  PDFDocument,
  StandardFonts,
  degrees,
  rgb,
  type PDFFont,
  type PDFPage,
  type RGB,
} from 'pdf-lib';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PdfPageSize = 'A4' | 'A5' | 'LETTER' | [number, number];

export interface PdfPageOptions {
  size: PdfPageSize;
  orientation: 'portrait' | 'landscape';
  marginTop: number;
  marginRight: number;
  marginBottom: number;
  marginLeft: number;
}

export interface PdfWatermarkSpec {
  /** Label text drawn on every page (usually from `resolveWatermarkText`). */
  text: string;
  /** 0..1 opacity. Default 0.07. */
  opacity?: number;
  /** Font size in pt. Default 54. */
  fontSize?: number;
  /** Rotation in degrees. Default 45. */
  angleDeg?: number;
  /** RGB components in 0..1. Default gray. */
  color?: [number, number, number];
}

export interface PdfTypography {
  bodySize: number;
  /** Line-height multiplier for body text. */
  lineHeight: number;
  /** Font sizes for h1..h6. */
  headingSizes: [number, number, number, number, number, number];
  codeSize: number;
  blockQuoteIndent: number;
  listIndent: number;
  paragraphGap: number;
  headingGapBefore: number;
  headingGapAfter: number;
  codeBlockGap: number;
  tableFontSize: number;
  footerSize: number;
}

export interface PdfRenderOptions {
  page?: Partial<PdfPageOptions>;
  /** Plain watermark string, or a full spec. Omit to skip the watermark. */
  watermark?: string | PdfWatermarkSpec;
  /**
   * Optional TTF/OTF font bytes (e.g. Noto Sans CJK) to embed for CJK support.
   * Requires `fontkit` (the `@pdf-lib/fontkit` peer) to be provided as well.
   */
  font?: Buffer;
  /** Instance of `@pdf-lib/fontkit`, needed only when `font` is provided. */
  fontkit?: unknown;
  /** Optional display name used when embedding `font`. */
  fontName?: string;
  /** Draw `- n / total -` footers. Default true. */
  pageNumbers?: boolean;
  typography?: Partial<PdfTypography>;
  /** Passed through to `markdown-it`. `html` is forced to `false`. */
  markdownItOptions?: MarkdownItOptions;
}

export interface PdfRenderResult {
  data: Buffer;
  pageCount: number;
  byteLength: number;
  /** True when a custom (e.g. CJK) font was embedded. */
  fontEmbedded: boolean;
  /** Set when glyphs had to be replaced (e.g. CJK without an embedded font). */
  warning: string | null;
}

export type PdfRenderErrorCode = 'EMPTY' | 'FONT' | 'LAYOUT';

export class PdfRenderError extends Error {
  constructor(
    message: string,
    public readonly code: PdfRenderErrorCode = 'LAYOUT',
  ) {
    super(message);
    this.name = 'PdfRenderError';
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const PAGE_SIZES: Record<'A4' | 'A5' | 'LETTER', [number, number]> = {
  A4: [595.28, 841.89],
  A5: [419.53, 595.28],
  LETTER: [612, 792],
};

export const DEFAULT_PDF_PAGE_OPTIONS: PdfPageOptions = {
  size: 'A4',
  orientation: 'portrait',
  marginTop: 60,
  marginRight: 56,
  marginBottom: 64,
  marginLeft: 56,
};

export const DEFAULT_PDF_TYPOGRAPHY: PdfTypography = {
  bodySize: 11,
  lineHeight: 1.5,
  headingSizes: [21, 17, 14.5, 12.5, 11.5, 11],
  codeSize: 9,
  blockQuoteIndent: 26,
  listIndent: 16,
  paragraphGap: 8,
  headingGapBefore: 18,
  headingGapAfter: 6,
  codeBlockGap: 10,
  tableFontSize: 9.5,
  footerSize: 8.5,
};

export const DEFAULT_WATERMARK_SPEC: Required<Omit<PdfWatermarkSpec, 'text'>> = {
  opacity: 0.07,
  fontSize: 54,
  angleDeg: 45,
  color: [0.45, 0.45, 0.5],
};

const COLORS = {
  body: rgb(0.13, 0.15, 0.17),
  heading: rgb(0.08, 0.1, 0.13),
  link: rgb(0.16, 0.35, 0.78),
  code: rgb(0.55, 0.2, 0.2),
  quote: rgb(0.35, 0.38, 0.42),
  muted: rgb(0.5, 0.53, 0.57),
  codeBackground: rgb(0.95, 0.96, 0.97),
  rule: rgb(0.75, 0.78, 0.82),
} as const;

const BULLETS = ['•', '–', '·'] as const;

// ---------------------------------------------------------------------------
// markdown-it factory
// ---------------------------------------------------------------------------

/** Create a markdown-it instance hardened for server use (raw HTML disabled). */
export function createMarkdownIt(options?: MarkdownItOptions): InstanceType<typeof MarkdownIt> {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    breaks: false,
    typographer: false,
    ...options,
  });
  md.enable(['table', 'strikethrough']);
  return md;
}

/** Render Markdown to safe HTML (raw HTML is escaped by markdown-it). */
export function markdownToHtml(markdown: string, options?: MarkdownItOptions): string {
  return createMarkdownIt(options).render(markdown);
}

// ---------------------------------------------------------------------------
// Internal layout model
// ---------------------------------------------------------------------------

interface StyleFlags {
  bold: boolean;
  italic: boolean;
  code: boolean;
  strike: boolean;
  link: boolean;
}

interface TextRun {
  text: string;
  font: PDFFont;
  size: number;
  color: RGB;
  strike: boolean;
  /** Absolute x (relative to content left) when set; used by table cells. */
  x?: number;
}

interface RenderLine {
  runs: TextRun[];
  /** Vertical space consumed before this line (dropped at page top). */
  gapBefore: number;
  /** Own height in pt (text lines: max run size × lineHeight). */
  height: number;
  /** Left offset of the text baseline, relative to content left edge. */
  indent: number;
  /** Hanging marker (list bullet / ordinal), drawn at `marker.x`. */
  marker?: { text: string; x: number };
  /** Keep this line together with the next one (headings). */
  keepWithNext: boolean;
  /** Lines sharing a group id are moved to the next page together when possible. */
  groupId: string | null;
  /** Code-block background rectangle across the full content width. */
  background?: RGB;
  /** Vertical rule on the left edge of the content area (blockquote). */
  quoteBorder?: boolean;
  /** Draw a horizontal rule instead of text (`hr` / table row separator). */
  rule?: 'hr' | 'table-row';
}

interface FontSet {
  body: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  boldItalic: PDFFont;
  mono: PDFFont;
  monoBold: PDFFont;
  embedded: boolean;
}

interface LayoutCtx {
  fonts: FontSet;
  typo: PdfTypography;
  page: PdfPageOptions;
  contentWidth: number;
  contentHeight: number;
  /** Running token index (mutated by layoutRange). */
  i: number;
  /** Current left indent (lists/quotes). */
  indent: number;
  /** Current list nesting depth. */
  listDepth: number;
  /** Number of glyphs replaced with `?` (non-encodable chars). */
  replacedChars: number;
  /** Group-id sequence counter. */
  groupSeq: number;
}

function forkCtx(ctx: LayoutCtx, patch: Partial<LayoutCtx>): LayoutCtx {
  return { ...ctx, ...patch };
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

const failedGlyphCache = new WeakMap<PDFFont, Set<number>>();

/**
 * Return text guaranteed encodable by a standard pdf-lib font; unencodable
 * characters (e.g. CJK in Helvetica) become `?`. Embedded fonts can encode
 * whatever their cmap contains, so they skip this filter.
 */
function safeText(font: PDFFont, text: string, ctx: LayoutCtx, filter: boolean): string {
  if (!filter) return text;
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const failed = failedGlyphCache.get(font);
    if (failed?.has(cp)) {
      out += '?';
      ctx.replacedChars += 1;
      continue;
    }
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      if (failed) failed.add(cp);
      else failedGlyphCache.set(font, new Set([cp]));
      out += '?';
      ctx.replacedChars += 1;
    }
  }
  return out;
}

async function buildFontSet(pdfDoc: PDFDocument, options: PdfRenderOptions): Promise<FontSet> {
  if (options.font) {
    if (!options.fontkit) {
      throw new PdfRenderError(
        '提供 options.font 时需同时提供 @pdf-lib/fontkit 实例（options.fontkit）以嵌入自定义字体',
        'FONT',
      );
    }
    pdfDoc.registerFontkit(options.fontkit as Parameters<typeof pdfDoc.registerFontkit>[0]);
    const embedded = await pdfDoc.embedFont(
      options.font,
      options.fontName ? { customName: options.fontName } : undefined,
    );
    return {
      body: embedded,
      bold: embedded,
      italic: embedded,
      boldItalic: embedded,
      mono: embedded,
      monoBold: embedded,
      embedded: true,
    };
  }
  const std = (name: StandardFonts): PDFFont => pdfDoc.embedStandardFont(name);
  return {
    body: std(StandardFonts.Helvetica),
    bold: std(StandardFonts.HelveticaBold),
    italic: std(StandardFonts.HelveticaOblique),
    boldItalic: std(StandardFonts.HelveticaBoldOblique),
    mono: std(StandardFonts.Courier),
    monoBold: std(StandardFonts.CourierBold),
    embedded: false,
  };
}

// ---------------------------------------------------------------------------
// Inline runs
// ---------------------------------------------------------------------------

interface InlinePart {
  text: string;
  style: StyleFlags;
}

function inlineStyleRuns(inline: Token, base: StyleFlags): InlinePart[] {
  const out: InlinePart[] = [];
  const stack: StyleFlags[] = [{ ...base }];
  const current = (): StyleFlags => stack[stack.length - 1];

  const push = (text: string, style: StyleFlags): void => {
    if (text) out.push({ text, style });
  };

  for (const child of inline.children ?? []) {
    switch (child.type) {
      case 'text':
      case 'text_special':
      case 'html_inline':
        push(child.content, current());
        break;
      case 'code_inline':
        push(child.content, { ...current(), code: true });
        break;
      case 'image':
        push(`[${child.content || '图片'}]`, { ...current(), italic: true, code: false });
        break;
      case 'softbreak':
        push(' ', current());
        break;
      case 'hardbreak':
        push('\n', current());
        break;
      case 'strong_open':
        stack.push({ ...current(), bold: true });
        break;
      case 'strong_close':
        if (stack.length > 1) stack.pop();
        break;
      case 'em_open':
        stack.push({ ...current(), italic: true });
        break;
      case 'em_close':
        if (stack.length > 1) stack.pop();
        break;
      case 's_open':
        stack.push({ ...current(), strike: true });
        break;
      case 's_close':
        if (stack.length > 1) stack.pop();
        break;
      case 'link_open':
        stack.push({ ...current(), link: true });
        break;
      case 'link_close':
        if (stack.length > 1) stack.pop();
        break;
      default:
        break;
    }
  }
  return out;
}

function styleToRun(
  part: InlinePart,
  ctx: LayoutCtx,
  overrides: { size?: number; color?: RGB } = {},
): TextRun {
  const s = part.style;
  let font = ctx.fonts.body;
  if (s.code) font = ctx.fonts.mono;
  else if (s.bold && s.italic) font = ctx.fonts.boldItalic;
  else if (s.bold) font = ctx.fonts.bold;
  else if (s.italic) font = ctx.fonts.italic;

  const size = s.code ? ctx.typo.codeSize : (overrides.size ?? ctx.typo.bodySize);
  const color = s.link ? COLORS.link : s.code ? COLORS.code : (overrides.color ?? COLORS.body);

  return { text: part.text, font, size, color, strike: s.strike };
}

// ---------------------------------------------------------------------------
// Text wrapping
// ---------------------------------------------------------------------------

function charWidth(run: TextRun, ch: string): number {
  return run.font.widthOfTextAtSize(ch, run.size);
}

function isCjk(ch: string): boolean {
  return /[\u2E80-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/.test(ch);
}

/** Wrap runs into lines that fit `maxWidth` (pt). Words break at spaces; CJK breaks per char. */
function wrapRuns(runs: TextRun[], maxWidth: number): TextRun[][] {
  const lines: TextRun[][] = [];
  let current: TextRun[] = [];
  let currentWidth = 0;
  let word: TextRun[] = [];
  let wordWidth = 0;

  const flushWord = (): void => {
    if (word.length === 0) return;
    if (currentWidth + wordWidth <= maxWidth || current.length === 0) {
      current.push(...word);
      currentWidth += wordWidth;
    } else {
      lines.push(current);
      current = word;
      currentWidth = wordWidth;
    }
    word = [];
    wordWidth = 0;
  };

  const pushCurrent = (): void => {
    if (current.length > 0) {
      lines.push(current);
      current = [];
      currentWidth = 0;
    }
  };

  for (const run of runs) {
    for (const ch of run.text) {
      if (ch === '\n') {
        flushWord();
        pushCurrent();
        continue;
      }
      const w = charWidth(run, ch);
      if (isCjk(ch)) {
        flushWord();
        word = [{ ...run, text: ch }];
        wordWidth = w;
        flushWord();
        continue;
      }
      if (ch === ' ') {
        flushWord();
        if (currentWidth + w <= maxWidth || current.length === 0) {
          current.push({ ...run, text: ch });
          currentWidth += w;
        }
        continue;
      }
      word.push({ ...run, text: ch });
      wordWidth += w;
    }
  }
  flushWord();
  pushCurrent();
  return lines.length > 0 ? lines : [[]];
}

function makeTextLines(
  runs: TextRun[],
  ctx: LayoutCtx,
  opts: {
    gapBefore: number;
    keepWithNext: boolean;
    groupId: string | null;
    indent?: number;
    background?: RGB;
    quoteBorder?: boolean;
  },
): RenderLine[] {
  const indent = opts.indent ?? ctx.indent;
  const maxWidth = Math.max(20, ctx.contentWidth - indent);
  const wrapped = wrapRuns(runs, maxWidth);
  return wrapped.map((lineRuns, index) => {
    const maxSize = lineRuns.reduce((m, r) => Math.max(m, r.size), ctx.typo.bodySize);
    return {
      runs: lineRuns,
      gapBefore: index === 0 ? opts.gapBefore : 0,
      height: Math.max(8, maxSize * ctx.typo.lineHeight),
      indent,
      keepWithNext: opts.keepWithNext,
      groupId: opts.groupId,
      background: opts.background,
      quoteBorder: opts.quoteBorder,
    };
  });
}

// ---------------------------------------------------------------------------
// Block layout over the markdown-it token stream
// ---------------------------------------------------------------------------

function nextGroupId(ctx: LayoutCtx): string {
  ctx.groupSeq += 1;
  return `g${ctx.groupSeq}`;
}

/** Find the index of the matching closing token for an opening block token. */
function findClosing(tokens: Token[], openIndex: number, openType: string, closeType: string): number {
  let depth = 0;
  for (let i = openIndex; i < tokens.length; i += 1) {
    if (tokens[i].type === openType) depth += 1;
    else if (tokens[i].type === closeType) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return tokens.length - 1;
}

function layoutInlineBlock(
  inline: Token | undefined,
  ctx: LayoutCtx,
  opts: {
    size?: number;
    color?: RGB;
    gapBefore: number;
    keepWithNext: boolean;
    groupId: string | null;
    base?: StyleFlags;
    indent?: number;
    quoteBorder?: boolean;
  },
): RenderLine[] {
  if (!inline) return [];
  const base: StyleFlags = opts.base ?? { bold: false, italic: false, code: false, strike: false, link: false };
  const parts = inlineStyleRuns(inline, base);
  const runs = parts.map((p) => styleToRun(p, ctx, { size: opts.size, color: opts.color }));
  return makeTextLines(runs, ctx, {
    gapBefore: opts.gapBefore,
    keepWithNext: opts.keepWithNext,
    groupId: opts.groupId,
    indent: opts.indent,
    quoteBorder: opts.quoteBorder,
  });
}

function layoutCodeBlock(content: string, ctx: LayoutCtx, gapBefore: number): RenderLine[] {
  const groupId = nextGroupId(ctx);
  const rawLines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  // Drop a single trailing empty line produced by the closing fence.
  if (rawLines.length > 1 && rawLines[rawLines.length - 1] === '') rawLines.pop();
  return rawLines.map((text, index) => {
    const run: TextRun = {
      text,
      font: ctx.fonts.mono,
      size: ctx.typo.codeSize,
      color: COLORS.body,
      strike: false,
    };
    return {
      runs: [run],
      gapBefore: index === 0 ? gapBefore : 0,
      height: Math.max(8, ctx.typo.codeSize * 1.35),
      indent: 0,
      keepWithNext: true,
      groupId,
      background: COLORS.codeBackground,
    };
  });
}

interface TableCellLayout {
  lines: TextRun[][];
}

/** Approximate display width of a text (CJK counts double). */
function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    w += isCjk(ch) ? 2 : 1;
  }
  return w;
}

function layoutTable(tokens: Token[], openIndex: number, ctx: LayoutCtx): RenderLine[] {
  const closeIndex = findClosing(tokens, openIndex, 'table_open', 'table_close');
  const end = Math.min(closeIndex, tokens.length - 1);

  const cellTexts: Array<Array<{ content: string; header: boolean }>> = [];
  let currentRow: Array<{ content: string; header: boolean }> | null = null;
  for (let i = openIndex + 1; i <= end; i += 1) {
    const t = tokens[i];
    if (t.type === 'tr_open') {
      currentRow = [];
    } else if (t.type === 'tr_close' && currentRow) {
      cellTexts.push(currentRow);
      currentRow = null;
    } else if ((t.type === 'th_open' || t.type === 'td_open') && currentRow) {
      const inline = tokens[i + 1];
      currentRow.push({
        content:
          inline && inline.type === 'inline'
            ? (inline.children?.map((c) => c.content).join('') ?? inline.content)
            : '',
        header: t.type === 'th_open',
      });
    }
  }
  if (cellTexts.length === 0) return [];

  const columnCount = Math.max(...cellTexts.map((row) => row.length));
  if (columnCount === 0) return [];

  // Column widths proportional to max display width per column.
  const colWeights: number[] = [];
  for (let c = 0; c < columnCount; c += 1) {
    let max = 1;
    for (const row of cellTexts) {
      if (row[c]) max = Math.max(max, displayWidth(row[c].content));
    }
    colWeights.push(max);
  }
  const totalWeight = colWeights.reduce((a, b) => a + b, 0);
  const padding = 8;
  const usable = ctx.contentWidth - padding * columnCount;
  const colLefts: number[] = [];
  const colWidths: number[] = [];
  let cursor = 0;
  for (let c = 0; c < columnCount; c += 1) {
    const raw = (colWeights[c] / totalWeight) * usable;
    const width = c === columnCount - 1 ? Math.max(20, usable - cursor) : Math.max(20, Math.floor(raw));
    colWidths.push(width);
    colLefts.push(cursor);
    cursor += width + padding;
  }

  const fontSize = ctx.typo.tableFontSize;
  const lineHeight = fontSize * ctx.typo.lineHeight;
  const out: RenderLine[] = [];

  for (let r = 0; r < cellTexts.length; r += 1) {
    const row = cellTexts[r];
    const rowCells: TableCellLayout[] = [];
    for (let c = 0; c < columnCount; c += 1) {
      const cell = row[c];
      const header = cell?.header === true;
      const runs: TextRun[] = [];
      // Cell content is laid out as plain text runs (headers bold).
      for (const word of (cell?.content ?? '').split(' ')) {
        if (word) {
          runs.push({
            text: `${word} `,
            font: header ? ctx.fonts.bold : ctx.fonts.body,
            size: fontSize,
            color: COLORS.body,
            strike: false,
          });
        }
      }
      rowCells.push({ lines: wrapRuns(runs, Math.max(20, colWidths[c])) });
    }
    const maxSlices = Math.max(...rowCells.map((cell) => cell.lines.length));
    const groupId = nextGroupId(ctx);

    for (let k = 0; k < maxSlices; k += 1) {
      const sliceRuns: TextRun[] = [];
      for (let c = 0; c < columnCount; c += 1) {
        const sliceLine = rowCells[c].lines[k];
        if (!sliceLine) continue;
        for (const run of sliceLine) {
          sliceRuns.push({ ...run, x: colLefts[c] });
        }
      }
      out.push({
        runs: sliceRuns,
        gapBefore: k === 0 && r > 0 ? ctx.typo.paragraphGap : 0,
        height: lineHeight,
        indent: 0,
        keepWithNext: true,
        groupId,
        rule: k === maxSlices - 1 ? 'table-row' : undefined,
      });
    }
  }
  return out;
}

/**
 * Layout a contiguous token range starting at `ctx.i`; stops when a token whose
 * type equals `stopAt` is reached (without consuming it), or at the end.
 */
function layoutRange(tokens: Token[], ctx: LayoutCtx, stopAt?: string): RenderLine[] {
  const out: RenderLine[] = [];
  const bodyBase: StyleFlags = { bold: false, italic: false, code: false, strike: false, link: false };

  while (ctx.i < tokens.length && tokens[ctx.i].type !== stopAt) {
    const t = tokens[ctx.i];
    switch (t.type) {
      case 'heading_open': {
        const level = Math.min(6, Math.max(1, Number(t.tag.slice(1)) || 1));
        const inline = tokens[ctx.i + 1];
        ctx.i += 2; // skip inline + heading_close
        const groupId = nextGroupId(ctx);
        const headingLines = layoutInlineBlock(inline, ctx, {
          size: ctx.typo.headingSizes[level - 1],
          color: COLORS.heading,
          gapBefore: ctx.typo.headingGapBefore,
          keepWithNext: true,
          groupId,
          base: { ...bodyBase, bold: true },
        });
        if (headingLines.length > 0) {
          headingLines[headingLines.length - 1].gapBefore = ctx.typo.headingGapAfter;
        }
        out.push(...headingLines);
        break;
      }
      case 'paragraph_open': {
        const inline = tokens[ctx.i + 1];
        ctx.i += 2;
        out.push(
          ...layoutInlineBlock(inline, ctx, {
            gapBefore: ctx.typo.paragraphGap,
            keepWithNext: false,
            groupId: null,
          }),
        );
        break;
      }
      case 'inline': {
        out.push(
          ...layoutInlineBlock(t, ctx, {
            gapBefore: ctx.typo.paragraphGap,
            keepWithNext: false,
            groupId: null,
          }),
        );
        ctx.i += 1;
        break;
      }
      case 'bullet_list_open': {
        const close = findClosing(tokens, ctx.i, 'bullet_list_open', 'bullet_list_close');
        out.push(...layoutList(tokens, ctx.i, close, ctx, false));
        ctx.i = close + 1;
        break;
      }
      case 'ordered_list_open': {
        const close = findClosing(tokens, ctx.i, 'ordered_list_open', 'ordered_list_close');
        out.push(...layoutList(tokens, ctx.i, close, ctx, true));
        ctx.i = close + 1;
        break;
      }
      case 'blockquote_open': {
        const close = findClosing(tokens, ctx.i, 'blockquote_open', 'blockquote_close');
        const inner = forkCtx(ctx, {
          i: ctx.i + 1,
          indent: ctx.indent + ctx.typo.blockQuoteIndent,
        });
        const quoteLines = layoutRange(tokens, inner, 'blockquote_close');
        ctx.i = close + 1;
        out.push(
          ...quoteLines.map((line, index) => ({
            ...line,
            quoteBorder: true,
            gapBefore: index === 0 ? ctx.typo.paragraphGap : line.gapBefore,
          })),
        );
        break;
      }
      case 'fence':
      case 'code_block': {
        out.push(...layoutCodeBlock(t.content, ctx, ctx.typo.codeBlockGap));
        ctx.i += 1;
        break;
      }
      case 'hr': {
        out.push({
          runs: [],
          gapBefore: ctx.typo.paragraphGap,
          height: 12,
          indent: 0,
          keepWithNext: false,
          groupId: null,
          rule: 'hr',
        });
        ctx.i += 1;
        break;
      }
      case 'table_open': {
        out.push(...layoutTable(tokens, ctx.i, ctx));
        const close = findClosing(tokens, ctx.i, 'table_open', 'table_close');
        ctx.i = close + 1;
        break;
      }
      case 'html_block': {
        const parts = t.content.replace(/\r\n/g, '\n').split('\n');
        const runs: TextRun[] = parts.map((text, index) => ({
          text: `${text}${index < parts.length - 1 ? '\n' : ''}`,
          font: ctx.fonts.body,
          size: ctx.typo.bodySize,
          color: COLORS.body,
          strike: false,
        }));
        out.push(
          ...makeTextLines(runs, ctx, {
            gapBefore: ctx.typo.paragraphGap,
            keepWithNext: false,
            groupId: null,
          }),
        );
        ctx.i += 1;
        break;
      }
      default:
        // list_item_open/close, *_close and unknown tokens are handled by the finders
        ctx.i += 1;
        break;
    }
  }
  return out;
}

function layoutList(
  tokens: Token[],
  openIndex: number,
  closeIndex: number,
  ctx: LayoutCtx,
  ordered: boolean,
): RenderLine[] {
  const out: RenderLine[] = [];
  const open = tokens[openIndex];
  const depth = ctx.listDepth + 1;
  const start = ordered ? Math.max(1, Math.trunc(Number(open.attrGet('start')) || 1)) : 1;
  let counter = start;

  let i = openIndex + 1;
  while (i < closeIndex) {
    if (tokens[i].type === 'list_item_open') {
      const itemClose = findClosing(tokens, i, 'list_item_open', 'list_item_close');
      const markerText = ordered ? `${counter}.` : BULLETS[(depth - 1) % BULLETS.length];
      counter += 1;
      const markerWidth = ctx.fonts.body.widthOfTextAtSize(markerText, ctx.typo.bodySize);
      const itemIndent = ctx.indent + ctx.typo.listIndent * depth;
      const bodyIndent = markerWidth + 6;

      const inner = forkCtx(ctx, {
        i: i + 1,
        indent: itemIndent + bodyIndent,
        listDepth: depth,
      });
      const itemLines = layoutRange(tokens, inner, 'list_item_close');
      if (itemLines.length > 0) {
        itemLines[0].marker = { text: markerText, x: itemIndent };
        itemLines[0].gapBefore = ctx.typo.paragraphGap;
        out.push(...itemLines);
      }
      i = itemClose + 1;
    } else {
      i += 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

function paginate(lines: RenderLine[], ctx: LayoutCtx): RenderLine[][] {
  const pages: RenderLine[][] = [];
  let current: RenderLine[] = [];
  let remaining = ctx.contentHeight;

  const pushPage = (): void => {
    if (current.length > 0) {
      pages.push(current);
      current = [];
      remaining = ctx.contentHeight;
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];

    if (current.length === 0) line = { ...line, gapBefore: 0 };

    const height = line.gapBefore + line.height;
    if (height <= remaining) {
      current.push(line);
      remaining -= height;
      continue;
    }

    // Keep-together group: try to move the whole group to the next page.
    if (line.groupId) {
      let groupLines: RenderLine[] = [];
      let groupHeight = 0;
      let j = i;
      while (j < lines.length && lines[j].groupId === line.groupId) {
        groupLines.push(lines[j]);
        groupHeight += lines[j].gapBefore + lines[j].height;
        j += 1;
      }
      if (current.length > 0 && groupHeight <= ctx.contentHeight) {
        pushPage();
        groupLines[0] = { ...groupLines[0], gapBefore: 0 };
        current.push(...groupLines);
        remaining = ctx.contentHeight - groupHeight;
        i = j - 1;
        continue;
      }
    }

    // A heading must not dangle as the last line of a page.
    if (current.length > 0 && current[current.length - 1].keepWithNext) {
      pushPage();
      line = { ...line, gapBefore: 0 };
    }

    if (current.length > 0) pushPage();

    line = { ...line, gapBefore: 0 };
    if (line.height <= ctx.contentHeight) {
      current.push(line);
      remaining = ctx.contentHeight - line.height;
    } else {
      // A single line taller than the page (pathological); clamp and continue.
      current.push(line);
      remaining = 0;
    }
  }
  pushPage();
  return pages;
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/** Watermark spec with every optional field resolved to a concrete value. */
interface ResolvedWatermarkSpec {
  text: string;
  opacity: number;
  fontSize: number;
  angleDeg: number;
  color: [number, number, number];
}

function resolveWatermarkSpec(
  watermark: string | PdfWatermarkSpec | undefined,
): ResolvedWatermarkSpec | null {
  if (watermark === undefined || watermark === '') return null;
  const partial: PdfWatermarkSpec =
    typeof watermark === 'string' ? { text: watermark } : watermark;
  return {
    text: partial.text,
    opacity: partial.opacity ?? DEFAULT_WATERMARK_SPEC.opacity,
    fontSize: partial.fontSize ?? DEFAULT_WATERMARK_SPEC.fontSize,
    angleDeg: partial.angleDeg ?? DEFAULT_WATERMARK_SPEC.angleDeg,
    color: partial.color ?? DEFAULT_WATERMARK_SPEC.color,
  };
}

function drawLineSet(page: PDFPage, lines: RenderLine[], ctx: LayoutCtx, pageHeight: number): void {
  const left = ctx.page.marginLeft;
  const contentWidth = ctx.contentWidth;
  let y = pageHeight - ctx.page.marginTop;

  for (const line of lines) {
    y -= line.gapBefore;

    if (line.rule === 'hr') {
      page.drawRectangle({ x: left, y: y - 7, width: contentWidth, height: 1, color: COLORS.rule });
      y -= line.height;
      continue;
    }

    if (line.background) {
      page.drawRectangle({
        x: left,
        y: y - line.height * 0.92,
        width: contentWidth,
        height: line.height,
        color: line.background,
      });
    }

    if (line.quoteBorder) {
      const borderX = left + line.indent - ctx.typo.blockQuoteIndent + 2;
      page.drawRectangle({
        x: borderX,
        y: y - line.height * 0.92,
        width: 2.5,
        height: line.height,
        color: COLORS.quote,
      });
    }

    const sizes = line.runs.map((r) => r.size);
    const maxSize = sizes.length > 0 ? Math.max(...sizes) : ctx.typo.bodySize;
    const baseline = y - maxSize * 0.88;

    if (line.marker) {
      page.drawText(line.marker.text, {
        x: left + line.marker.x,
        y: baseline,
        size: ctx.typo.bodySize,
        font: ctx.fonts.body,
        color: COLORS.body,
      });
    }

    let x = left + line.indent;
    for (const run of line.runs) {
      const text = safeText(run.font, run.text, ctx, !ctx.fonts.embedded);
      const drawX = run.x !== undefined ? left + run.x : x;
      page.drawText(text, {
        x: drawX,
        y: baseline,
        size: run.size,
        font: run.font,
        color: run.color,
      });
      if (run.strike) {
        const width = run.font.widthOfTextAtSize(text, run.size);
        page.drawRectangle({
          x: drawX,
          y: baseline + run.size * 0.3,
          width,
          height: 0.7,
          color: run.color,
        });
      }
      if (run.x === undefined) x += run.font.widthOfTextAtSize(text, run.size);
    }

    if (line.rule === 'table-row') {
      page.drawRectangle({ x: left, y: y - 2, width: contentWidth, height: 0.6, color: COLORS.rule });
    }

    y -= line.height;
  }
}

function drawFooter(page: PDFPage, pageIndex: number, totalPages: number, ctx: LayoutCtx): void {
  const text = `${pageIndex + 1} / ${totalPages}`;
  const width = ctx.fonts.body.widthOfTextAtSize(text, ctx.typo.footerSize);
  page.drawText(text, {
    x: ctx.page.marginLeft + (ctx.contentWidth - width) / 2,
    y: ctx.page.marginBottom * 0.45,
    size: ctx.typo.footerSize,
    font: ctx.fonts.body,
    color: COLORS.muted,
  });
}

function drawWatermark(
  page: PDFPage,
  spec: ResolvedWatermarkSpec,
  ctx: LayoutCtx,
  pageWidth: number,
  pageHeight: number,
): void {
  const font = ctx.fonts.bold;
  const text = safeText(font, spec.text, ctx, !ctx.fonts.embedded);
  if (!text) return;
  const textWidth = font.widthOfTextAtSize(text, spec.fontSize);
  const [r, g, b] = spec.color;
  page.drawText(text, {
    x: (pageWidth - textWidth) / 2,
    y: pageHeight / 2 - spec.fontSize * 0.35,
    size: spec.fontSize,
    font,
    color: rgb(r, g, b),
    opacity: spec.opacity,
    rotate: degrees(spec.angleDeg),
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Render Markdown to a PDF buffer with a per-page text watermark. */
export async function renderMarkdownToPdf(
  markdown: string,
  options: PdfRenderOptions = {},
): Promise<PdfRenderResult> {
  if (typeof markdown !== 'string' || markdown.trim().length === 0) {
    throw new PdfRenderError('Markdown 内容为空，无法生成 PDF', 'EMPTY');
  }

  const typo: PdfTypography = { ...DEFAULT_PDF_TYPOGRAPHY, ...options.typography };
  const pageOptions: PdfPageOptions = { ...DEFAULT_PDF_PAGE_OPTIONS, ...options.page };
  const [sizeW, sizeH] =
    typeof pageOptions.size === 'string' ? PAGE_SIZES[pageOptions.size] : pageOptions.size;
  const pageWidth = pageOptions.orientation === 'landscape' ? Math.max(sizeW, sizeH) : Math.min(sizeW, sizeH);
  const pageHeight = pageOptions.orientation === 'landscape' ? Math.min(sizeW, sizeH) : Math.max(sizeW, sizeH);
  const contentWidth = pageWidth - pageOptions.marginLeft - pageOptions.marginRight;
  const contentHeight = pageHeight - pageOptions.marginTop - pageOptions.marginBottom;
  if (contentWidth < 40 || contentHeight < 40) {
    throw new PdfRenderError('页面边距设置过大，内容区域过小', 'LAYOUT');
  }

  const pdfDoc = await PDFDocument.create();
  const fonts = await buildFontSet(pdfDoc, options);
  const md = createMarkdownIt(options.markdownItOptions);
  const tokens = md.parse(markdown, {});

  const ctx: LayoutCtx = {
    fonts,
    typo,
    page: pageOptions,
    contentWidth,
    contentHeight,
    i: 0,
    indent: 0,
    listDepth: 0,
    replacedChars: 0,
    groupSeq: 0,
  };

  const lines = layoutRange(tokens, ctx);
  if (lines.length === 0) {
    throw new PdfRenderError('Markdown 未产生任何可渲染内容', 'EMPTY');
  }

  const pages = paginate(lines, ctx);
  const watermark = resolveWatermarkSpec(options.watermark);

  // Add all pages first so footers can show the total count.
  const pdfPages = pages.map(() => pdfDoc.addPage([pageWidth, pageHeight]));

  pdfPages.forEach((page, index) => {
    drawLineSet(page, pages[index], ctx, pageHeight);
    if (options.pageNumbers !== false) drawFooter(page, index, pdfPages.length, ctx);
    if (watermark) drawWatermark(page, watermark, ctx, pageWidth, pageHeight);
  });

  const bytes = await pdfDoc.save();
  const warning =
    ctx.replacedChars > 0
      ? `未嵌入中文字体，${ctx.replacedChars} 个字符被替换为 '?'（提供 options.font + options.fontkit 可消除）`
      : null;

  return {
    data: Buffer.from(bytes),
    pageCount: pdfPages.length,
    byteLength: bytes.byteLength,
    fontEmbedded: fonts.embedded,
    warning,
  };
}
