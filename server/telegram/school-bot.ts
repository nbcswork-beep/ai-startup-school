import { Bot, InlineKeyboard } from 'grammy';
import { registerIdCommand } from '../../bot/commands.js';
import type { AppRepository } from '../data/repository.js';
import type { ParentContactCategory } from '../types/domain.js';

const clip=(value:string,max=3600)=>value.length>max?`${value.slice(0,max-1)}…`:value;

export function summaryText(summary:Awaited<ReturnType<AppRepository['getParentSummary']>>):string{
  const next=summary.nextClass?`${new Date(summary.nextClass.startsAt).toLocaleString('uk-UA',{timeZone:'Europe/Kyiv',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})} · ${summary.nextClass.title}`:'ще не заплановано';
  const grades=summary.grades.slice(0,3).map(item=>`${item.score}/10 — ${item.feedback||item.homeworkTitle}`).join('\n')||'оцінок ще немає';
  return clip(`👨‍👩‍👧 ${summary.student.name}\n\n📅 Наступне заняття: ${next}\n📊 Прогрес: ${summary.progress.percent}% · ${summary.progress.completedLessons}/${summary.progress.totalLessons} занять\n📝 Домашні завдання: ${summary.homework.completed} виконано · ${summary.homework.pending} очікує · ${summary.homework.overdue} прострочено\n✅ Відвідування: ${summary.attendance.attended} відвідано · ${summary.attendance.missed} пропущено${summary.recovery?'\nПропущено заняття — матеріали доступні дитині.':''}\n💬 Оцінки та feedback:\n${grades}\n🚀 Проєкт: ${summary.project?`${summary.project.title} · ${summary.project.stage}`:'ще не створено'}\n∞ Менторство: ${summary.mentoring?new Date(summary.mentoring.startsAt).toLocaleString('uk-UA',{timeZone:'Europe/Kyiv',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'зустрічі немає'}`);
}

type ParentSummary=Awaited<ReturnType<AppRepository['getParentSummary']>>;

export function parentKeyboard(summary:ParentSummary,multipleStudents=false):InlineKeyboard{
  const studentId=summary.student.id;
  const keyboard=new InlineKeyboard()
    .text('📚 Навчання',`parent:view:l:${studentId}`).text('📝 Домашні завдання',`parent:view:h:${studentId}`).row()
    .text('📊 Прогрес',`parent:view:p:${studentId}`).text('📅 Відвідування',`parent:view:a:${studentId}`).row()
    .text('💬 Feedback',`parent:view:f:${studentId}`).text('🚀 Проєкт',`parent:view:r:${studentId}`).row()
    .text('💬 Потрібна консультація',`parent:contact:${studentId}`).row()
    .text('🔄 Оновити',`parent:student:${studentId}`);
  if(multipleStudents)keyboard.text('← Інша дитина','parent:home');
  return keyboard;
}

