import type { FileStorage, StoredObject, UploadTarget } from './file-storage.js';

/**
 * File storage that can only read. The AI worker gets the Blob store's token (Vercel's OIDC login
 * does not work outside Vercel), and this wrapper keeps its code from writing, deleting or handing
 * out links: it reads the start of a student's attached photo or scan, nothing else.
 */
export class ReadOnlyFileStorage implements FileStorage {
  readonly kind: FileStorage['kind'];

  constructor(private readonly inner: FileStorage) {
    this.kind = inner.kind;
  }

  head(pathname: string): Promise<StoredObject | null> { return this.inner.head(pathname); }
  readStart(pathname: string, bytes: number): Promise<Uint8Array> { return this.inner.readStart(pathname, bytes); }

  async createUploadTarget(): Promise<UploadTarget> { throw new Error('Read-only storage: uploads are not allowed here'); }
  async createDownloadUrl(): Promise<string> { throw new Error('Read-only storage: links are not issued here'); }
  async delete(): Promise<void> { throw new Error('Read-only storage: deleting is not allowed here'); }
}
