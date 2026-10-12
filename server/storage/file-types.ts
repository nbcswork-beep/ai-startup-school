// Homework attachment types. The extension decides the canonical MIME type; the client-supplied
// type is never trusted, and the stored bytes must carry the matching signature.

const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const EMPTY_ZIP = [0x50, 0x4b, 0x05, 0x06];

type Signature = (bytes: Uint8Array) => boolean;
const startsWith = (prefix: number[]): Signature => bytes => prefix.every((value, index) => bytes[index] === value);
const zipContainer: Signature = bytes => startsWith(ZIP)(bytes);

// Plain text: UTF-8 without NUL bytes, or UTF-16 with a byte-order mark.
const plainText: Signature = bytes => {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return true;
  if (bytes.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(trimIncompleteUtf8(bytes)); return true; } catch { return false; }
};

/** A sample may end in the middle of a multi-byte character; drop that partial tail before decoding. */
function trimIncompleteUtf8(bytes: Uint8Array): Uint8Array {
  let end = bytes.length;
  for (let back = 1; back <= 3 && end - back >= 0; back++) {
    const byte = bytes[end - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    if (width > back) end -= back;
    break;
  }
  return bytes.subarray(0, end);
}

export const HOMEWORK_FILE_TYPES = {
  pdf: { mimeType: 'application/pdf', label: 'PDF', kind: 'pdf', signature: startsWith(PDF) },
  doc: { mimeType: 'application/msword', label: 'DOC', kind: 'document', signature: startsWith(OLE) },
  docx: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', label: 'DOCX', kind: 'document', signature: zipContainer },
  pptx: { mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', label: 'PPTX', kind: 'presentation', signature: zipContainer },
  xlsx: { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label: 'XLSX', kind: 'spreadsheet', signature: zipContainer },
  txt: { mimeType: 'text/plain', label: 'TXT', kind: 'text', signature: plainText },
  png: { mimeType: 'image/png', label: 'PNG', kind: 'image', signature: startsWith(PNG) },
  jpg: { mimeType: 'image/jpeg', label: 'JPG', kind: 'image', signature: startsWith(JPEG) },
  jpeg: { mimeType: 'image/jpeg', label: 'JPEG', kind: 'image', signature: startsWith(JPEG) },
  zip: { mimeType: 'application/zip', label: 'ZIP', kind: 'archive', signature: (bytes: Uint8Array) => startsWith(ZIP)(bytes) || startsWith(EMPTY_ZIP)(bytes) }
} as const;

export type HomeworkFileExtension = keyof typeof HOMEWORK_FILE_TYPES;
export const HOMEWORK_FILE_EXTENSIONS = Object.keys(HOMEWORK_FILE_TYPES) as HomeworkFileExtension[];
/** Bytes read back from storage to verify the signature. */
export const SIGNATURE_SAMPLE_BYTES = 4096;

export function fileExtension(name: string): string {
  const match = /\.([^.]+)$/.exec(name.trim());
  return match ? match[1]!.toLowerCase() : '';
}

export function isHomeworkFileExtension(value: string): value is HomeworkFileExtension {
  return Object.hasOwn(HOMEWORK_FILE_TYPES, value);
}

export function matchesSignature(extension: HomeworkFileExtension, sample: Uint8Array): boolean {
  return sample.length > 0 && HOMEWORK_FILE_TYPES[extension].signature(sample);
}

/** Display name shown to people: no paths, control or bidi characters, bounded length. */
export function cleanDisplayName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.normalize('NFC').replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 160) return cleaned;
  const extension = fileExtension(cleaned);
  const suffix = extension ? `.${extension}` : '';
  return `${cleaned.slice(0, 160 - suffix.length).trimEnd()}${suffix}`;
}

/** Storage key segment: letters, digits, dot, dash, underscore. Never contains a slash. */
export function storageSafeName(name: string, extension: HomeworkFileExtension): string {
  const stem = name.slice(0, name.length - extension.length - 1)
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 80);
  return `${stem || 'file'}.${extension}`;
}
