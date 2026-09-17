import crypto from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors/app-error.js';
import type { TelegramIdentityInput } from '../types/domain.js';

const telegramUserSchema = z.object({
  id: z.union([z.number().int().positive().safe(), z.string().regex(/^\d+$/)]),
  first_name: z.string().trim().min(1).max(64),
  last_name: z.string().trim().max(64).optional(),
  language_code: z.string().trim().max(16).optional()
});

export interface TelegramValidationOptions {
  botToken: string;
  maxAgeSeconds: number;
  now?: Date;
  futureSkewSeconds?: number;
}

export function validateTelegramInitData(initData: string, options: TelegramValidationOptions): TelegramIdentityInput {
  if (!initData || initData.length > 16_384) throw new AppError('TELEGRAM_INIT_DATA_INVALID', 401, 'Некоректні дані Telegram');
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[a-fA-F0-9]{64}$/.test(hash)) throw new AppError('TELEGRAM_SIGNATURE_INVALID', 401, 'Не вдалося підтвердити Telegram');
  if ([...params.keys()].some((key, index, all) => all.indexOf(key) !== index)) {
    throw new AppError('TELEGRAM_INIT_DATA_INVALID', 401, 'Некоректні дані Telegram');
  }

  const authDate = Number(params.get('auth_date'));
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const futureSkew = options.futureSkewSeconds ?? 30;
  if (!Number.isSafeInteger(authDate) || authDate <= 0 || authDate > nowSeconds + futureSkew) {
    throw new AppError('TELEGRAM_AUTH_DATE_INVALID', 401, 'Некоректний час авторизації Telegram');
  }
  if (nowSeconds - authDate > options.maxAgeSeconds) {
    throw new AppError('TELEGRAM_INIT_DATA_STALE', 401, 'Сесія Telegram застаріла. Відкрий застосунок ще раз.');
  }

  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(options.botToken).digest();
  const calculated = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest();
  const received = Buffer.from(hash, 'hex');
  if (received.length !== calculated.length || !crypto.timingSafeEqual(received, calculated)) {
    throw new AppError('TELEGRAM_SIGNATURE_INVALID', 401, 'Не вдалося підтвердити Telegram');
  }

  const rawUser = params.get('user');
  if (!rawUser) throw new AppError('TELEGRAM_USER_MISSING', 401, 'Telegram не передав користувача');
  let parsedUser: unknown;
  try {
    parsedUser = JSON.parse(rawUser);
  } catch {
    throw new AppError('TELEGRAM_USER_INVALID', 401, 'Некоректні дані користувача Telegram');
  }
  const user = telegramUserSchema.parse(parsedUser);
  return {
    telegramId: String(user.id),
    firstName: user.first_name,
    ...(user.last_name ? { lastName: user.last_name } : {}),
    ...(user.language_code ? { languageCode: user.language_code } : {})
  };
}
