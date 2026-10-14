import { describe, expect, it } from 'vitest';
import { ANSWER_FAILED_TEXT, ANSWER_READY_TEXT, OPEN_CHAT_BUTTON, TelegramAnswerNotifier, answerLink } from './notifier.js';

const CONVERSATION = '6f1c2a5e-8d4b-4f0a-9c3e-1b2d3e4f5a6b';

function fakeTelegram(statuses: Array<number | 'network'>, body: unknown = {}) {
  const calls: Array<{ url: string; body: any }> = [];
  const waits: number[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const status = statuses.shift() ?? 200;
    if (status === 'network') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(status === 200 ? { ok: true } : body), { status });
  }) as unknown as typeof fetch;
  const notifier = new TelegramAnswerNotifier('123:bot-token', 'https://school.example/app', fetcher, async ms => { waits.push(ms); });
  return { notifier, calls, waits };
}

describe('Telegram "answer ready" notice', () => {
  it('sends the fixed Ukrainian text with one button that opens that chat in the Mini App', async () => {
    const { notifier, calls } = fakeTelegram([200]);
    expect(await notifier.notify({ telegramId: '700100200', conversationId: CONVERSATION, outcome: 'ready' })).toEqual({ sent: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.telegram.org/bot123:bot-token/sendMessage');
    expect(calls[0]!.body).toEqual({
      chat_id: '700100200',
      text: '✅ Ваша відповідь від ШІ готова!',
      reply_markup: { inline_keyboard: [[{ text: 'Відкрити чат', web_app: { url: `https://school.example/app?ai=${CONVERSATION}` } }]] }
    });
    expect(ANSWER_READY_TEXT).toBe('✅ Ваша відповідь від ШІ готова!');
    expect(OPEN_CHAT_BUTTON).toBe('Відкрити чат');
  });

  it('says only that the answer failed when it did', async () => {
    const { notifier, calls } = fakeTelegram([200]);
    await notifier.notify({ telegramId: '1', conversationId: CONVERSATION, outcome: 'failed' });
    expect(calls[0]!.body.text).toBe(ANSWER_FAILED_TEXT);
    // The notice can only carry the fixed texts, the chat link and the Telegram id.
    expect(Object.keys(calls[0]!.body).sort()).toEqual(['chat_id', 'reply_markup', 'text']);
  });

  it('keeps the Mini App address and drops a hash, which Telegram uses for launch data', () => {
    expect(answerLink('https://school.example/?v=2#old', CONVERSATION)).toBe(`https://school.example/?v=2&ai=${CONVERSATION}`);
  });

  it('retries temporary failures, waits as Telegram asks, and gives up on a refusal', async () => {
    const temporary = fakeTelegram([500, 'network', 200]);
    expect(await temporary.notifier.notify({ telegramId: '1', conversationId: CONVERSATION, outcome: 'ready' })).toEqual({ sent: true });
    expect(temporary.calls).toHaveLength(3);
    expect(temporary.waits).toEqual([400, 800]);

    const limited = fakeTelegram([429, 200], { ok: false, parameters: { retry_after: 2 } });
    expect(await limited.notifier.notify({ telegramId: '1', conversationId: CONVERSATION, outcome: 'ready' })).toEqual({ sent: true });
    expect(limited.waits).toEqual([2_000]);

    const blocked = fakeTelegram([403]);
    expect(await blocked.notifier.notify({ telegramId: '1', conversationId: CONVERSATION, outcome: 'ready' })).toEqual({ sent: false, code: 'TELEGRAM_FORBIDDEN', retryable: false });
    expect(blocked.calls).toHaveLength(1);

    const down = fakeTelegram([502, 502, 502]);
    expect(await down.notifier.notify({ telegramId: '1', conversationId: CONVERSATION, outcome: 'ready' })).toEqual({ sent: false, code: 'TELEGRAM_TEMPORARY', retryable: true });
    expect(down.calls).toHaveLength(3);
  });
});
