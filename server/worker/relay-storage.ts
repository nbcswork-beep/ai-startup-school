import type { FileStorage, StoredObject, UploadTarget } from '../storage/file-storage.js';

/**
 * Attached files for the Cloud Run worker without a storage credential. Vercel Blob has no
 * read-only token — BLOB_READ_WRITE_TOKEN can read, write, list and delete the whole store — so the
 * worker never gets one. Instead it asks Vercel, with the worker secret, for a link to one object;
 * Vercel answers only for files of the job this worker is running right now, and the link is a
 * presigned GET for that single object that expires within minutes.
 */
export class RelayFileStorage implements FileStorage {
  readonly kind = 'vercel-blob' as const;
  private jobId: string | null = null;

  constructor(private readonly config: { url: string; secret: string; fetch?: typeof fetch }) {}

  /** The job whose files may be read; set by the worker before it builds that job's prompt. */
  scope(jobId: string | null): void { this.jobId = jobId; }

  async readStart(pathname: string, bytes: number): Promise<Uint8Array> {
    if (!this.jobId) return new Uint8Array();
    const fetcher = this.config.fetch ?? fetch;
    const issued = await fetcher(`${this.config.url}/api/v1/internal/ai/jobs/${this.jobId}/file-link`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.config.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ pathname }),
      signal: AbortSignal.timeout(10_000),
      redirect: 'error'
    });
    if (!issued.ok) return new Uint8Array();
    const { url } = await issued.json() as { url?: unknown };
    if (typeof url !== 'string' || !url) return new Uint8Array();
    const target = url.startsWith('/') ? `${this.config.url}${url}` : url;
    const response = await fetcher(target, { signal: AbortSignal.timeout(60_000), redirect: 'error' });
    if (!response.ok || !response.body) return new Uint8Array();
    return readPrefix(response.body, bytes);
  }

  async head(): Promise<StoredObject | null> { return null; }
  async createUploadTarget(): Promise<UploadTarget> { throw new Error('The AI worker does not upload files'); }
  async createDownloadUrl(): Promise<string> { throw new Error('The AI worker does not issue links'); }
  async delete(): Promise<void> { throw new Error('The AI worker does not delete files'); }
}

async function readPrefix(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(Math.min(length, limit));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, Math.min(chunk.length, out.length - offset));
    out.set(part, offset);
    offset += part.length;
    if (offset >= out.length) break;
  }
  return out;
}
