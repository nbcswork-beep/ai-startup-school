import { createRequire } from 'node:module';
import { toCsv, parseCsv } from './csv.js';
import { OUTPUT_FORMATS, type OutputFormat } from './formats.js';
import { blocksToText, parseMarkdown, runsText, type Block, type ListBlock, type Run } from './markdown.js';

/**
 * Builds real files from Markdown the model wrote. Each format comes from its own library, so a
 * .docx is a Word document, a .pdf is a PDF with embedded Cyrillic fonts, and so on — never renamed text.
 */

export interface FileInput { title: string; content: string; format: OutputFormat }
export type FilePreview =
  | { kind: 'outline'; items: string[] }
  | { kind: 'slides'; items: string[] }
  | { kind: 'table'; sheet: string; header: string[]; rows: string[][] }
  | { kind: 'text'; text: string };
export interface RenderedFile { bytes: Buffer; mime: string; extension: string; preview: FilePreview }

export class DocumentWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentWriteError';
  }
}

const MAX_CONTENT_CHARS = 300_000;
const BRAND = { ink: '100B28', violet: '7438F5', pink: 'F725A8', muted: '5B5170', line: 'D9D3E6', shade: 'F3F0FA' };

export async function renderFile(input: FileInput): Promise<RenderedFile> {
  const content = input.content.replace(/\r\n?/g, '\n').trim();
  if (!content) throw new DocumentWriteError('Немає вмісту для файлу.');
  if (content.length > MAX_CONTENT_CHARS) throw new DocumentWriteError('Вміст файлу завеликий.');
  const title = input.title.trim() || 'Документ';
  const meta = OUTPUT_FORMATS[input.format];
  switch (input.format) {
    case 'docx': { const blocks = withTitle(parseMarkdown(content), title); return { bytes: await renderDocx(blocks, title), mime: meta.mime, extension: meta.extension, preview: outline(blocks) }; }
    case 'pdf': { const blocks = withTitle(parseMarkdown(content), title); return { bytes: await renderPdf(blocks, title), mime: meta.mime, extension: meta.extension, preview: outline(blocks) }; }
    case 'pptx': { const slides = toSlides(parseMarkdown(content), title); return { bytes: await renderPptx(slides, title), mime: meta.mime, extension: meta.extension, preview: { kind: 'slides', items: slides.map(slide => slide.title).slice(0, 12) } }; }
    case 'xlsx': { const sheets = toSheets(content, title); return { bytes: await renderXlsx(sheets), mime: meta.mime, extension: meta.extension, preview: tablePreview(sheets[0]!) }; }
    case 'csv': { const sheet = toSheets(content, title)[0]!; return { bytes: Buffer.from(toCsv([sheet.header, ...sheet.rows]), 'utf8'), mime: meta.mime, extension: meta.extension, preview: tablePreview(sheet) }; }
    case 'md': { const text = /^#\s/m.test(content) ? content : `# ${title}\n\n${content}`; return { bytes: Buffer.from(`${text}\n`, 'utf8'), mime: meta.mime, extension: meta.extension, preview: outline(parseMarkdown(text)) }; }
    case 'txt': { const blocks = withTitle(parseMarkdown(content), title); const text = blocksToText(blocks); return { bytes: Buffer.from(`﻿${text}\n`, 'utf8'), mime: meta.mime, extension: meta.extension, preview: { kind: 'text', text: text.slice(0, 280) } }; }
  }
}

function withTitle(blocks: Block[], title: string): Block[] {
  const first = blocks[0];
  return first?.type === 'heading' && first.level === 1 ? blocks : [{ type: 'heading', level: 1, runs: [{ text: title }] }, ...blocks];
}

function outline(blocks: Block[]): FilePreview {
  const items = blocks.filter((block): block is Extract<Block, { type: 'heading' }> => block.type === 'heading' && block.level <= 2).map(block => runsText(block.runs)).slice(0, 10);
  if (items.length > 1) return { kind: 'outline', items };
  const text = blocksToText(blocks.filter(block => block.type !== 'heading')).slice(0, 280);
  return { kind: 'text', text };
}

// ---------------------------------------------------------------------------------------------
// Word

async function renderDocx(blocks: Block[], title: string): Promise<Buffer> {
  const docx = await import('docx');
  const { AlignmentType, BorderStyle, Document, ExternalHyperlink, HeadingLevel, LevelFormat, Packer, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType } = docx;
  type Child = InstanceType<typeof TextRun> | InstanceType<typeof ExternalHyperlink>;
  const runOptions = (run: Run, text: string, index: number, bold: boolean) => ({
    text,
    ...(run.bold || bold ? { bold: true } : {}),
    ...(run.italic ? { italics: true } : {}),
    ...(run.code ? { font: 'Consolas' } : {}),
    ...(index > 0 ? { break: 1 } : {})
  });
  const textRuns = (runs: Run[], extra: { bold?: boolean } = {}): Child[] => runs.flatMap((run): Child[] => {
    const parts = run.text.split('\n');
    if (run.link && /^https?:\/\//i.test(run.link)) {
      return [new ExternalHyperlink({ link: run.link, children: parts.map((text, index) => new TextRun({ ...runOptions(run, text, index, Boolean(extra.bold)), style: 'Hyperlink' })) })];
    }
    return parts.map((text, index) => new TextRun(runOptions(run, text, index, Boolean(extra.bold))));
  });
  const headingLevel = (level: number) => level <= 1 ? HeadingLevel.HEADING_1 : level === 2 ? HeadingLevel.HEADING_2 : level === 3 ? HeadingLevel.HEADING_3 : HeadingLevel.HEADING_4;
  const children: Array<InstanceType<typeof Paragraph> | InstanceType<typeof Table>> = [];
  let numberedLists = 0;
  const addList = (list: ListBlock, level: number, instance: number) => {
    for (const item of list.items) {
      children.push(new Paragraph({
        children: textRuns(item.runs),
        ...(list.ordered ? { numbering: { reference: 'numbered', level, instance } } : { bullet: { level } }),
        spacing: { after: 60 }
      }));
      if (item.sublist) addList(item.sublist, Math.min(level + 1, 2), item.sublist.ordered ? ++numberedLists : instance);
    }
  };
  blocks.forEach((block, index) => {
    switch (block.type) {
      case 'heading':
        children.push(index === 0 && block.level === 1
          ? new Paragraph({ heading: HeadingLevel.TITLE, children: textRuns(block.runs), spacing: { after: 240 } })
          : new Paragraph({ heading: headingLevel(block.level), children: textRuns(block.runs), spacing: { before: 240, after: 120 }, keepNext: true }));
        break;
      case 'paragraph': children.push(new Paragraph({ children: textRuns(block.runs), spacing: { after: 160, line: 300 } })); break;
      case 'list': addList(block, 0, block.ordered ? ++numberedLists : 0); break;
      case 'quote':
        children.push(new Paragraph({ children: textRuns(block.runs.map(run => ({ ...run, italic: true }))), indent: { left: 567 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: BRAND.violet, space: 8 } }, spacing: { after: 160 } }));
        break;
      case 'code':
        children.push(...block.text.split('\n').map(line => new Paragraph({ children: [new TextRun({ text: line || ' ', font: 'Consolas', size: 19 })], shading: { type: ShadingType.CLEAR, color: 'auto', fill: BRAND.shade }, spacing: { after: 0 } })));
        children.push(new Paragraph({ children: [], spacing: { after: 120 } }));
        break;
      case 'rule': children.push(new Paragraph({ children: [], border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: BRAND.line, space: 4 } }, spacing: { after: 200 } })); break;
      case 'table': {
        const width = Math.max(block.header.length, ...block.rows.map(row => row.length), 1);
        const cell = (runs: Run[] | undefined, header: boolean) => new TableCell({
          children: [new Paragraph({ children: textRuns(runs ?? [{ text: '' }], { bold: header }) })],
          ...(header ? { shading: { type: ShadingType.CLEAR, color: 'auto', fill: BRAND.shade } } : {}),
          margins: { top: 60, bottom: 60, left: 100, right: 100 }
        });
        const border = { style: BorderStyle.SINGLE, size: 4, color: BRAND.line };
        children.push(new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
          rows: [
            new TableRow({ tableHeader: true, children: Array.from({ length: width }, (_, column) => cell(block.header[column], true)) }),
            ...block.rows.map(row => new TableRow({ children: Array.from({ length: width }, (_, column) => cell(row[column], false)) }))
          ]
        }));
        children.push(new Paragraph({ children: [], spacing: { after: 120 } }));
        break;
      }
    }
  });
  const numberingLevels = [0, 1, 2].map(level => ({ level, format: LevelFormat.DECIMAL, text: `%${level + 1}.`, alignment: AlignmentType.START, style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } } }));
  const document = new Document({
    title, creator: 'AI Startup School',
    styles: { default: { document: { run: { font: 'Calibri', size: 23 } } } },
    numbering: { config: [{ reference: 'numbered', levels: numberingLevels }] },
    sections: [{ properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } }, children }]
  });
  return Buffer.from(await Packer.toBuffer(document));
}

