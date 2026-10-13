import { deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * Minimal ZIP reading and writing for AI chat attachments: only what text archives need (stored and
 * deflated entries, UTF-8 names). Sizes are checked before and during decompression, so a small
 * archive cannot expand into gigabytes.
 */

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipFormatError';
  }
}

export interface ZipEntry {
  path: string;
  method: number;
  flags: number;
  compressedSize: number;
  size: number;
  offset: number;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

const utf8 = new TextDecoder('utf-8', { fatal: true });
let legacy: { decode(input: Uint8Array): string } | null = null;
try { legacy = new TextDecoder('ibm866'); } catch { legacy = null; }

/** Names without the UTF-8 flag: UTF-8 if valid, else the DOS Cyrillic code page Windows archivers use. */
function decodeName(bytes: Buffer, utf8Flag: boolean): string {
  if (utf8Flag) return bytes.toString('utf8');
  try { return utf8.decode(bytes); } catch { return legacy ? legacy.decode(bytes) : bytes.toString('latin1'); }
}

export function readZipEntries(buffer: Buffer, maxEntries = 2000): ZipEntry[] {
  if (buffer.length < 22) throw new ZipFormatError('Файл замалий для ZIP-архіву');
  let eocd = -1;
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 22 - 0xffff); index -= 1) {
    if (buffer.readUInt32LE(index) === EOCD) { eocd = index; break; }
  }
  if (eocd < 0) throw new ZipFormatError('Це не ZIP-архів');
  const count = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || directoryOffset === 0xffffffff) throw new ZipFormatError('Архіви ZIP64 не підтримуються');
  if (count > maxEntries) throw new ZipFormatError(`В архіві забагато записів (${count})`);
  if (directoryOffset + directorySize > buffer.length) throw new ZipFormatError('Архів пошкоджений');
  const entries: ZipEntry[] = [];
  let position = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (position + 46 > buffer.length || buffer.readUInt32LE(position) !== CENTRAL) throw new ZipFormatError('Архів пошкоджений');
    const flags = buffer.readUInt16LE(position + 8);
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    if (position + 46 + nameLength > buffer.length) throw new ZipFormatError('Архів пошкоджений');
    entries.push({
      path: decodeName(buffer.subarray(position + 46, position + 46 + nameLength), (flags & 0x0800) !== 0),
      method: buffer.readUInt16LE(position + 10),
      flags,
      compressedSize: buffer.readUInt32LE(position + 20),
      size: buffer.readUInt32LE(position + 24),
      offset: buffer.readUInt32LE(position + 42)
    });
    position += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** The entry's bytes, never more than `maxBytes` even if the archive lies about the size. */
export function readZipEntry(buffer: Buffer, entry: ZipEntry, maxBytes: number): Buffer {
  if (entry.flags & 0x0001) throw new ZipFormatError('Файл зашифровано');
  if (entry.size > maxBytes) throw new ZipFormatError('Файл завеликий');
  const position = entry.offset;
  if (position + 30 > buffer.length || buffer.readUInt32LE(position) !== LOCAL) throw new ZipFormatError('Архів пошкоджений');
  const start = position + 30 + buffer.readUInt16LE(position + 26) + buffer.readUInt16LE(position + 28);
  const end = start + entry.compressedSize;
  if (end > buffer.length) throw new ZipFormatError('Архів пошкоджений');
  const raw = buffer.subarray(start, end);
  if (entry.method === 0) {
    if (raw.length > maxBytes) throw new ZipFormatError('Файл завеликий');
    return raw;
  }
  if (entry.method === 8) {
    try { return inflateRawSync(raw, { maxOutputLength: maxBytes }); }
    catch (error) {
      if (error instanceof RangeError || (error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw new ZipFormatError('Файл завеликий');
      throw new ZipFormatError('Не вдалося розпакувати файл');
    }
  }
  throw new ZipFormatError('Непідтримуваний спосіб стиснення');
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

/** A standard ZIP of text files with UTF-8 names; entries are deflated when that is smaller. */
export function createZip(files: Array<{ path: string; content: string }>, now = new Date()): Buffer {
  const stamp = dosDateTime(now);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8');
    const data = Buffer.from(file.content, 'utf8');
    const deflated = deflateRawSync(data);
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0);
    // Made by Unix (3) with spec 2.0, so the permission bits below are read as rw-r--r--.
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 * 0x10000) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
