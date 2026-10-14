/**
 * Telegram notice that a background answer finished. The text is fixed: it never carries the
 * student's question, the answer, names or anything else from the chat. The button opens the
 * Mini App on that chat; the conversation id in the link is useless without the student's session.
 */

export const ANSWER_READY_TEXT = '✅ Ваша відповідь від ШІ готова!';
export const ANSWER_FAILED_TEXT = '⚠️ ШІ не вдалося завершити відповідь. Відкрийте чат, щоб спробувати ще раз.';
export const OPEN_CHAT_BUTTON = 'Відкрити чат';

export type AnswerNoticeResult = { sent: true } | { sent: false; code: string; retryable: boolean };

export interface AiAnswerNotifier {
  notify(input: { telegramId: string; conversationId: string; outcome: 'ready' | 'failed' }): Promise<AnswerNoticeResult>;
}

/** The Mini App address that opens one chat. A query parameter, because Telegram uses the hash for launch data. */
export function answerLink(miniAppUrl: string, conversationId: string): string {
  const url = new URL(miniAppUrl);
  url.searchParams.set('ai', conversationId);
  url.hash = '';
  return url.toString();
}

const ATTEMPTS = 3;
const MAX_WAIT_MS = 5_000;

export class TelegramAnswerNotifier implements AiAnswerNotifier {
  constructor(
    private readonly botToken: string,
    private readonly miniAppUrl: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))
  ) {}

  async notify(input: { telegramId: string; conversationId: string; outcome: 'ready' | 'failed' }): Promise<AnswerNoticeResult> {
    const body = JSON.stringify({
      chat_id: input.telegramId,
      text: input.outcome === 'ready' ? ANSWER_READY_TEXT : ANSWER_FAILED_TEXT,
      reply_markup: { inline_keyboard: [[{ text: OPEN_CHAT_BUTTON, web_app: { url: answerLink(this.miniAppUrl, input.conversationId) } }]] }
    });
    let last: AnswerNoticeResult = { sent: false, code: 'TELEGRAM_NETWORK', retryable: true };
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      let wait = 400 * 2 ** (attempt - 1);
      try {
        const response = await this.fetcher(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(8_000)
        });
        if (response.ok) return { sent: true };
        if (response.status === 429) {
          const retryAfter = Number((await response.json().catch(() => null) as { parameters?: { retry_after?: number } } | null)?.parameters?.retry_after ?? 1);
          last = { sent: false, code: 'TELEGRAM_RATE_LIMIT', retryable: true };
          if (retryAfter * 1000 > MAX_WAIT_MS) return last;
          wait = retryAfter * 1000;
        } else if (response.status >= 500) {
          last = { sent: false, code: 'TELEGRAM_TEMPORARY', retryable: true };
        } else {
          // 400 chat not found, 403 the student blocked the bot or never started it: retrying will not help.
          return { sent: false, code: response.status === 403 ? 'TELEGRAM_FORBIDDEN' : 'TELEGRAM_REJECTED', retryable: false };
        }
      } catch {
        last = { sent: false, code: 'TELEGRAM_NETWORK', retryable: true };
      }
      if (attempt < ATTEMPTS) await this.sleep(Math.min(wait, MAX_WAIT_MS));
    }
    return last;
  }
}