// ---------------------------------------------------------------------------------------------
// PDF (pdfmake with its bundled Roboto, which has Cyrillic)

type PdfMake = { virtualfs: { writeFileSync(name: string, content: string, encoding: string): void }; setFonts(fonts: unknown): void; setUrlAccessPolicy(policy: (url: string) => boolean): void; setLocalAccessPolicy(policy: (path: string) => boolean): void; createPdf(doc: unknown): { getBuffer(): Promise<Buffer> } };
let pdfMake: PdfMake | null = null;
function pdfmakeInstance(): PdfMake {
  if (pdfMake) return pdfMake;
  const require = createRequire(import.meta.url);
  const instance = require('pdfmake') as PdfMake;
  const fonts = require('pdfmake/build/vfs_fonts') as Record<string, string>;
  for (const [name, data] of Object.entries(fonts)) instance.virtualfs.writeFileSync(name, data, 'base64');
  instance.setFonts({ Roboto: { normal: 'Roboto-Regular.ttf', bold: 'Roboto-Medium.ttf', italics: 'Roboto-Italic.ttf', bolditalics: 'Roboto-MediumItalic.ttf' } });
  // Documents never fetch anything from the network or read the server's disk: fonts come from memory.
  instance.setUrlAccessPolicy(() => false);
  instance.setLocalAccessPolicy(() => false);
  pdfMake = instance;
  return instance;
}

