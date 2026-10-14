import { readZipEntries, readZipEntry, ZipFormatError, type ZipEntry } from '../zip.js';
import { cleanText, decodeText, matchesKind, type DocumentKind } from './formats.js';
import { htmlToMarkdown, markdownTable } from './markdown.js';
import { parseCsv } from './csv.js';

/**
 * Reads uploaded documents into Markdown the model understands: headings, lists and tables keep
 * their structure, Cyrillic stays intact. Libraries load lazily so routes that never read a document
 * do not pay for them. Every reader has hard limits: a small file must not expand into gigabytes.
 */

export const MAX_DOCUMENT_CHARS = 250_000;
const MAX_UNPACKED_BYTES = 120 * 1024 * 1024;
const MAX_SHEET_ROWS = 400;
const MAX_SHEET_COLUMNS = 40;
const MAX_PDF_PAGES = 400;

export class DocumentReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentReadError';
  }
}

export interface ExtractedDocument {
  kind: DocumentKind;
  /** The content as Markdown. */
  text: string;
  pages?: number;
  slides?: number;
  sheets?: Array<{ name: string; rows: number; columns: number }>;
  /** Headings or slide titles, for previews and for the model's overview. */
  outline: string[];
  /** A PDF made of images: there is no text layer to read. */
  scanned?: boolean;
  truncated: boolean;
  warnings: string[];
}

function limit(text: string, warnings: string[]): { text: string; truncated: boolean } {
  const clean = cleanText(text).trim();
  if (clean.length <= MAX_DOCUMENT_CHARS) return { text: clean, truncated: false };
  warnings.push(`Документ довгий: ШІ отримає перші ${Math.round(MAX_DOCUMENT_CHARS / 1000)} тис. символів.`);
  return { text: `${clean.slice(0, MAX_DOCUMENT_CHARS)}\n\n[…документ обрізано…]`, truncated: true };
}

