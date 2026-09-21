import { createHash, randomUUID } from 'node:crypto';
import type { AppEnv } from '../config/env.js';
import type { AppRepository } from '../data/repository.js';
import { AppError } from '../errors/app-error.js';
import type { AuthUser, NewSession } from '../types/domain.js';
import { JwtService } from '../auth/jwt-service.js';
import { createRefreshToken, hashRefreshToken } from '../auth/refresh-token.js';
import { validateTelegramInitData } from '../auth/telegram-init-data.js';
import { normalizeEmail, WebCredentialDirectory } from '../auth/password-credentials.js';
import type { LoginAttemptLimiter } from '../auth/session-store.js';

export interface AuthResult {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  user: { id: string; displayName: string };
}

export class AuthService {
  constructor(
    private readonly repository: AppRepository,
    private readonly jwt: JwtService,
    private readonly env: AppEnv,
    private readonly webCredentials: WebCredentialDirectory = new WebCredentialDirectory(),
    private readonly loginLimiter: LoginAttemptLimiter = { consume: async () => true, reset: async () => {} },
    private readonly now: () => Date = () => new Date()
  ) {}

  async loginWithTelegram(initData: string): Promise<AuthResult> {
    if (!this.env.TELEGRAM_BOT_TOKEN) throw new AppError('TELEGRAM_AUTH_NOT_CONFIGURED', 503, 'Telegram авторизацію ще не налаштовано');
    const identity = validateTelegramInitData(initData, {
      botToken: this.env.TELEGRAM_BOT_TOKEN,
      maxAgeSeconds: this.env.TELEGRAM_INIT_DATA_MAX_AGE_SECONDS,
      now: this.now()
    });
    const user = await this.repository.resolveTelegramUser(identity);
    return this.startSession(user, 'telegram');
  }

  async loginDevelopmentUser(): Promise<AuthResult> {
    if (this.env.NODE_ENV === 'production' || !this.env.DEV_AUTH_ENABLED) {
      throw new AppError('NOT_FOUND', 404, 'Маршрут не знайдено');
    }
    const user = await this.repository.getDevelopmentUser(this.env.DEV_USER_ID);
    if (!user) throw new AppError('DEV_USER_MISSING', 503, 'Запусти development seed перед входом');
    return this.startSession(user, 'development');
  }

  async loginWithPassword(email: string, password: string, target: 'teacher' | 'admin', clientAddress: string): Promise<AuthResult> {
    const normalizedEmail = normalizeEmail(email);
    const rateKeys = [clientAddress, normalizedEmail].map(value => createHash('sha256').update(value).digest('hex'));
    const allowed = await Promise.all(rateKeys.map(key => this.loginLimiter.consume(key, 5, 900)));
    if (allowed.some(value => !value)) throw new AppError('LOGIN_RATE_LIMITED', 429, 'Забагато спроб. Спробуйте пізніше.');
    const persistentUser=await this.repository.authenticatePersistentWebUser(normalizedEmail,password);
    const credential = persistentUser ? null : await this.webCredentials.authenticate(normalizedEmail, password);
    if (!persistentUser&&!credential) throw new AppError('INVALID_CREDENTIALS', 401, 'Неправильна електронна пошта або пароль');
    const identity = await this.repository.getWebAuthUser(persistentUser?.id??credential!.userId);
    if (!identity || !identity.roles.some(role=>role==='teacher'||role==='admin')) throw new AppError('INVALID_CREDENTIALS', 401, 'Неправильна електронна пошта або пароль');
    if (target === 'admin' && !identity.roles.includes('admin')) throw new AppError('ROLE_FORBIDDEN', 403, 'Недостатньо прав для Admin Control Center');
    if (target === 'teacher' && !identity.roles.includes('teacher')) throw new AppError('ROLE_FORBIDDEN',403,'Недостатньо прав для Teacher OS');
    await Promise.all(rateKeys.map(key => this.loginLimiter.reset(key)));
    return this.startSession(identity.user, 'web');
  }

  async activate(token:string,password:string):Promise<AuthResult>{const user=await this.repository.activatePersistentWebUser(token,password);return this.startSession(user,'web');}

  async refresh(rawRefreshToken: string): Promise<AuthResult> {
    if (!rawRefreshToken) throw new AppError('REFRESH_TOKEN_MISSING', 401, 'Сесію не знайдено');
    const token = createRefreshToken();
    const now = this.now();
    const next: NewSession = {
      id: randomUUID(), familyId: randomUUID(), userId: '', provider: 'web',
      refreshTokenHash: hashRefreshToken(token, this.pepper()), createdAt: now,
      expiresAt: new Date(now.getTime() + this.env.REFRESH_TOKEN_TTL_DAYS * 86_400_000)
    };
    const result = await this.repository.rotateSession(hashRefreshToken(rawRefreshToken, this.pepper()), next, now);
    if (result.status !== 'ok') {
      const code = result.status === 'reused' ? 'REFRESH_TOKEN_REUSE' : 'REFRESH_TOKEN_INVALID';
      throw new AppError(code, 401, 'Сесію завершено. Увійди ще раз.');
    }
    if (result.user.status !== 'active') {
      await this.repository.revokeSession(next.refreshTokenHash, now);
      throw new AppError('USER_INACTIVE', 403, 'Обліковий запис недоступний');
    }
    const provider = result.session.provider;
    const accessToken = await this.jwt.sign({ userId: result.user.id, sessionId: result.session.id, provider });
    return { accessToken, expiresIn: this.env.ACCESS_TOKEN_TTL_SECONDS, refreshToken: token, user: { id: result.user.id, displayName: result.user.displayName } };
  }

  async logout(rawRefreshToken: string | undefined): Promise<void> {
    if (!rawRefreshToken) return;
    await this.repository.revokeSession(hashRefreshToken(rawRefreshToken, this.pepper()), this.now());
  }

  private async startSession(user: AuthUser, provider: NewSession['provider']): Promise<AuthResult> {
    if (user.status !== 'active') throw new AppError('USER_INACTIVE', 403, 'Обліковий запис недоступний');
    const refreshToken = createRefreshToken();
    const now = this.now();
    const session: NewSession = {
      id: randomUUID(), familyId: randomUUID(), userId: user.id, provider,
      refreshTokenHash: hashRefreshToken(refreshToken, this.pepper()), createdAt: now,
      expiresAt: new Date(now.getTime() + this.env.REFRESH_TOKEN_TTL_DAYS * 86_400_000)
    };
    await this.repository.createSession(session);
    const accessToken = await this.jwt.sign({ userId: user.id, sessionId: session.id, provider });
    return { accessToken, expiresIn: this.env.ACCESS_TOKEN_TTL_SECONDS, refreshToken, user: { id: user.id, displayName: user.displayName } };
  }

  private pepper(): string {
    return this.env.SESSION_TOKEN_PEPPER || 'unit-test-session-pepper-that-is-not-used-in-production';
  }
}
