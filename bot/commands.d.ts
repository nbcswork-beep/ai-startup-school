import type { Bot, Context } from 'grammy';

export function registerIdCommand(bot: Pick<Bot<Context>, 'command'>): void;
