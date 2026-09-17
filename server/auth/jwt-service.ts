import { generateKeyPair, importPKCS8, importSPKI, jwtVerify, SignJWT, type KeyInput } from 'jose';
import type { AppEnv } from '../config/env.js';
import { AppError } from '../errors/app-error.js';

export interface AuthPrincipal {
  userId: string;
  sessionId: string;
  provider: 'telegram' | 'development' | 'web';
}

export class JwtService {
  constructor(
    private readonly privateKey: KeyInput,
    private readonly publicKey: KeyInput,
    private readonly issuer: string,
    private readonly audience: string,
    private readonly keyId: string,
    private readonly ttlSeconds: number
  ) {}

  async sign(principal: AuthPrincipal): Promise<string> {
    return new SignJWT({
      role: 'authenticated',
      app_user_id: principal.userId,
      auth_provider: principal.provider,
      session_id: principal.sessionId
    })
      .setProtectedHeader({ alg: 'ES256', kid: this.keyId, typ: 'JWT' })
      .setSubject(principal.userId)
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setIssuedAt()
      .setExpirationTime(`${this.ttlSeconds}s`)
      .sign(this.privateKey);
  }

  async verify(token: string): Promise<AuthPrincipal> {
    try {
      const { payload } = await jwtVerify(token, this.publicKey, { issuer: this.issuer, audience: this.audience, algorithms: ['ES256'] });
      const userId = payload.app_user_id;
      const sessionId = payload.session_id;
      const provider = payload.auth_provider;
      if (typeof userId !== 'string' || typeof sessionId !== 'string' || !['telegram', 'development', 'web'].includes(String(provider))) {
        throw new Error('Required claims are missing');
      }
      return { userId, sessionId, provider: provider as AuthPrincipal['provider'] };
    } catch {
      throw new AppError('ACCESS_TOKEN_INVALID', 401, 'Сесія недійсна або завершилася');
    }
  }
}

function decodeKey(value: string): string {
  return Buffer.from(value, 'base64').toString('utf8');
}

export async function createJwtService(env: AppEnv): Promise<JwtService> {
  if (env.DEV_EPHEMERAL_JWT) {
    if (env.NODE_ENV === 'production') throw new Error('Ephemeral JWT keys are forbidden in production');
    const pair = await generateKeyPair('ES256', { extractable: true });
    return new JwtService(pair.privateKey, pair.publicKey, env.APP_JWT_ISSUER, env.APP_JWT_AUDIENCE, env.APP_JWT_KEY_ID, env.ACCESS_TOKEN_TTL_SECONDS);
  }
  const privateKey = await importPKCS8(decodeKey(env.APP_JWT_PRIVATE_KEY_BASE64!), 'ES256');
  const publicKey = await importSPKI(decodeKey(env.APP_JWT_PUBLIC_KEY_BASE64!), 'ES256');
  return new JwtService(privateKey, publicKey, env.APP_JWT_ISSUER, env.APP_JWT_AUDIENCE, env.APP_JWT_KEY_ID, env.ACCESS_TOKEN_TTL_SECONDS);
}
