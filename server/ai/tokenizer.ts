/**
 * Token estimates for reservations and for the rare provider that reports no usage. Uses the
 * o200k_base BPE (GPT-4o family). Other model families tokenize differently, which is why every
 * figure that comes from here is marked approximate and reservations carry a safety margin.
 */

type Encoder = { encode(text: string, allowedSpecial?: 'all' | string[], disallowedSpecial?: 'all' | string[]): number[] };

let encoder: Promise<Encoder | null> | undefined;

async function loadEncoder(): Promise<Encoder | null> {
  try {
    const [{ Tiktoken }, ranks] = await Promise.all([import('js-tiktoken/lite'), import('js-tiktoken/ranks/o200k_base')]);
    return new Tiktoken(ranks.default) as Encoder;
  } catch {
    return null;
  }
}

/** Without the BPE tables: a deliberately high estimate (Cyrillic is ~2.5 characters per token). */
function roughCount(text: string): number {
  return Math.ceil(text.length / 2.2);
}

export async function countTokens(text: string): Promise<number> {
  if (!text) return 0;
  encoder ??= loadEncoder();
  const loaded = await encoder;
  if (!loaded) return roughCount(text);
  // Special-token markers in user text are counted as plain text, never interpreted.
  return loaded.encode(text, [], []).length;
}

/** Chat framing adds a few tokens per message on every major API. */
const PER_MESSAGE_OVERHEAD = 4;
const PER_REQUEST_OVERHEAD = 3;

export async function countChatTokens(messages: Array<{ content: string }>): Promise<number> {
  let total = PER_REQUEST_OVERHEAD;
  for (const message of messages) total += PER_MESSAGE_OVERHEAD + await countTokens(message.content);
  return total;
}

/** Reservation size for the input side: estimate plus 20 % for tokenizers that split text finer. */
export function withSafetyMargin(tokens: number): number {
  return Math.ceil(tokens * 1.2) + 16;
}
