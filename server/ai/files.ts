import { readZipEntries, readZipEntry, ZipFormatError } from './zip.js';

/**
 * Files in AI chats. Students attach ZIP archives: the text files inside are given to the model as
 * part of the message. The model answers with files as fenced code blocks that name a path; those
 * become a ZIP the student downloads. Paths are only labels here — nothing is ever written to disk.
 */

export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_ENTRY_BYTES = 1024 * 1024;
const MAX_UNPACKED_BYTES = 8 * 1024 * 1024;
const MAX_FILE_CHARS = 120_000;
/** Keeps one archive below ~85K tokens and well inside a single storage write. */
export const MAX_ATTACHMENT_CHARS = 250_000;
const MAX_INCLUDED_FILES = 200;
const MAX_ANSWER_FILES = 100;
const MAX_ANSWER_BYTES = 2 * 1024 * 1024;

const IGNORED_DIRECTORIES = new Set(['__MACOSX', '.git', '.svn', '.hg', 'node_modules', 'bower_components', 'vendor', 'dist', 'build', 'out', '.next', '.nuxt', '.turbo', '.cache', 'coverage', '.venv', 'venv', 'env', '__pycache__', '.idea', '.gradle', 'target', 'Pods', 'DerivedData']);
const LOCK_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock', 'Pipfile.lock', 'Cargo.lock', 'composer.lock', 'Gemfile.lock', 'go.sum', 'bun.lockb']);
const BINARY_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'icns', 'tif', 'tiff', 'psd', 'heic', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'zip', 'rar', '7z', 'gz', 'tgz', 'bz2', 'xz', 'jar', 'war', 'class', 'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'obj', 'pdb', 'wasm', 'pyc', 'pyo', 'mp3', 'wav', 'ogg', 'flac', 'mp4', 'mov', 'avi', 'mkv', 'webm', 'ttf', 'otf', 'woff', 'woff2', 'eot', 'sqlite', 'db', 'apk', 'ipa', 'dmg', 'iso', 'blend', 'fbx', 'unitypackage']);

export interface ArchiveTextFile { path: string; text: string }
export interface ArchiveSkip { path: string; reason: string }

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** A relative path with forward slashes and no way out of its folder, or null. */
export function safeArchivePath(raw: string): string | null {
  const path = raw.replace(/\\/g, '/').replace(/^\.\/+/, '').trim();
  if (!path || path.length > 240 || path.startsWith('/') || /^[A-Za-z]:/.test(path) || /[\u0000-\u001f]/.test(path)) return null;
  const segments = path.split('/').filter(Boolean);
  if (!segments.length || segments.length > 12 || segments.some(segment => segment === '..' || segment === '.')) return null;
  return segments.join('/');
}

function skipReason(path: string): string | null {
  const segments = path.split('/');
  const name = segments[segments.length - 1] ?? '';
  if (segments.slice(0, -1).some(segment => IGNORED_DIRECTORIES.has(segment))) return 'службова папка';
  if (name === '.DS_Store' || name === 'Thumbs.db' || name.startsWith('._')) return 'службовий файл';
  if (LOCK_FILES.has(name)) return 'lock-файл залежностей';
  if (/^\.env(\..*)?$/.test(name) && name !== '.env.example') return 'файл із секретами';
  const extension = (/\.([^.]+)$/.exec(name)?.[1] ?? '').toLowerCase();
  if (BINARY_EXTENSIONS.has(extension) || /\.min\.(js|css)$/.test(name)) return extension ? `двійковий або згенерований файл (.${extension})` : 'двійковий файл';
  return null;
}

/** Text files from a ZIP, in archive order, with the reason for every file left out. */
export function extractArchiveText(buffer: Buffer): { files: ArchiveTextFile[]; skipped: ArchiveSkip[] } {
  const files: ArchiveTextFile[] = [];
  const skipped: ArchiveSkip[] = [];
  let unpacked = 0;
  let chars = 0;
  for (const entry of readZipEntries(buffer)) {
    if (entry.path.endsWith('/')) continue;
    const path = safeArchivePath(entry.path);
    if (!path) { skipped.push({ path: entry.path.slice(0, 120), reason: 'небезпечний шлях' }); continue; }
    const reason = skipReason(path);
    if (reason) { skipped.push({ path, reason }); continue; }
    if (files.length >= MAX_INCLUDED_FILES) { skipped.push({ path, reason: 'забагато файлів в архіві' }); continue; }
    if (entry.size > MAX_ENTRY_BYTES || unpacked + entry.size > MAX_UNPACKED_BYTES) { skipped.push({ path, reason: 'файл завеликий' }); continue; }
    let bytes: Buffer;
    try { bytes = readZipEntry(buffer, entry, Math.min(MAX_ENTRY_BYTES, MAX_UNPACKED_BYTES - unpacked)); }
    catch (error) { skipped.push({ path, reason: error instanceof ZipFormatError ? error.message.toLowerCase() : 'не вдалося прочитати' }); continue; }
    unpacked += bytes.length;
    if (!bytes.length) { skipped.push({ path, reason: 'порожній файл' }); continue; }
    let text: string;
    try { text = utf8.decode(bytes); } catch { skipped.push({ path, reason: 'не текстовий файл' }); continue; }
    if (text.includes('\u0000')) { skipped.push({ path, reason: 'не текстовий файл' }); continue; }
    text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    if (text.length > MAX_FILE_CHARS) { skipped.push({ path, reason: 'файл завеликий' }); continue; }
    if (chars + text.length > MAX_ATTACHMENT_CHARS) { skipped.push({ path, reason: 'перевищено обсяг тексту для ШІ' }); continue; }
    chars += text.length;
    files.push({ path, text });
  }
  return { files, skipped };
}

