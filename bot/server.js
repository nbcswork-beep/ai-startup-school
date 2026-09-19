import 'dotenv/config';
import { createSchoolBot } from '../server/telegram/school-bot.ts';

const token = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const miniAppUrl = process.env.MINI_APP_URL;

if (!token || !miniAppUrl) {
  console.error('Set BOT_TOKEN and MINI_APP_URL in .env');
  process.exit(1);
}

const bot = createSchoolBot(token, miniAppUrl);
bot.start({ onStart: () => console.log('AI Startup School bot is running') });
