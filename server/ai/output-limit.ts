/**
 * An answer cut off by the output-token cap. Providers report it as the finish reason: `length`
 * (OpenAI-compatible APIs) or `max_tokens` (Anthropic). Without this the student saw only
 * «порожня відповідь» when the whole cap went to reasoning or to one large tool call.
 */
export function hitOutputLimit(reason: string | null | undefined): boolean {
  return reason === 'length' || reason === 'max_tokens';
}

export type OutputLimitCase = 'empty' | 'partial' | 'tool';

const ADMIN_HINT = 'адміністратор може збільшити «Макс. вихідних токенів» для цієї моделі';

/** What the student reads; `limit` is the model's cap, so an admin knows what to raise. */
export function outputLimitNotice(kind: OutputLimitCase, limit: number): { code: string; message: string } {
  const cap = `${limit} токенів`;
  if (kind === 'partial') {
    return { code: 'AI_OUTPUT_LIMIT', message: `Відповідь обрізано: модель досягла ліміту довжини відповіді (${cap}). Попросіть продовжити або відповісти коротше; ${ADMIN_HINT}.` };
  }
  if (kind === 'tool') {
    return { code: 'AI_OUTPUT_LIMIT', message: `Файл або сайт не вмістився в ліміт довжини відповіді моделі (${cap}), тому його не створено. Попросіть зробити коротше — менше сторінок, тексту чи анімацій — або ${ADMIN_HINT}.` };
  }
  return { code: 'AI_OUTPUT_LIMIT', message: `Модель вичерпала ліміт довжини відповіді (${cap}) і не встигла відповісти. Попросіть коротший результат або ${ADMIN_HINT}.` };
}

/** The cap was the student's remaining tokens, not the model: raising the model limit would not help. */
export const BUDGET_LIMIT_NOTICE = { code: 'AI_ANSWER_BUDGET', message: 'Відповідь обрізано: не вистачило токенів у вашому ліміті. Поповніть ліміт або попросіть коротшу відповідь.' } as const;

/** A tool call whose arguments were cut off mid-JSON. */
export function truncatedArguments(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw || '{}');
    return !parsed || typeof parsed !== 'object' || Array.isArray(parsed);
  } catch {
    return true;
  }
}
