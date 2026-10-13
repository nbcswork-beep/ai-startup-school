import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from '../errors/app-error.js';
import type { SealedSecret } from './types.js';

/**
 * Encrypts provider API keys and auth headers at rest (AES-256-GCM). The key comes from
 * AI_SECRETS_KEY (32 bytes, base64) or, when that is not set, is derived from SESSION_TOKEN_PEPPER
 * with HKDF under a label of its own, so no other secret is reused as-is. Rotating either value makes
 * stored provider keys unreadable: the admin re-enters them.
 */
export class SecretBox {
  private constructor(private readonly key: Buffer | null) {}

  static fromEnv(input: { AI_SECRETS_KEY?: string | undefined; SESSION_TOKEN_PEPPER?: string | undefined; NODE_ENV: string }): SecretBox {
    if (input.AI_SECRETS_KEY) {
      const key = Buffer.from(input.AI_SECRETS_KEY, 'base64');
      if (key.length !== 32) throw new Error('AI_SECRETS_KEY must be 32 bytes encoded as base64');
      return new SecretBox(key);
    }
    if (input.SESSION_TOKEN_PEPPER) {
      return new SecretBox(Buffer.from(hkdfSync('sha256', input.SESSION_TOKEN_PEPPER, 'aiss-ai-provider-secrets', 'provider-keys-v1', 32)));
    }
    if (input.NODE_ENV === 'test') return new SecretBox(Buffer.alloc(32, 7));
    return new SecretBox(null);
  }

  get available(): boolean { return this.key !== null; }

  seal(plain: string): SealedSecret {
    const key = this.requireKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  }

  open(sealed: SealedSecret): string {
    const key = this.requireKey();
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      throw new AppError('AI_SECRET_UNREADABLE', 500, 'Не вдалося розшифрувати ключ провайдера. Введіть ключ ще раз.');
    }
  }

  /** HMAC for short-lived links, under a key of its own derived from the master key. */
  sign(value: string): string {
    this.linkKey ??= Buffer.from(hkdfSync('sha256', this.requireKey(), 'aiss-ai-links', 'archive-links-v1', 32));
    return createHmac('sha256', this.linkKey).update(value).digest('base64url');
  }

  verify(value: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(value));
    const actual = Buffer.from(signature);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private linkKey: Buffer | undefined;

  private requireKey(): Buffer {
    if (!this.key) throw new AppError('AI_SECRETS_KEY_MISSING', 503, 'Сховище ключів ШІ не налаштовано: задайте AI_SECRETS_KEY або SESSION_TOKEN_PEPPER.');
    return this.key;
  }
}

/** Last four characters of a secret, never more. Short secrets get no hint at all. */
export function secretHint(value: string): string {
  return value.length >= 12 ? value.slice(-4) : '';
}
