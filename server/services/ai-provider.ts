import type { AiContextDto } from '../types/domain.js';

export interface AiProvider {
  readonly name: string;
  generate(context: AiContextDto, userMessage: string): Promise<string>;
}

export class MockAiProvider implements AiProvider {
  readonly name = 'mock';

  async generate(context: AiContextDto, userMessage: string): Promise<string> {
    const message = userMessage.toLowerCase();
    if (message.includes('поясни')) {
      return `Спробуймо простіше. ${context.lessonTitle ? `У темі «${context.lessonTitle}»` : 'У цій темі'} головне — спочатку побачити приклад, а потім назвати правило. Яку частину розберемо на твоєму прикладі?`;
    }
    if (message.includes('іде')) {
      return `Перевіримо ідею як творці: для кого саме ${context.projectTitle ?? 'твій проєкт'} і яку одну проблему він прибирає? Напиши відповідь одним реченням.`;
    }
    if (context.nextProjectTask) {
      return `Твій наступний крок — «${context.nextProjectTask}». Не робитиму його замість тебе: який найменший результат ти можеш показати вже сьогодні?`;
    }
    return 'Добре. Почнімо з головного: який результат ти хочеш отримати і як зрозумієш, що він працює?';
  }
}
