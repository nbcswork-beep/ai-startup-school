import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateTelegramInitData } from './telegram-init-data.js';

function signedInitData(botToken: string, authDate: number) {
  const values = new URLSearchParams({ auth_date: String(authDate), query_id: 'AAEAA-test', user: JSON.stringify({ id: 123456789, first_name: 'Оля', language_code: 'uk' }) });
  const check = [...values.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>`${key}=${value}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  values.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
  return values.toString();
}

describe('Telegram initData validation', () => {
  const botToken = '123456:unit-test-token';
  const now = new Date('2026-09-17T12:00:00.000Z');
  const nowSeconds = Math.floor(now.getTime()/1000);

  it('accepts a valid signed payload and returns only validated identity fields', () => {
    expect(validateTelegramInitData(signedInitData(botToken, nowSeconds), { botToken, maxAgeSeconds: 300, now })).toEqual({ telegramId: '123456789', firstName: 'Оля', languageCode: 'uk' });
  });
  it('rejects a modified signature', () => {
    const payload = signedInitData(botToken, nowSeconds).replace('%D0%9E%D0%BB%D1%8F', 'Mallory');
    expect(() => validateTelegramInitData(payload, { botToken, maxAgeSeconds: 300, now })).toThrowError(/Telegram/);
  });
  it('rejects stale payloads', () => {
    expect(() => validateTelegramInitData(signedInitData(botToken, nowSeconds-301), { botToken, maxAgeSeconds: 300, now })).toThrowError(/застаріла/);
  });
});