async function renderPdf(blocks: Block[], title: string): Promise<Buffer> {
  const pdf = pdfmakeInstance();
  const text = (runs: Run[]) => runs.map(run => ({ text: run.text, bold: run.bold, italics: run.italic, ...(run.code ? { background: '#F3F0FA' } : {}), ...(run.link ? { link: run.link, color: '#5B2BD8', decoration: 'underline' } : {}) }));
  const list = (block: ListBlock): Record<string, unknown> => ({
    [block.ordered ? 'ol' : 'ul']: block.items.map(item => item.sublist ? { stack: [{ text: text(item.runs) }, list(item.sublist)] } : { text: text(item.runs) }),
    ...(block.ordered ? { start: block.start } : {}), margin: [0, 0, 0, 8]
  });
  const content = blocks.map((block, index) => {
    switch (block.type) {
      case 'heading': return { text: text(block.runs), style: index === 0 && block.level === 1 ? 'title' : `h${block.level}` };
      case 'paragraph': return { text: text(block.runs), style: 'body' };
      case 'list': return list(block);
      case 'quote': return { table: { widths: ['*'], body: [[{ text: text(block.runs), italics: true, color: '#3B3350' }]] }, layout: { hLineWidth: () => 0, vLineWidth: (column: number) => column === 0 ? 3 : 0, vLineColor: () => '#7438F5', paddingLeft: () => 10 }, margin: [0, 2, 0, 10] };
      case 'code': return { table: { widths: ['*'], body: [[{ text: block.text, fontSize: 9, preserveLeadingSpaces: true }]] }, layout: { fillColor: () => '#F3F0FA', hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: () => 8, paddingTop: () => 6, paddingBottom: () => 6 }, margin: [0, 2, 0, 10] };
      case 'rule': return { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 483, y2: 0, lineWidth: 0.6, lineColor: '#D9D3E6' }], margin: [0, 6, 0, 12] };
      case 'table': {
        const width = Math.max(block.header.length, ...block.rows.map(row => row.length), 1);
        const row = (cells: Run[][], header: boolean) => Array.from({ length: width }, (_, column) => ({ text: text(cells[column] ?? []), bold: header, fillColor: header ? '#F3F0FA' : undefined }));
        return { table: { headerRows: 1, widths: Array.from({ length: width }, () => '*'), body: [row(block.header, true), ...block.rows.map(cells => row(cells, false))] }, layout: { hLineColor: () => '#D9D3E6', vLineColor: () => '#D9D3E6' }, fontSize: width > 5 ? 8.5 : 10, margin: [0, 2, 0, 12] };
      }
    }
  });
  const definition = {
    info: { title, creator: 'AI Startup School', producer: 'AI Startup School' },
    pageSize: 'A4', pageMargins: [56, 56, 56, 64],
    content,
    footer: (page: number, pages: number) => ({ text: `${page} / ${pages}`, alignment: 'center', fontSize: 8, color: '#8A80A0', margin: [0, 24, 0, 0] }),
    defaultStyle: { font: 'Roboto', fontSize: 10.5, lineHeight: 1.3, color: '#1C1630' },
    styles: {
      title: { fontSize: 22, bold: true, color: '#100B28', margin: [0, 0, 0, 14] },
      h1: { fontSize: 18, bold: true, color: '#100B28', margin: [0, 14, 0, 8] },
      h2: { fontSize: 15, bold: true, color: '#3A1F8F', margin: [0, 12, 0, 6] },
      h3: { fontSize: 12.5, bold: true, color: '#100B28', margin: [0, 10, 0, 4] },
      h4: { fontSize: 11, bold: true, color: '#100B28', margin: [0, 8, 0, 4] },
      body: { margin: [0, 0, 0, 8] }
    }
  };
  return Buffer.from(await pdf.createPdf(definition).getBuffer());
}

