import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from '../errors/app-error.js';
import type { BoundSecret, SealedSecret } from './types.js';

/**
 * Encrypts provider API keys, auth headers and plugin secrets at rest (AES-256-GCM).
 *
 * The main key (the one every stored `secret` uses) comes from AI_SECRETS_KEY (32 bytes, base64)
 * or, when that is not set, is derived from SESSION_TOKEN_PEPPER with HKDF under a label of its own.
 *
 * Moving to a new key without re-entering anything: AI_SECRETS_KEY_NEXT holds the new key. Every
 * secret then gets a second copy under it (`secretNext`), bound to the exact main copy it was made
 * from. The main copy stays as it was, so a previous deployment — which only knows the main key and
 * ignores the second copy — keeps reading everything. A Cloud Run worker gets only the new key (as
 * its AI_SECRETS_KEY) and reads the second copies. If an older deployment later changes a secret,
 * the binding no longer matches and the stale copy is never used.
 */

interface KeyEntry { id: string; key: Buffer }

/** A short, public fingerprint of a key: enough to tell keys apart in Admin OS and logs, useless to an attacker. */
export function keyId(key: Buffer): string {
  return createHash('sha256').update('aiss-ai-key-id').update(key).digest('hex').slice(0, 12);
}

/** Which main copy a second copy was made from. */
function bindingOf(secret: SealedSecret): string {
  return createHash('sha256').update(`${secret.iv}.${secret.tag}.${secret.data}`).digest('hex').slice(0, 24);
}

function decodeKey(value: string, name: string): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error(`${name} must be 32 bytes encoded as base64`);
  return key;
}

export class SecretBox {
  private readonly readKeys: KeyEntry[];

  private constructor(private readonly main: KeyEntry | null, private readonly next: KeyEntry | null, extraReadKeys: KeyEntry[] = []) {
    const all = [main, next, ...extraReadKeys].filter((entry): entry is KeyEntry => entry !== null);
    this.readKeys = all.filter((entry, index) => all.findIndex(other => other.id === entry.id) === index);
  }

  static fromEnv(input: { AI_SECRETS_KEY?: string | undefined; AI_SECRETS_KEY_NEXT?: string | undefined; SESSION_TOKEN_PEPPER?: string | undefined; NODE_ENV: string }): SecretBox {
    const entry = (key: Buffer): KeyEntry => ({ id: keyId(key), key });
    const derived = input.SESSION_TOKEN_PEPPER ? entry(Buffer.from(hkdfSync('sha256', input.SESSION_TOKEN_PEPPER, 'aiss-ai-provider-secrets', 'provider-keys-v1', 32))) : null;
    const explicit = input.AI_SECRETS_KEY ? entry(decodeKey(input.AI_SECRETS_KEY, 'AI_SECRETS_KEY')) : null;
    const next = input.AI_SECRETS_KEY_NEXT ? entry(decodeKey(input.AI_SECRETS_KEY_NEXT, 'AI_SECRETS_KEY_NEXT')) : null;
    // The main key is chosen exactly as before, so existing records keep opening. A pepper-derived
    // key stays readable after AI_SECRETS_KEY takes over, for records written before that.
    const main = explicit ?? derived ?? (input.NODE_ENV === 'test' ? entry(Buffer.alloc(32, 7)) : null);
    return new SecretBox(main, next && next.id !== main?.id ? next : null, explicit && derived ? [derived] : []);
  }

  get available(): boolean { return this.main !== null; }
  /** Fingerprints of the configured keys (never the keys). */
  get keyIds(): { main: string | null; next: string | null } { return { main: this.main?.id ?? null, next: this.next?.id ?? null }; }
  /** A second key is configured: secrets get a copy under it. */
  get hasNext(): boolean { return this.next !== null; }

  seal(plain: string): SealedSecret {
    return sealWith(this.requireKey('main'), plain);
  }

  /** The second copy of a secret under the next key, bound to its main copy. Null when no next key is set. */
  sealNext(main: SealedSecret, plain: string): BoundSecret | null {
    if (!this.next) return null;
    return { ...sealWith(this.next.key, plain), of: bindingOf(main) };
  }

  /** Opens a secret with any configured key. */
  open(sealed: SealedSecret): string {
    if (!this.readKeys.length) this.requireKey('main');
    for (const { key } of this.readKeys) {
      const plain = tryOpen(key, sealed);
      if (plain !== null) return plain;
    }
    throw new AppError('AI_SECRET_UNREADABLE', 500, 'Не вдалося розшифрувати ключ провайдера. Введіть ключ ще раз.');
  }

  /** Opens a stored secret: its main copy, or its second copy if that still belongs to the main one. */
  openStored(main: SealedSecret, second?: BoundSecret | null): string {
    if (second && second.of === bindingOf(main)) {
      for (const { key } of this.readKeys) {
        const plain = tryOpen(key, second);
        if (plain !== null) return plain;
      }
    }
    return this.open(main);
  }

  /**
   * Whether a stored secret is ready for a reader that has only the next key: its second copy
   * exists, belongs to the current main copy, and opens with the next key.
   */
  readyForNext(main: SealedSecret, second?: BoundSecret | null): boolean {
    if (!this.next || !second || second.of !== bindingOf(main)) return false;
    return tryOpen(this.next.key, second) !== null;
  }

  /** HMAC for short-lived links, under a key of its own derived from the main key. */
  sign(value: string): string {
    this.linkKey ??= Buffer.from(hkdfSync('sha256', this.requireKey('main'), 'aiss-ai-links', 'archive-links-v1', 32));
    return createHmac('sha256', this.linkKey).update(value).digest('base64url');
  }

  verify(value: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(value));
    const actual = Buffer.from(signature);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private linkKey: Buffer | undefined;

  private requireKey(which: 'main'): Buffer {
    void which;
    if (!this.main) throw new AppError('AI_SECRETS_KEY_MISSING', 503, 'Сховище ключів ШІ не налаштовано: задайте AI_SECRETS_KEY або SESSION_TOKEN_PEPPER.');
    return this.main.key;
  }
}

function sealWith(key: Buffer, plain: string): SealedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

/** Null when this key does not open it (GCM authentication fails): the next key is tried. */
function tryOpen(key: Buffer, sealed: SealedSecret): string | null {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Last four characters of a secret, never more. Short secrets get no hint at all. */
export function secretHint(value: string): string {
  return value.length >= 12 ? value.slice(-4) : '';
}
