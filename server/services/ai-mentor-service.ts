import { randomUUID } from 'node:crypto';
import type { AppRepository } from '../data/repository.js';
import { AppError } from '../errors/app-error.js';
import type { AiProvider } from './ai-provider.js';

export class AiMentorService {
  constructor(private readonly repository: AppRepository, private readonly provider: AiProvider) {}

  async send(userId: string, conversationId: string, content: string, clientMessageId?: string) {
    const conversation = await this.repository.getConversation(userId, conversationId);
    if (!conversation) throw new AppError('CONVERSATION_NOT_FOUND', 404, 'Розмову не знайдено');

    const userMessage = await this.repository.appendAiMessage(userId, conversationId, {
      role: 'user', content, clientMessageId: clientMessageId ?? randomUUID()
    });
    if (!userMessage) throw new AppError('CONVERSATION_NOT_FOUND', 404, 'Розмову не знайдено');

    const context = await this.repository.getAiContext(userId, conversationId);
    if (!context) throw new AppError('CONVERSATION_NOT_FOUND', 404, 'Розмову не знайдено');
    const response = await this.provider.generate(context, content);
    const assistantMessage = await this.repository.appendAiMessage(userId, conversationId, { role: 'assistant', content: response });
    if (!assistantMessage) throw new AppError('AI_MESSAGE_FAILED', 500, 'Не вдалося зберегти відповідь');
    return { userMessage, assistantMessage, provider: this.provider.name };
  }
}