export function sectionText(summary:ParentSummary,section:string):string{
  if(section==='l')return `📚 Навчання · ${summary.student.name}\n\nПрогрес: ${summary.progress.percent}% (${summary.progress.completedLessons}/${summary.progress.totalLessons} занять)\nНаступне заняття: ${summary.nextClass?`${new Date(summary.nextClass.startsAt).toLocaleString('uk-UA',{timeZone:'Europe/Kyiv'})} · ${summary.nextClass.title}`:'ще не заплановано'}`;
  if(section==='h')return `📝 Домашні завдання · ${summary.student.name}\n\nВиконано: ${summary.homework.completed}\nОчікує: ${summary.homework.pending}\nПрострочено: ${summary.homework.overdue}`;
  if(section==='p')return `🚀 Прогрес · ${summary.student.name}\n\n${summary.progress.percent}% · ${summary.progress.completedLessons}/${summary.progress.totalLessons} занять\nПроєкт: ${summary.project?`${summary.project.title} · ${summary.project.stage}`:'ще не створено'}\nМенторство: ${summary.mentoring?new Date(summary.mentoring.startsAt).toLocaleString('uk-UA',{timeZone:'Europe/Kyiv'}):'зустрічі немає'}`;
  if(section==='a')return `✅ Відвідування · ${summary.student.name}\n\nВідвідано: ${summary.attendance.attended}\nПропущено: ${summary.attendance.missed}${summary.recovery?'\n\nПропущено заняття — матеріали доступні дитині.':''}`;
  if(section==='r')return summary.project?clip(`🚀 Проєкт дитини · ${summary.student.name}\n\n${summary.project.title}\n${summary.project.description}\n\nЕтап: ${summary.project.stage}\nГотовність: ${summary.project.progressPercent}%\nВиконано: ${summary.project.completedTasks.length?summary.project.completedTasks.join('; '):'поки немає завершених кроків'}\nНаступний крок: ${summary.project.nextTask??'усі заплановані кроки виконано'}\nОновлено: ${new Date(summary.project.updatedAt).toLocaleString('uk-UA',{timeZone:'Europe/Kyiv'})}\nСтатус: ${summary.project.status}`):`🚀 Проєкт дитини · ${summary.student.name}\n\nПроєкт ще не створено.`;
  const grades=summary.grades.slice(0,5).map(item=>`${item.score}/10 — ${item.feedback||item.homeworkTitle}`).join('\n')||'Оцінок ще немає';
  return clip(`💬 Оцінки й feedback · ${summary.student.name}\n\n${grades}`);
}

const contactCategories:Record<string,{value:ParentContactCategory;label:string}>={l:{value:'learning',label:'Навчання'},h:{value:'homework',label:'Домашні завдання'},p:{value:'project',label:'Проєкт'},a:{value:'attendance',label:'Відвідування'},m:{value:'mentoring',label:'Менторство'},o:{value:'other',label:'Інше'}};

function contactKeyboard(studentId:string):InlineKeyboard{return new InlineKeyboard()
  .text('📚 Навчання',`parent:contactcat:l:${studentId}`).text('📝 Домашні',`parent:contactcat:h:${studentId}`).row()
  .text('🚀 Проєкт',`parent:contactcat:p:${studentId}`).text('📅 Відвідування',`parent:contactcat:a:${studentId}`).row()
  .text('∞ Менторство',`parent:contactcat:m:${studentId}`).text('Інше',`parent:contactcat:o:${studentId}`);}

