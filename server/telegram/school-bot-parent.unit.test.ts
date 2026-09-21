import { describe, expect, it } from 'vitest';
import type { ParentSummaryDto } from '../types/domain.js';
import { parentKeyboard, sectionText, summaryText } from './school-bot.js';

function summary(overrides:Partial<ParentSummaryDto>={}):ParentSummaryDto{return{
  student:{id:'10000000-0000-4000-8000-000000000001',name:'Дуже Довге Ім’я Дитини Для Перевірки Telegram',groupName:'Пілот'},nextClass:null,
  progress:{percent:0,completedLessons:0,totalLessons:8},homework:{completed:0,pending:0,overdue:0},attendance:{attended:0,missed:0,late:0,excused:0},grades:[],project:null,mentoring:null,recovery:null,...overrides
};}

describe('Parent Telegram presentation',()=>{
  it('handles empty project, grades and multiple-child navigation',()=>{
    const value=summary();
    expect(sectionText(value,'r')).toContain('Проєкт ще не створено.');
    expect(sectionText(value,'f')).toContain('Оцінок ще немає');
    const keyboard=parentKeyboard(value,true).inline_keyboard.flat();
    expect(keyboard.map(button=>button.text)).toEqual(expect.arrayContaining(['🚀 Проєкт','💬 Потрібна консультація','← Інша дитина']));
  });

  it('clips long feedback and project copy below the Telegram message limit',()=>{
    const feedback='Корисний feedback '.repeat(400),value=summary({grades:[{homeworkTitle:'ДЗ',score:10,feedback,reviewedAt:new Date().toISOString()}],project:{id:'30000000-0000-4000-8000-000000000001',title:'Великий проєкт',description:'Опис '.repeat(1000),status:'active',stage:'Прототип',progressPercent:38,completedTasks:['Ідея','План'],nextTask:'Тестування',updatedAt:new Date().toISOString(),viewUrl:null}});
    expect(summaryText(value).length).toBeLessThanOrEqual(3600);
    expect(sectionText(value,'f').length).toBeLessThanOrEqual(3600);
    expect(sectionText(value,'r').length).toBeLessThanOrEqual(3600);
  });
});
