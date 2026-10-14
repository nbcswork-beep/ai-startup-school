import { readZipEntries, ZipFormatError } from '../zip.js';

/**
 * Document kinds the assistant reads and writes. A file is accepted as a kind only when its bytes
 * really are that format: a renamed text file is never treated as a PDF or an Office document.
 */

export type DocumentKind = 'pdf' | 'docx' | 'xlsx' | 'csv' | 'pptx' | 'txt' | 'md' | 'zip';
export type OutputFormat = 'docx' | 'pdf' | 'pptx' | 'xlsx' | 'csv' | 'md' | 'txt';

export const DOCUMENT_KINDS: Record<DocumentKind, { label: string; mime: string; maxBytes: number }> = {
  pdf: { label: 'PDF', mime: 'application/pdf', maxBytes: 15 * 1024 * 1024 },
  docx: { label: 'Word', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', maxBytes: 10 * 1024 * 1024 },
  xlsx: { label: 'Excel', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', maxBytes: 10 * 1024 * 1024 },
  csv: { label: 'CSV', mime: 'text/csv', maxBytes: 5 * 1024 * 1024 },
  pptx: { label: 'PowerPoint', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', maxBytes: 20 * 1024 * 1024 },
  txt: { label: 'Текст', mime: 'text/plain', maxBytes: 2 * 1024 * 1024 },
  md: { label: 'Markdown', mime: 'text/markdown', maxBytes: 2 * 1024 * 1024 },
  zip: { label: 'ZIP', mime: 'application/zip', maxBytes: 5 * 1024 * 1024 }
};

export const OUTPUT_FORMATS: Record<OutputFormat, { label: string; mime: string; extension: string }> = {
  docx: { label: 'Word', mime: DOCUMENT_KINDS.docx.mime, extension: 'docx' },
  pdf: { label: 'PDF', mime: DOCUMENT_KINDS.pdf.mime, extension: 'pdf' },
  pptx: { label: 'PowerPoint', mime: DOCUMENT_KINDS.pptx.mime, extension: 'pptx' },
  xlsx: { label: 'Excel', mime: DOCUMENT_KINDS.xlsx.mime, extension: 'xlsx' },
  csv: { label: 'CSV', mime: 'text/csv; charset=utf-8', extension: 'csv' },
  md: { label: 'Markdown', mime: 'text/markdown; charset=utf-8', extension: 'md' },
  txt: { label: 'Текст', mime: 'text/plain; charset=utf-8', extension: 'txt' }
};

const LEGACY: Record<string, string> = { doc: 'docx', xls: 'xlsx', ppt: 'pptx', rtf: 'docx', odt: 'docx', ods: 'xlsx', odp: 'pptx' };

export function isOutputFormat(value: string): value is OutputFormat {
  return Object.hasOwn(OUTPUT_FORMATS, value);
}

/** The kind a file name asks for; old Office formats get a hint instead. */
export function kindFromName(name: string): { kind: DocumentKind } | { error: string } {
  const extension = (/\.([^.]+)$/.exec(name.trim())?.[1] ?? '').toLowerCase();
  if (Object.hasOwn(DOCUMENT_KINDS, extension)) return { kind: extension as DocumentKind };
  if (extension === 'markdown') return { kind: 'md' };
  if (LEGACY[extension]) return { error: `Формат .${extension} не підтримується. Збережіть файл як .${LEGACY[extension]} і прикріпіть ще раз.` };
  return { error: 'Можна прикріпити PDF, Word (.docx), Excel (.xlsx, .csv), PowerPoint (.pptx), .txt, .md або ZIP.' };
}

const ZIP_MARKERS: Partial<Record<DocumentKind, string>> = { docx: 'word/document.xml', xlsx: 'xl/workbook.xml', pptx: 'ppt/presentation.xml' };

/** Checks the bytes against the kind. Text kinds must be text: no NUL bytes. */
export function matchesKind(kind: DocumentKind, bytes: Buffer): boolean {
  if (kind === 'pdf') return bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'));
  if (kind === 'zip' || ZIP_MARKERS[kind]) {
    if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) return false;
    if (kind === 'zip') return true;
    try { return readZipEntries(bytes).some(entry => entry.path === ZIP_MARKERS[kind]); }
    catch (error) { if (error instanceof ZipFormatError) return false; throw error; }
  }
  return !bytes.subarray(0, 64 * 1024).includes(0);
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const cp1251 = new TextDecoder('windows-1251');

/** Text files from Ukrainian computers are often Windows-1251; UTF-8 is tried first. */
export function decodeText(bytes: Buffer): string {
  const body = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try { return utf8.decode(body); } catch { return cp1251.decode(body); }
}

/** Removes control characters a model or a document format would choke on; keeps tabs and newlines. */
export function cleanText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\n{4,}/g, '\n\n\n');
}

export function hasCyrillic(text: string): boolean {
  return /[Ѐ-ӿ]/.test(text);
}
