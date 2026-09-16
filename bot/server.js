import 'dotenv/config';
import { Bot, InlineKeyboard } from 'grammy';

const token = process.env.BOT_TOKEN;
const miniAppUrl = process.env.MINI_APP_URL;

if (!token || !miniAppUrl) {
  console.error('Set BOT_TOKEN and MINI_APP_URL in .env');
  process.exit(1);
}

const bot = new Bot(token);

bot.command('start', async (ctx) => {
  const name = ctx.from?.first_name || 'друже';
  const keyboard = new InlineKeyboard().webApp('🚀 Відкрити AI Startup School', miniAppUrl);
  await ctx.reply(
    `Привіт, ${name}! 👋\n\nТут починається твій шлях від ідеї до реального проєкту. Відкрий школу — там уроки, твій проєкт, AI-ментор і прогрес.`,
    { reply_markup: keyboard }
  );
});

bot.command('school', async (ctx) => {
  await ctx.reply('Відкрити школу:', {
    reply_markup: new InlineKeyboard().webApp('AI Startup School ✦', miniAppUrl)
  });
});

bot.catch((err) => console.error('Bot error:', err.error));
bot.start({ onStart: () => console.log('AI Startup School bot is running') });