function headingsOf(markdown: string): string[] {
  return [...markdown.matchAll(/^#{1,3}\s+(.+)$/gm)].map(match => match[1]!.trim()).slice(0, 40);
}

/** Office files are ZIP containers: refuse ones that would unpack into something enormous. */
function checkContainer(bytes: Buffer): ZipEntry[] {
  let entries: ZipEntry[];
  try { entries = readZipEntries(bytes, 20_000); }
  catch (error) { throw new DocumentReadError(error instanceof ZipFormatError ? `Файл пошкоджений: ${error.message.toLowerCase()}.` : 'Файл пошкоджений.'); }
  const unpacked = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (unpacked > MAX_UNPACKED_BYTES) throw new DocumentReadError('Файл розпаковується в надто великий обсяг даних.');
  if (entries.some(entry => entry.flags & 0x0001)) throw new DocumentReadError('Файл захищений паролем. Зніміть пароль і прикріпіть ще раз.');
  return entries;
}

export async function extractDocument(kind: DocumentKind, bytes: Buffer): Promise<ExtractedDocument> {
  if (!matchesKind(kind, bytes)) {
    throw new DocumentReadError(`Вміст файлу не схожий на ${kind.toUpperCase()}. Можливо, файл просто перейменовано — збережіть його у потрібному форматі.`);
  }
  switch (kind) {
    case 'jpg': case 'png': case 'webp': throw new DocumentReadError('Фотографії передаються моделі окремо.');
    case 'pdf': return readPdf(bytes);
    case 'docx': return readDocx(bytes);
    case 'xlsx': return readXlsx(bytes);
    case 'csv': return readCsv(bytes);
    case 'pptx': return readPptx(bytes);
    case 'txt':
    case 'md': {
      const warnings: string[] = [];
      const { text, truncated } = limit(decodeText(bytes), warnings);
      if (!text) throw new DocumentReadError('Файл порожній.');
      return { kind, text, outline: kind === 'md' ? headingsOf(text) : [], truncated, warnings };
    }
    case 'zip': throw new DocumentReadError('ZIP-архіви читаються окремо.');
  }
}

// ---------------------------------------------------------------------------------------------
// PDF: text with positions and sizes; lines are rebuilt, larger lines become headings.

interface PdfLine { text: string; size: number; y: number }

async function readPdf(bytes: Buffer): Promise<ExtractedDocument> {
  const { getDocumentProxy, extractTextItems } = await import('unpdf');
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes));
  } catch (error) {
    const name = (error as { name?: string })?.name ?? '';
    if (name === 'PasswordException') throw new DocumentReadError('PDF захищений паролем. Зніміть пароль і прикріпіть ще раз.');
    throw new DocumentReadError('PDF пошкоджений або не відкривається.');
  }
  try {
    const warnings: string[] = [];
    if (pdf.numPages > MAX_PDF_PAGES) throw new DocumentReadError(`У PDF ${pdf.numPages} сторінок; можна до ${MAX_PDF_PAGES}.`);
    const { totalPages, items } = await extractTextItems(pdf);
    const pages: PdfLine[][] = items.map(pageItems => {
      const sorted = pageItems.filter(item => item.str.trim() || item.str === ' ').sort((a, b) => b.y - a.y || a.x - b.x);
      const lines: Array<PdfLine & { right: number }> = [];
      for (const item of sorted) {
        const size = item.fontSize || item.height || 10;
        const line = lines[lines.length - 1];
        if (line && Math.abs(line.y - item.y) < size * 0.5) {
          const gap = item.x - line.right;
          line.text += gap > size * 0.2 && !line.text.endsWith(' ') && !item.str.startsWith(' ') ? ` ${item.str}` : item.str;
          line.size = Math.max(line.size, size);
          line.right = item.x + item.width;
        } else {
          lines.push({ text: item.str, size, y: item.y, right: item.x + item.width });
        }
      }
      return lines.map(({ text, size, y }) => ({ text: text.replace(/\s+/g, ' ').trim(), size, y })).filter(line => line.text);
    });
    const characters = pages.flat().reduce((sum, line) => sum + line.text.length, 0);
    let outline: string[] = [];
    try {
      const bookmarks = await pdf.getOutline();
      outline = (bookmarks ?? []).map(item => String(item.title ?? '').trim()).filter(Boolean).slice(0, 40);
    } catch { outline = []; }
    // Under ~25 characters a page there is no real text layer: a scan or photos of pages.
    if (characters < Math.max(40, totalPages * 25)) {
      return { kind: 'pdf', text: '', pages: totalPages, outline, scanned: true, truncated: false, warnings: ['Це сканований PDF без текстового шару.'] };
    }
    // The body size is the size most characters are set in; clearly larger short lines are headings.
    const weights = new Map<number, number>();
    for (const line of pages.flat()) weights.set(Math.round(line.size), (weights.get(Math.round(line.size)) ?? 0) + line.text.length);
    const body = [...weights].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10;
    const parts: string[] = [];
    pages.forEach((lines, index) => {
      parts.push(`<!-- сторінка ${index + 1} -->`);
      let paragraph: string[] = [];
      let previous: PdfLine | null = null;
      const flush = () => { if (paragraph.length) parts.push(paragraph.join(' ').replace(/(\p{L})- (\p{Ll})/gu, '$1$2')); paragraph = []; };
      for (const line of lines) {
        const ratio = line.size / body;
        const heading = ratio >= 1.25 && line.text.length <= 140 && !/[.,;:]$/.test(line.text);
        const bullet = /^([•▪●◦‣∙·–—-]|\d{1,2}[.)])\s+/.test(line.text);
        const gap = previous ? previous.y - line.y : 0;
        if (heading) {
          flush();
          parts.push(`${ratio >= 1.6 ? '#' : ratio >= 1.35 ? '##' : '###'} ${line.text}`);
        } else if (bullet) {
          flush();
          parts.push(line.text.replace(/^[•▪●◦‣∙·–—]\s+/, '- '));
        } else {
          if (previous && gap > line.size * 1.75) flush();
          paragraph.push(line.text);
        }
        previous = line;
      }
      flush();
    });
    const { text, truncated } = limit(parts.join('\n\n'), warnings);
    warnings.push('Таблиці з PDF передаються як текст: PDF не зберігає їхню структуру.');
    return { kind: 'pdf', text, pages: totalPages, outline: outline.length ? outline : headingsOf(text), truncated, warnings };
  } finally {
    await (pdf as unknown as { loadingTask?: { destroy(): Promise<void> } }).loadingTask?.destroy().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------
// Word: mammoth turns the document into semantic HTML (headings, lists, tables); that becomes Markdown.

async function readDocx(bytes: Buffer): Promise<ExtractedDocument> {
  checkContainer(bytes);
  const mammoth = (await import('mammoth')).default;
  let html: string;
  try {
    html = (await mammoth.convertToHtml({ buffer: bytes }, { includeDefaultStyleMap: true, ignoreEmptyParagraphs: true, styleMap: ["p[style-name='Title'] => h1:fresh", "p[style-name='Subtitle'] => h2:fresh"], convertImage: mammoth.images.imgElement(async () => ({ src: '' })) })).value;
  } catch {
    throw new DocumentReadError('Документ Word пошкоджений або не відкривається.');
  }
  const warnings: string[] = [];
  const markdown = htmlToMarkdown(html);
  if (!markdown.trim()) throw new DocumentReadError('У документі немає тексту.');
  if (/<img\b/i.test(html)) warnings.push('Зображення з документа ШІ не бачить — лише текст і таблиці.');
  const { text, truncated } = limit(markdown, warnings);
  return { kind: 'docx', text, outline: headingsOf(text), truncated, warnings };
}

// ---------------------------------------------------------------------------------------------
// Excel and CSV: every sheet becomes a Markdown table.

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, value.getUTCHours() || value.getUTCMinutes() ? 16 : 10).replace('T', ' ');
  if (typeof value === 'object') {
    const object = value as { richText?: Array<{ text: string }>; text?: unknown; result?: unknown; error?: string; hyperlink?: string; formula?: string };
    if (Array.isArray(object.richText)) return object.richText.map(part => part.text).join('');
    if ('result' in object) return cellText(object.result);
    if (object.error) return String(object.error);
    if (object.text !== undefined) return cellText(object.text);
    return '';
  }
  return String(value);
}

