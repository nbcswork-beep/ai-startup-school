import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const accountSchema = z.object({
  userId: z.string().uuid(),
  email: z.string().email().max(254),
  passwordHash: z.string().min(1).max(512)
}).strict();
const accountsSchema = z.array(accountSchema).min(1).max(20);

const N = 65_536;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const MAX_MEMORY = 128 * N * R * 2;

function derive(password: string, salt: Buffer, keyLength: number, options: { N: number; r: number; p: number; maxmem: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => nodeScrypt(password, salt, keyLength, options, (error, key) => error ? reject(error) : resolve(key)));
}

export interface WebCredentialAccount {
  userId: string;
  email: string;
  passwordHash: string;
}

export function normalizeEmail(value: string): string { return value.trim().toLocaleLowerCase('en-US'); }

function parseHash(value: string): { n: number; r: number; p: number; salt: Buffer; hash: Buffer } | null {
  const [algorithm, rawN, rawR, rawP, rawSalt, rawHash, extra] = value.split('$');
  if (algorithm !== 'scrypt' || extra !== undefined) return null;
  const n = Number(rawN), r = Number(rawR), p = Number(rawP);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || n < 16_384 || n > N || r !== R || p < 1 || p > 4) return null;
  try {
    const salt = Buffer.from(rawSalt ?? '', 'base64url');
    const hash = Buffer.from(rawHash ?? '', 'base64url');
    return salt.length >= 16 && hash.length === KEY_LENGTH ? { n, r, p, salt, hash } : null;
  } catch { return null; }
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 14 || password.length > 128) throw new Error('Password must contain 14-128 characters');
  const salt = randomBytes(24);
  const derived = await derive(password, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: MAX_MEMORY });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  const parsed = parseHash(encodedHash);
  if (!parsed || password.length > 128) return false;
  const derived = await derive(password, parsed.salt, parsed.hash.length, { N: parsed.n, r: parsed.r, p: parsed.p, maxmem: MAX_MEMORY });
  return timingSafeEqual(derived, parsed.hash);
}

export class WebCredentialDirectory {
  private readonly byEmail = new Map<string, WebCredentialAccount>();
  private readonly fallbackHash: string | null;

  constructor(rawJson?: string) {
    if (!rawJson) { this.fallbackHash = null; return; }
    const accounts = accountsSchema.parse(JSON.parse(rawJson));
    for (const input of accounts) {
      const email = normalizeEmail(input.email);
      if (!parseHash(input.passwordHash)) throw new Error(`Invalid password hash for web account ${input.userId}`);
      if (this.byEmail.has(email)) throw new Error('Duplicate email in WEB_AUTH_ACCOUNTS_JSON');
      this.byEmail.set(email, { ...input, email });
    }
    this.fallbackHash = accounts[0]?.passwordHash ?? null;
  }

  get configured(): boolean { return this.byEmail.size > 0; }

  async authenticate(email: string, password: string): Promise<WebCredentialAccount | null> {
    const account = this.byEmail.get(normalizeEmail(email));
    const hash = account?.passwordHash ?? this.fallbackHash;
    if (!hash) return null;
    const valid = await verifyPassword(password, hash);
    return valid && account ? account : null;
  }
}