// ---------------------------------------------------------------------------------------------
// PowerPoint: one slide per «##» section (or «#» when there are no «##»); long sections continue.

interface Slide { title: string; bullets: Array<{ text: Run[]; level: number }>; table?: { header: string[]; rows: string[][] }; notes: string[] }
const MAX_BULLETS = 7;

function toSlides(blocks: Block[], title: string): Slide[] {
  const level = blocks.some(block => block.type === 'heading' && block.level === 2) ? 2 : 1;
  const slides: Slide[] = [];
  let current: Slide | null = null;
  let deckTitle = title;
  let subtitle: Run[] = [];
  const start = (name: string) => { current = { title: name, bullets: [], notes: [] }; slides.push(current); };
  for (const block of blocks) {
    if (block.type === 'heading' && block.level <= level) {
      if (block.level < level && !slides.length) { deckTitle = runsText(block.runs); continue; }
      start(runsText(block.runs));
      continue;
    }
    if (!current) {
      if (block.type === 'paragraph' && !subtitle.length) { subtitle = block.runs; continue; }
      start(deckTitle);
    }
    const slide = current!;
    switch (block.type) {
      case 'heading': slide.bullets.push({ text: [{ text: runsText(block.runs), bold: true }], level: 0 }); break;
      case 'paragraph': slide.bullets.push({ text: block.runs, level: 0 }); break;
      case 'list': for (const item of block.items) {
        slide.bullets.push({ text: item.runs, level: 0 });
        for (const sub of item.sublist?.items ?? []) slide.bullets.push({ text: sub.runs, level: 1 });
      } break;
      case 'table': slide.table = { header: block.header.map(runsText), rows: block.rows.map(row => row.map(runsText)) }; break;
      case 'quote': slide.notes.push(runsText(block.runs)); break;
      case 'code': slide.bullets.push({ text: [{ text: block.text, code: true }], level: 0 }); break;
      case 'rule': break;
    }
  }
  // Split crowded slides so text never runs off the page.
  const fitted: Slide[] = [{ title: deckTitle, bullets: subtitle.length ? [{ text: subtitle, level: 0 }] : [], notes: [] }];
  for (const slide of slides) {
    if (slide.bullets.length <= MAX_BULLETS) { fitted.push(slide); continue; }
    for (let index = 0; index < slide.bullets.length; index += MAX_BULLETS) {
      fitted.push({ title: index ? `${slide.title} (продовження)` : slide.title, bullets: slide.bullets.slice(index, index + MAX_BULLETS), ...(index === 0 && slide.table ? { table: slide.table } : {}), notes: index === 0 ? slide.notes : [] });
    }
  }
  return fitted;
}

