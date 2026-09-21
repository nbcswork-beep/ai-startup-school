import { Bot, InlineKeyboard } from 'grammy';
import { registerIdCommand } from '../../bot/commands.js';
import type { AppRepository } from '../data/repository.js';

function summaryText(summary:Awaited<ReturnType<AppRepository['getParentSummary']>>):string{
  const next=summary.nextClass?`${new Date(summary.nextClass.startsAt).toLocaleString('uk-UA',{timeZone:'Europe/Kyiv',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})} · ${summary.nextClass.title}`:'ще не заплановано';
  const grades=summary.grades.slice(0,3).map(item=>`${item.score}/10 — ${item.feedback||item.homeworkTitle}`).join('\n')||'оцінок ще немає';
  return `👨‍👩‍👧 ${summary.student.name}\n\n📅 Наступне заняття: ${next}\n📊 Прогрес: ${summary.progress.percent}% · ${summary.progress.completedLessons}/${summary.progress.totalLessons} занять\n📝 Домашні завдання: ${summary.homework.completed} виконано · ${summary.homework.pending} очікує · ${summary.homework.overdue} прострочено\n✅ Відвідування: ${summary.attendance.attended} відвідано · ${summary.attendance.missed} пропущено\n💬 Оцінки та feedback:\n${grades}\n🚀 Проєкт: ${summary.project?`${summary.project.title} · ${summary.project.stage}`:'ще не створено'}\n∞ Менторство: ${summary.mentoring?new Date(summary.mentoring.startsAt).toLocaleString('uk-UA',{timeZone:'Europe/Kyiv',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'зустрічі немає'}`;
}

type ParentSummary=Awaited<ReturnType<AppRepository['getParentSummary']>>;

function parentKeyboard(studentId:string,multipleStudents=false):InlineKeyboard{
  const keyboard=new InlineKeyboard()
    .text('📚 Навчання',`parent:view:l:${studentId}`).text('📝 Домашні завдання',`parent:view:h:${studentId}`).row()
    .text('📊 Прогрес',`parent:view:p:${studentId}`).text('📅 Відвідування',`parent:view:a:${studentId}`).row()
    .text('💬 Feedback',`parent:view:f:${studentId}`).row()
    .text('🔄 Оновити',`parent:student:${studentId}`);
  if(multipleStudents)keyboard.text('← Інша дитина','parent:home');
  return keyboard;
}

function sectionText(summary:ParentSummary,section:string):string{
  if(section==='l')return `📚 Навчання · ${summary.student.name}\n\nПрогрес: ${summary.progress.percent}% (${summary.progress.completedLessons}/${summary.progress.totalLessons} занять)\nНаступне заняття: ${summary.nextClass?`${new Date(summary.nextClass.startsAt).toLocaleString('uk-UA',{timeZone:'Europe/Kyiv'})} · ${summary.nextClass.title}`:'ще не заплановано'}`;
  if(section==='h')return `📝 Домашні завдання · ${summary.student.name}\n\nВиконано: ${summary.homework.completed}\nОчікує: ${summary.homework.pending}\nПрострочено: ${summary.homework.overdue}`;
  if(section==='p')return `🚀 Прогрес · ${summary.student.name}\n\n${summary.progress.percent}% · ${summary.progress.completedLessons}/${summary.progress.totalLessons} занять\nПроєкт: ${summary.project?`${summary.project.title} · ${summary.project.stage}`:'ще не створено'}\nМенторство: ${summary.mentoring?new Date(summary.mentoring.startsAt).toLocaleString('uk-UA',{timeZone:'Europe/Kyiv'}):'зустрічі немає'}`;
  if(section==='a')return `✅ Відвідування · ${summary.student.name}\n\nВідвідано: ${summary.attendance.attended}\nПропущено: ${summary.attendance.missed}`;
  const grades=summary.grades.slice(0,5).map(item=>`${item.score}/10 — ${item.feedback||item.homeworkTitle}`).join('\n')||'Оцінок ще немає';
  return `💬 Оцінки й feedback · ${summary.student.name}\n\n${grades}`;
}

export function createSchoolBot(token: string, miniAppUrl: string, repository?:AppRepository): Bot {
  const bot = new Bot(token);
  registerIdCommand(bot);

  bot.command('start', async ctx => {
    const name = ctx.from?.first_name || 'друже';
    const audience=ctx.from&&repository?await repository.getTelegramAudience(String(ctx.from.id)):null;
    const keyboard = new InlineKeyboard();
    if(audience?.roles.includes('student'))keyboard.webApp('🚀 Відкрити AI Startup School', miniAppUrl).row();
    if(audience?.roles.includes('guardian'))keyboard.text('👨‍👩‍👧 Батькам','parent:home').row();
    if(!audience)keyboard.webApp('🚀 Відкрити AI Startup School',miniAppUrl);
    await ctx.reply(
      audience?`Привіт, ${name}! 👋\n\nОберіть потрібний розділ.`:`Привіт, ${name}! 👋\n\nЦей Telegram-акаунт ще не прив’язано в Admin. Ваш Telegram ID можна дізнатися командою /id.`,
      { reply_markup: keyboard }
    );
  });

  bot.callbackQuery('parent:home',async ctx=>{try{if(!repository)throw new Error('unavailable');const dashboard=await repository.getGuardianSummaryByTelegram(String(ctx.from.id));await ctx.answerCallbackQuery();if(!dashboard.students.length){await ctx.reply('До профілю ще не прив’язано жодної дитини. Зверніться до адміністратора школи.');return;}if(dashboard.selected){await ctx.reply(summaryText(dashboard.selected),{reply_markup:parentKeyboard(dashboard.selected.student.id)});return;}const keyboard=new InlineKeyboard();dashboard.students.forEach(student=>keyboard.text(student.firstName,`parent:student:${student.id}`).row());await ctx.reply('Оберіть дитину:',{reply_markup:keyboard});}catch{await ctx.answerCallbackQuery({text:'Доступ недоступний',show_alert:true});}});
  bot.callbackQuery(/^parent:student:([0-9a-f-]{36})$/,async ctx=>{try{if(!repository)throw new Error('unavailable');const studentId=ctx.match[1]!;const dashboard=await repository.getGuardianSummaryByTelegram(String(ctx.from.id),studentId);await ctx.answerCallbackQuery();if(dashboard.selected)await ctx.reply(summaryText(dashboard.selected),{reply_markup:parentKeyboard(studentId,dashboard.students.length>1)});}catch{await ctx.answerCallbackQuery({text:'Доступ до цієї дитини заборонено',show_alert:true});}});
  bot.callbackQuery(/^parent:view:([lhpaf]):([0-9a-f-]{36})$/,async ctx=>{try{if(!repository)throw new Error('unavailable');const section=ctx.match[1]!,studentId=ctx.match[2]!;const dashboard=await repository.getGuardianSummaryByTelegram(String(ctx.from.id),studentId);await ctx.answerCallbackQuery();if(dashboard.selected)await ctx.reply(sectionText(dashboard.selected,section),{reply_markup:parentKeyboard(studentId,dashboard.students.length>1)});}catch{await ctx.answerCallbackQuery({text:'Доступ до цієї дитини заборонено',show_alert:true});}});

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
