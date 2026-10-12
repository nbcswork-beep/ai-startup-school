import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile, open } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

/** Where the browser sends the file bytes: a short-lived URL that accepts exactly one object. */
export interface UploadTarget {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
}

export interface StoredObject {
  size: number;
  contentType: string;
}

/**
 * Durable object storage for private homework files. Implementations never expose a credential to
 * the client; every URL they return is scoped to one pathname and expires.
 */
export interface FileStorage {
  readonly kind: 'vercel-blob' | 'local-dev';
  createUploadTarget(input: { pathname: string; contentType: string; size: number; expiresAt: number }): Promise<UploadTarget>;
  head(pathname: string): Promise<StoredObject | null>;
  readStart(pathname: string, bytes: number): Promise<Uint8Array>;
  createDownloadUrl(pathname: string, expiresAt: number): Promise<string>;
  delete(pathnames: string[]): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Vercel Blob (private store). Files go from the browser straight to the store through a presigned
// PUT, so the 4.5 MB function body limit does not apply. Reads use presigned GET URLs.

type BlobSdk = typeof import('@vercel/blob');
const BLOB_API_VERSION = '12';

export class VercelBlobFileStorage implements FileStorage {
  readonly kind = 'vercel-blob' as const;
  private sdk: Promise<BlobSdk> | undefined;
  private readToken: { value: Promise<{ delegationToken: string; clientSigningToken: string; validUntil: number }>; validUntil: number } | undefined;

  private load(): Promise<BlobSdk> {
    this.sdk ??= import('@vercel/blob');
    return this.sdk;
  }

  async createUploadTarget(input: { pathname: string; contentType: string; size: number; expiresAt: number }): Promise<UploadTarget> {
    const { issueSignedToken, presignUrl, parseStoreIdFromDelegationToken } = await this.load();
    const constraints = { allowedContentTypes: [input.contentType], maximumSizeInBytes: input.size };
    const token = await issueSignedToken({ pathname: input.pathname, operations: ['put'], validUntil: input.expiresAt, ...constraints });
    const { presignedUrl } = await presignUrl(token, {
      operation: 'put', access: 'private', pathname: input.pathname, validUntil: input.expiresAt,
      ...constraints, addRandomSuffix: false, allowOverwrite: false
    });
    // The same headers @vercel/blob sends for a presigned browser upload.
    return {
      url: presignedUrl,
      method: 'PUT',
      headers: {
        'x-api-version': BLOB_API_VERSION,
        'x-vercel-blob-access': 'private',
        'x-vercel-blob-store-id': parseStoreIdFromDelegationToken(token.delegationToken),
        'x-content-type': input.contentType,
        'x-content-length': String(input.size),
        'content-type': input.contentType
      }
    };
  }

  async head(pathname: string): Promise<StoredObject | null> {
    const { head, BlobNotFoundError } = await this.load();
    try {
      const result = await head(pathname);
      return { size: result.size, contentType: result.contentType };
    } catch (error) {
      if (error instanceof BlobNotFoundError) return null;
      throw error;
    }
  }

  async readStart(pathname: string, bytes: number): Promise<Uint8Array> {
    const { get } = await this.load();
    const result = await get(pathname, { access: 'private', useCache: false, headers: { range: `bytes=0-${bytes - 1}` } });
    if (!result || result.statusCode !== 200) return new Uint8Array();
    return readPrefix(result.stream, bytes);
  }

  async createDownloadUrl(pathname: string, expiresAt: number): Promise<string> {
    const { presignUrl } = await this.load();
    const token = await this.readDelegation(expiresAt);
    const { presignedUrl } = await presignUrl(token, { operation: 'get', access: 'private', pathname, validUntil: Math.min(expiresAt, token.validUntil) });
    return presignedUrl;
  }

  async delete(pathnames: string[]): Promise<void> {
    if (!pathnames.length) return;
    const { del } = await this.load();
    await del(pathnames);
  }

  /**
   * One store-wide read delegation per instance, renewed before it runs out. Signing an individual
   * GET URL is then a local HMAC, so listing many attachments costs no extra network round trips.
   * The signing key never leaves the server; each URL is bound to a single pathname.
   */
  private async readDelegation(neededUntil: number) {
    if (!this.readToken || this.readToken.validUntil < neededUntil) {
      const validUntil = Date.now() + 2 * 60 * 60 * 1000;
      const value = this.load().then(({ issueSignedToken }) => issueSignedToken({ pathname: '*', operations: ['get'], validUntil }));
      this.readToken = { value, validUntil };
      value.catch(() => { if (this.readToken?.value === value) this.readToken = undefined; });
    }
    return this.readToken.value;
  }
}

async function readPrefix(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length < limit) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      length += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const result = new Uint8Array(Math.min(length, limit));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, result.length - offset);
    result.set(part, offset);
    offset += part.length;
    if (offset >= result.length) break;
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Local development and tests. Same contract as the Blob store: the server hands out signed,
// expiring URLs for one pathname, and the dev routes in homework-files.ts serve them. Never used on
// Vercel: its filesystem is temporary.