async function renderPptx(slides: Slide[], title: string): Promise<Buffer> {
  const PptxGenJS = (await import('pptxgenjs')).default as unknown as new () => any;
  const deck = new PptxGenJS();
  deck.layout = 'LAYOUT_WIDE';
  deck.title = title;
  deck.company = 'AI Startup School';
  deck.defineSlideMaster({ title: 'COVER', background: { color: BRAND.ink }, objects: [
    { rect: { x: 0.7, y: 2.2, w: 0.12, h: 1.6, fill: { color: BRAND.pink } } },
    { placeholder: { options: { name: 'title', type: 'title', x: 1.0, y: 1.9, w: 11.3, h: 1.6, fontFace: 'Calibri', fontSize: 40, bold: true, color: 'FFFFFF', valign: 'middle' }, text: '' } }
  ] });
  deck.defineSlideMaster({ title: 'CONTENT', background: { color: 'FFFFFF' }, objects: [
    { rect: { x: 0, y: 0, w: 13.333, h: 0.12, fill: { color: BRAND.violet } } },
    { placeholder: { options: { name: 'title', type: 'title', x: 0.6, y: 0.35, w: 12.1, h: 0.9, fontFace: 'Calibri', fontSize: 28, bold: true, color: BRAND.ink, valign: 'middle' }, text: '' } }
  ] });
  slides.forEach((slide, index) => {
    const page = deck.addSlide({ masterName: index === 0 ? 'COVER' : 'CONTENT' });
    page.addText(slide.title, { placeholder: 'title', fit: 'shrink' });
    if (index === 0) {
      if (slide.bullets.length) page.addText(runsText(slide.bullets[0]!.text), { x: 1.0, y: 3.5, w: 11.3, h: 1.0, fontFace: 'Calibri', fontSize: 20, color: 'D9D3E6', valign: 'top' });
      return;
    }
    const bodyTop = 1.4;
    const tableHeight = slide.table ? Math.min(4.6, 0.4 * (slide.table.rows.length + 1)) : 0;
    if (slide.bullets.length) {
      page.addText(slide.bullets.map(bullet => ({
        text: runsText(bullet.text),
        options: { bullet: bullet.level ? { indent: 18 } : true, indentLevel: bullet.level, bold: bullet.text.every(run => run.bold), fontFace: bullet.text.some(run => run.code) ? 'Consolas' : 'Calibri', breakLine: true, paraSpaceAfter: 6 }
      })), { x: 0.7, y: bodyTop, w: 12.0, h: 5.6 - tableHeight, fontSize: 20, color: '2A2340', valign: 'top', fit: 'shrink' });
    }
    if (slide.table) {
      const width = Math.max(slide.table.header.length, ...slide.table.rows.map(row => row.length), 1);
      const pad = (cells: string[]) => Array.from({ length: width }, (_, column) => cells[column] ?? '');
      page.addTable([
        pad(slide.table.header).map(text => ({ text, options: { bold: true, fill: { color: BRAND.shade }, color: BRAND.ink } })),
        ...slide.table.rows.slice(0, 12).map(row => pad(row).map(text => ({ text })))
      ], { x: 0.7, y: slide.bullets.length ? 7.0 - tableHeight - 0.3 : bodyTop, w: 12.0, fontSize: 12, fontFace: 'Calibri', border: { type: 'solid', pt: 0.5, color: BRAND.line }, color: '2A2340', autoPage: false });
    }
    if (slide.notes.length) page.addNotes(slide.notes.join('\n'));
  });
  return Buffer.from(await deck.write({ outputType: 'nodebuffer' }) as ArrayBuffer);
}