/** How an archive is shown to the model inside the student's message. */
export function renderAttachment(name: string, files: ArchiveTextFile[], skipped: ArchiveSkip[]): string {
  const parts = [`[Вкладений архів «${name}»: текстових файлів — ${files.length}]`];
  for (const file of files) parts.push(`--- файл: ${file.path} ---\n${file.text}\n--- кінець файлу ---`);
  if (skipped.length) {
    const listed = skipped.slice(0, 40).map(item => `${item.path} (${item.reason})`).join('; ');
    parts.push(`[Не передано в чат: ${listed}${skipped.length > 40 ? `; і ще ${skipped.length - 40}` : ''}]`);
  }
  return parts.join('\n\n');
}

const FENCE = /^(\s{0,3})(`{3,}|~{3,})[ \t]*([^\n`]*)$/;

function pathFromInfo(info: string): string | null | undefined {
  const attribute = /\b(?:file|filename|title|path)\s*=\s*["']?([^"'\s]+)["']?/i.exec(info);
  if (attribute?.[1]) return safeArchivePath(attribute[1]);
  for (const token of info.split(/\s+/).filter(Boolean)) {
    const candidate = /^[A-Za-z0-9+#-]{1,20}:(.+)$/.exec(token)?.[1] ?? token;
    if (/[/\\]/.test(candidate) || /\.[A-Za-z0-9]{1,10}$/.test(candidate)) {
      // Framework names that look like file names are languages, not paths.
      if (/^(node|vue|next|nuxt|react|three|d3)\.js$/i.test(candidate)) continue;
      return safeArchivePath(candidate);
    }
  }
  return undefined;
}

/** Only a standalone file label immediately above a block may supply its missing path. */
function pathFromLabel(line: string): string | null {
  let label = line.trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/^(?:📄|📁)\s*/, '')
    .replace(/:\s*$/, '').trim();
  const unwrap = () => {
    for (let i = 0; i < 3; i += 1) {
      const wrapped = /^(\*\*|__|`)(.+)\1$/.exec(label);
      if (!wrapped) break;
      label = wrapped[2]!.trim();
    }
  };
  unwrap();
  label = label.replace(/^(?:file|filename|файл)\s*:\s*/i, '').replace(/:\s*$/, '').trim();
  unwrap();
  // Do not guess names from prose, links, commands, or the code itself.
  if (!/^[\p{L}\p{N}_.\-/\\]+\.[\p{L}\p{N}]{1,10}$/u.test(label)) return null;
  if (/^(node|vue|next|nuxt|react|three|d3)\.js$/i.test(label)) return null;
  return safeArchivePath(label);
}

/** Named fenced blocks or blocks with a standalone file label above them. Later blocks win. */
export function parseAnswerFiles(text: string): Array<{ path: string; content: string }> {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const files = new Map<string, string>();
  let total = 0;
  let labelPath: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const open = FENCE.exec(lines[index]!);
    if (!open) {
      if (lines[index]!.trim()) labelPath = pathFromLabel(lines[index]!);
      continue;
    }
    const explicitPath = pathFromInfo(open[3] ?? '');
    // An explicitly unsafe path must not fall back to a different name above the block.
    const path = explicitPath === undefined ? labelPath : explicitPath;
    labelPath = null;
    const marker = open[2]!;
    const body: string[] = [];
    let closed = false;
    let cursor = index + 1;
    for (; cursor < lines.length; cursor += 1) {
      const line = lines[cursor]!;
      if (line.trim().startsWith(marker[0]!.repeat(marker.length)) && /^\s*(`{3,}|~{3,})\s*$/.test(line)) { closed = true; break; }
      body.push(line);
    }
    index = cursor;
    if (!closed) continue;
    if (!path) continue;
    const content = `${body.join('\n')}\n`;
    const size = Buffer.byteLength(content);
    if (!files.has(path) && files.size >= MAX_ANSWER_FILES) continue;
    if (total + size > MAX_ANSWER_BYTES) continue;
    total += size - Buffer.byteLength(files.get(path) ?? '');
    files.set(path, content);
  }
  return [...files].map(([path, content]) => ({ path, content }));
}
