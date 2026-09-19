import { describe, expect, it, vi } from 'vitest';
import { registerIdCommand } from '../bot/commands.js';

describe('temporary Telegram /id command', () => {
  it('replies with only the requesting user numeric Telegram ID', async () => {
    let handler: ((context: { from?: { id: number }; reply: (text: string) => Promise<void> }) => Promise<void>) | undefined;
    const bot = {
      command(name: string, callback: typeof handler) {
        expect(name).toBe('id');
        handler = callback;
      }
    };
    registerIdCommand(bot);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler!({ from: { id: 987654321 }, reply });

    expect(reply).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledWith('987654321');
  });

  it('does not reply when Telegram did not provide a user', async () => {
    let handler: ((context: { from?: { id: number }; reply: (text: string) => Promise<void> }) => Promise<void>) | undefined;
    registerIdCommand({ command(_name: string, callback: typeof handler) { handler = callback; } });
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler!({ reply });

    expect(reply).not.toHaveBeenCalled();
  });
});
