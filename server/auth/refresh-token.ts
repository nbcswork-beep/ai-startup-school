import crypto from 'node:crypto';

export function createRefreshToken(): string {
  return crypto.randomBytes(48).toString('base64url');
}

export function hashRefreshToken(token: string, pepper: string): string {
  return crypto.createHash('sha256').update(`${pepper}:${token}`).digest('hex');
}
