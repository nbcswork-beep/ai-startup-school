import { Bot, InlineKeyboard } from 'grammy';
import { registerIdCommand } from '../../bot/commands.js';

export function createSchoolBot(token: string, miniAppUrl: string): Bot {
  const bot = new Bot(token);
  registerIdCommand(bot);

  bot.command('start', async ctx => {
    const name = ctx.from?.first_name || 'друже';
    const keyboard = new InlineKeyboard().webApp('🚀 Відкрити AI Startup School', miniAppUrl);
    await ctx.reply(
      `Привіт, ${name}! 👋\n\nТут починається твій шлях від ідеї до реального проєкту. Відкрий школу — там уроки, твій проєкт, AI-ментор і прогрес.`,
      { reply_markup: keyboard }
    );
  });

  bot.command('school', async ctx => {
    await ctx.reply('Відкрити школу:', {
      reply_markup: new InlineKeyboard().webApp('AI Startup School ✦', miniAppUrl)
    });
  });

  bot.catch(error => {
    const detail = error.error instanceof Error ? error.error.message : 'Unknown bot update error';
    console.error('Telegram bot update failed:', detail);
  });
  return bot;
}