async function readXlsx(bytes: Buffer): Promise<ExtractedDocument> {
  checkContainer(bytes);
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(bytes as unknown as ArrayBuffer); }
  catch { throw new DocumentReadError('Файл Excel пошкоджений або не відкривається.'); }
  const warnings: string[] = [];
  const sheets: NonNullable<ExtractedDocument['sheets']> = [];
  const parts: string[] = [];
  workbook.eachSheet(sheet => {
    const rows: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, row => {
      const cells: string[] = [];
      const count = Math.min(sheet.actualColumnCount || row.cellCount, MAX_SHEET_COLUMNS);
      for (let column = 1; column <= count; column += 1) cells.push(cellText(row.getCell(column).value));
      if (cells.some(cell => cell.trim())) rows.push(cells);
    });
    const columns = Math.max(0, ...rows.map(row => row.length));
    sheets.push({ name: sheet.name, rows: rows.length, columns });
    parts.push(`## Аркуш «${sheet.name}»`);
    if (!rows.length) { parts.push('_Аркуш порожній._'); return; }
    if (rows.length > MAX_SHEET_ROWS) warnings.push(`Аркуш «${sheet.name}»: показано перші ${MAX_SHEET_ROWS} з ${rows.length} рядків.`);
    if ((sheet.actualColumnCount || 0) > MAX_SHEET_COLUMNS) warnings.push(`Аркуш «${sheet.name}»: показано перші ${MAX_SHEET_COLUMNS} стовпців.`);
    parts.push(markdownTable(rows[0]!, rows.slice(1, MAX_SHEET_ROWS)));
  });
  if (!sheets.length) throw new DocumentReadError('У файлі немає аркушів.');
  const { text, truncated } = limit(parts.join('\n\n'), warnings);
  return { kind: 'xlsx', text, sheets, outline: sheets.map(sheet => sheet.name), truncated, warnings };
}