// ---------------------------------------------------------------------------------------------
// Excel and CSV: Markdown tables (or CSV text) become sheets.

interface Sheet { name: string; header: string[]; rows: string[][] }

function toSheets(content: string, title: string): Sheet[] {
  const blocks = parseMarkdown(content);
  const sheets: Sheet[] = [];
  let label = '';
  for (const block of blocks) {
    if (block.type === 'heading') label = runsText(block.runs);
    if (block.type === 'table') sheets.push({ name: label || title, header: block.header.map(runsText), rows: block.rows.map(row => row.map(runsText)) });
  }
  if (sheets.length) return sheets;
  const rows = parseCsv(content);
  if (rows.length >= 1 && rows.some(row => row.length > 1)) return [{ name: title, header: rows[0]!, rows: rows.slice(1) }];
  throw new DocumentWriteError('Для таблиці потрібна Markdown-таблиця або CSV.');
}

function tablePreview(sheet: Sheet): FilePreview {
  return { kind: 'table', sheet: sheet.name, header: sheet.header.slice(0, 6), rows: sheet.rows.slice(0, 5).map(row => row.slice(0, 6)) };
}

/** Numbers stay numbers in Excel; codes with leading zeros and long digit strings stay text. */
function cellValue(text: string): string | number {
  const trimmed = text.trim();
  if (/^-?(0|[1-9]\d{0,14})([.,]\d+)?$/.test(trimmed)) return Number(trimmed.replace(',', '.'));
  return text;
}

async function renderXlsx(sheets: Sheet[]): Promise<Buffer> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'AI Startup School';
  const used = new Set<string>();
  for (const sheet of sheets) {
    let name = sheet.name.replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || 'Аркуш';
    for (let suffix = 2; used.has(name.toLowerCase()); suffix += 1) name = `${name.slice(0, 28)} ${suffix}`;
    used.add(name.toLowerCase());
    const worksheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    worksheet.addRow(sheet.header);
    for (const row of sheet.rows) worksheet.addRow(row.map(cellValue));
    const header = worksheet.getRow(1);
    header.font = { bold: true, color: { argb: 'FF100B28' } };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F0FA' } };
    const width = Math.max(sheet.header.length, ...sheet.rows.map(row => row.length));
    for (let column = 1; column <= width; column += 1) {
      const longest = Math.max(...[sheet.header, ...sheet.rows].map(row => String(row[column - 1] ?? '').length));
      worksheet.getColumn(column).width = Math.min(60, Math.max(8, longest + 2));
    }
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