export class LocalDevFileStorage implements FileStorage {
  readonly kind = 'local-dev' as const;
  private readonly secret = randomBytes(32);
  private readonly memory = new Map<string, { bytes: Uint8Array; contentType: string }>();

  /** `directory` keeps files across restarts; without it files live in memory (tests). */
  constructor(private readonly directory?: string, private readonly basePath = '/api/v1/dev-storage') {}

  async createUploadTarget(input: { pathname: string; contentType: string; size: number; expiresAt: number }): Promise<UploadTarget> {
    const token = this.sign({ op: 'put', pathname: input.pathname, contentType: input.contentType, size: input.size, exp: input.expiresAt });
    return { url: `${this.basePath}/objects?token=${token}`, method: 'PUT', headers: { 'content-type': input.contentType } };
  }

  async head(pathname: string): Promise<StoredObject | null> {
    if (!this.directory) {
      const item = this.memory.get(pathname);
      return item ? { size: item.bytes.length, contentType: item.contentType } : null;
    }
    try {
      const [info, meta] = await Promise.all([stat(this.filePath(pathname)), readFile(`${this.filePath(pathname)}.type`, 'utf8')]);
      return { size: info.size, contentType: meta };
    } catch { return null; }
  }

  async readStart(pathname: string, bytes: number): Promise<Uint8Array> {
    if (!this.directory) return this.memory.get(pathname)?.bytes.slice(0, bytes) ?? new Uint8Array();
    const handle = await open(this.filePath(pathname), 'r').catch(() => null);
    if (!handle) return new Uint8Array();
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return new Uint8Array(buffer.subarray(0, bytesRead));
    } finally { await handle.close(); }
  }

  async createDownloadUrl(pathname: string, expiresAt: number): Promise<string> {
    return `${this.basePath}/objects?token=${this.sign({ op: 'get', pathname, exp: expiresAt })}`;
  }

  async delete(pathnames: string[]): Promise<void> {
    for (const pathname of pathnames) {
      if (!this.directory) { this.memory.delete(pathname); continue; }
      await rm(this.filePath(pathname), { force: true });
      await rm(`${this.filePath(pathname)}.type`, { force: true });
    }
  }

  /** Verifies a URL token issued by this instance. Returns null when invalid or expired. */
  verify(token: string): DevStorageGrant | null {
    const [body, signature] = token.split('.');
    if (!body || !signature) return null;
    const expected = createHmac('sha256', this.secret).update(body).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    try {
      const grant = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as DevStorageGrant;
      return grant.exp >= Date.now() ? grant : null;
    } catch { return null; }
  }

  async write(grant: DevStorageGrant, bytes: Uint8Array): Promise<void> {
    if (await this.head(grant.pathname)) throw Object.assign(new Error('exists'), { code: 'EXISTS' });
    if (!this.directory) { this.memory.set(grant.pathname, { bytes: new Uint8Array(bytes), contentType: grant.contentType ?? 'application/octet-stream' }); return; }
    const path = this.filePath(grant.pathname);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    await writeFile(`${path}.type`, grant.contentType ?? 'application/octet-stream');
  }

  async read(pathname: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    if (!this.directory) return this.memory.get(pathname) ?? null;
    const object = await this.head(pathname);
    if (!object) return null;
    return { bytes: new Uint8Array(await readFile(this.filePath(pathname))), contentType: object.contentType };
  }

  private sign(grant: DevStorageGrant): string {
    const body = Buffer.from(JSON.stringify(grant)).toString('base64url');
    return `${body}.${createHmac('sha256', this.secret).update(body).digest('base64url')}`;
  }

  private filePath(pathname: string): string {
    const root = resolve(this.directory!);
    const path = resolve(join(root, ...pathname.split('/')));
    if (!path.startsWith(root + sep)) throw new Error('Invalid storage path');
    return path;
  }
}

export interface DevStorageGrant {
  op: 'put' | 'get';
  pathname: string;
  exp: number;
  contentType?: string;
  size?: number;
}

/**
 * Picks the durable store for this deployment:
 * - a connected Vercel Blob store (OIDC `BLOB_STORE_ID` or `BLOB_READ_WRITE_TOKEN`);
 * - otherwise local disk/memory, only for a developer machine or a test run;
 * - otherwise none: uploads are reported as unavailable instead of pretending to work.
 */
export function createFileStorage(input: {
  blobConfigured: boolean;
  nodeEnv: 'development' | 'test' | 'production';
  deployEnvironment: 'production' | 'preview' | 'development' | 'local';
  localDirectory?: string | undefined;
}): FileStorage | null {
  if (input.blobConfigured) return new VercelBlobFileStorage();
  if (input.deployEnvironment === 'local' && input.nodeEnv !== 'production') {
    return new LocalDevFileStorage(input.nodeEnv === 'test' ? undefined : input.localDirectory);
  }
  return null;
}