async function readCsv(bytes: Buffer): Promise<ExtractedDocument> {
  const rows = parseCsv(decodeText(bytes));
  if (!rows.length) throw new DocumentReadError('Файл порожній.');
  const warnings: string[] = [];
  if (rows.length > MAX_SHEET_ROWS) warnings.push(`Показано перші ${MAX_SHEET_ROWS} з ${rows.length} рядків.`);
  const columns = Math.max(...rows.map(row => row.length));
  const table = markdownTable(rows[0]!.slice(0, MAX_SHEET_COLUMNS), rows.slice(1, MAX_SHEET_ROWS).map(row => row.slice(0, MAX_SHEET_COLUMNS)));
  const { text, truncated } = limit(table, warnings);
  return { kind: 'csv', text, sheets: [{ name: 'CSV', rows: rows.length, columns }], outline: [], truncated, warnings };
}

// ---------------------------------------------------------------------------------------------
// PowerPoint: slides are XML inside the ZIP. Titles come from the title placeholder.

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return XML_ENTITIES[entity.toLowerCase()] ?? '';
  });
}

function paragraphsOf(xml: string): string[] {
  return [...xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)]
    .map(match => [...match[1]!.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(run => decodeXml(run[1]!)).join(''))
    .map(text => text.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

async function readPptx(bytes: Buffer): Promise<ExtractedDocument> {
  const entries = checkContainer(bytes);
  const read = (entry: ZipEntry) => readZipEntry(bytes, entry, 8 * 1024 * 1024).toString('utf8');
  const slideNumber = (path: string) => Number(/slide(\d+)\.xml$/.exec(path)?.[1] ?? 0);
  const slides = entries.filter(entry => /^ppt\/slides\/slide\d+\.xml$/.test(entry.path)).sort((a, b) => slideNumber(a.path) - slideNumber(b.path));
  const notes = new Map(entries.filter(entry => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(entry.path)).map(entry => [Number(/(\d+)\.xml$/.exec(entry.path)?.[1] ?? 0), entry]));
  if (!slides.length) throw new DocumentReadError('У презентації немає слайдів.');
  const warnings: string[] = [];
  const outline: string[] = [];
  const parts: string[] = [];
  let pictures = false;
  slides.forEach((entry, index) => {
    const xml = read(entry);
    if (/<p:pic\b/.test(xml)) pictures = true;
    const shapes = [...xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)].map(match => match[0]);
    const isTitle = (shape: string) => /<p:ph\b[^>]*type="(title|ctrTitle)"/.test(shape);
    let titleShapes = shapes.filter(isTitle);
    if (!titleShapes.length) {
      const first = shapes.find(shape => paragraphsOf(shape).length);
      if (first && paragraphsOf(first).length === 1 && paragraphsOf(first)[0]!.length <= 120) titleShapes = [first];
    }
    const title = titleShapes.flatMap(paragraphsOf).join(' ');
    const body = shapes.filter(shape => !titleShapes.includes(shape)).flatMap(paragraphsOf);
    const tables = [...xml.matchAll(/<a:tbl\b[\s\S]*?<\/a:tbl>/g)].map(match => [...match[0].matchAll(/<a:tr\b[\s\S]*?<\/a:tr>/g)].map(row => [...row[0].matchAll(/<a:tc\b[\s\S]*?<\/a:tc>/g)].map(cell => paragraphsOf(cell[0]).join(' '))));
    outline.push(title || `Слайд ${index + 1}`);
    parts.push(`## Слайд ${index + 1}${title ? `: ${title}` : ''}`);
    if (body.length) parts.push(body.map(line => `- ${line}`).join('\n'));
    for (const rows of tables) if (rows.length) parts.push(markdownTable(rows[0]!, rows.slice(1)));
    const note = notes.get(slideNumber(entry.path));
    if (note) {
      const text = paragraphsOf(read(note)).filter(line => !/^\d+$/.test(line)).join(' ');
      if (text) parts.push(`> Нотатки: ${text}`);
    }
  });
  if (pictures) warnings.push('Зображення на слайдах ШІ не бачить — лише текст і таблиці.');
  const { text, truncated } = limit(parts.join('\n\n'), warnings);
  return { kind: 'pptx', text, slides: slides.length, outline, truncated, warnings };
}