function projectKeyboard(summary:ParentSummary,multipleStudents:boolean):InlineKeyboard{
  const keyboard=new InlineKeyboard();
  if(summary.project?.viewUrl)keyboard.url('🌐 Відкрити проєкт',summary.project.viewUrl).row();
  keyboard.text('← До кабінету',`parent:student:${summary.student.id}`);
  if(multipleStudents)keyboard.text('Інша дитина','parent:home');
  return keyboard;
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

  bot.callbackQuery('parent:home',async ctx=>{try{if(!repository)throw new Error('unavailable');const dashboard=await repository.getGuardianSummaryByTelegram(String(ctx.from.id));await ctx.answerCallbackQuery();if(!dashboard.students.length){await ctx.reply('До профілю ще не прив’язано жодної дитини. Зверніться до адміністратора школи.');return;}if(dashboard.selected){await ctx.reply(summaryText(dashboard.selected),{reply_markup:parentKeyboard(dashboard.selected)});return;}const keyboard=new InlineKeyboard();dashboard.students.forEach(student=>keyboard.text(student.firstName,`parent:student:${student.id}`).row());await ctx.reply('Оберіть дитину:',{reply_markup:keyboard});}catch{await ctx.answerCallbackQuery({text:'Доступ недоступний',show_alert:true});}});
  bot.callbackQuery(/^parent:student:([0-9a-f-]{36})$/,async ctx=>{try{if(!repository)throw new Error('unavailable');const studentId=ctx.match[1]!;const dashboard=await repository.getGuardianSummaryByTelegram(String(ctx.from.id),studentId);await ctx.answerCallbackQuery();if(dashboard.selected)await ctx.reply(summaryText(dashboard.selected),{reply_markup:parentKeyboard(dashboard.selected,dashboard.students.length>1)});}catch{await ctx.answerCallbackQuery({text:'Доступ до цієї дитини заборонено',show_alert:true});}});
  bot.callbackQuery(/^parent:view:([lhpafr]):([0-9a-f-]{36})$/,async ctx=>{try{if(!repository)throw new Error('unavailable');const section=ctx.match[1]!,studentId=ctx.match[2]!;const dashboard=await repository.getGuardianSummaryByTelegram(String(ctx.from.id),studentId);await ctx.answerCallbackQuery();if(dashboard.selected)await ctx.reply(sectionText(dashboard.selected,section),{reply_markup:section==='r'?projectKeyboard(dashboard.selected,dashboard.students.length>1):parentKeyboard(dashboard.selected,dashboard.students.length>1)});}catch{await ctx.answerCallbackQuery({text:'Доступ до цієї дитини заборонено',show_alert:true});}});
  bot.callbackQuery(/^parent:contact:([0-9a-f-]{36})$/,async ctx=>{try{if(!repository)throw new Error('unavailable');const studentId=ctx.match[1]!;const dashboard=await repository.getGuardianSummaryByTelegram(String(ctx.from.id),studentId);if(!dashboard.selected)throw new Error('forbidden');await ctx.answerCallbackQuery();await ctx.reply(`Оберіть тему консультації щодо ${dashboard.selected.student.name}:`,{reply_markup:contactKeyboard(studentId)});}catch{await ctx.answerCallbackQuery({text:'Доступ до цієї дитини заборонено',show_alert:true});}});
  bot.callbackQuery(/^parent:contactcat:([lhpamo]):([0-9a-f-]{36})$/,async ctx=>{try{if(!repository)throw new Error('unavailable');const code=ctx.match[1]!,studentId=ctx.match[2]!,category=contactCategories[code];if(!category)throw new Error('invalid');const dashboard=await repository.getGuardianSummaryByTelegram(String(ctx.from.id),studentId);if(!dashboard.selected)throw new Error('forbidden');await ctx.answerCallbackQuery();await ctx.reply(`Опишіть запит одним повідомленням і надішліть його відповіддю на це повідомлення.\n\nТема: ${category.label}\n#parent-request:${code}:${studentId}`,{reply_markup:{force_reply:true,input_field_placeholder:'Напишіть, чим ми можемо допомогти'}});}catch{await ctx.answerCallbackQuery({text:'Не вдалося створити запит',show_alert:true});}});
  bot.command('school', async ctx => {
    await ctx.reply('Відкрити школу:', {
      reply_markup: new InlineKeyboard().webApp('AI Startup School ✦', miniAppUrl)
    });
  });

  bot.on('message:text',async ctx=>{const replied=ctx.message.reply_to_message;if(!repository||!replied||!('text'in replied))return;const match=replied.text.match(/#parent-request:([lhpamo]):([0-9a-f-]{36})/);if(!match)return;const category=contactCategories[match[1]!];if(!category)return;try{const request=await repository.createParentContactRequestByTelegram(String(ctx.from.id),match[2]!,category.value,ctx.message.text);await ctx.reply(`✅ Запит щодо ${request.studentName} передано команді школи. Ми зв’яжемося з вами.`);}catch{await ctx.reply('Не вдалося надіслати запит. Перевірте прив’язку профілю або спробуйте ще раз.');}});

  bot.catch(error => {
    const detail = error.error instanceof Error ? error.error.message : 'Unknown bot update error';
    console.error('Telegram bot update failed:', detail);
  });
  return bot;
}
