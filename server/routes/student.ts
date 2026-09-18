import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { AppRepository } from '../data/repository.js';
import { AppError } from '../errors/app-error.js';
import type { AiMentorService } from '../services/ai-mentor-service.js';

const uuid = z.string().uuid();
const idempotency = z.object({ idempotencyKey: z.string().min(8).max(100) });
const projectInput = z.object({ title: z.string().trim().min(2).max(120), summary: z.string().trim().max(1000).default('') });
const projectUpdate = projectInput.partial().refine(value => Object.keys(value).length > 0, 'At least one field is required');
const messageInput = z.object({ content: z.string().trim().min(1).max(4000), clientMessageId: z.string().uuid().optional() });
const safeHttpsUrl = z.string().url().refine(value => new URL(value).protocol === 'https:', 'Only HTTPS URLs are allowed');
const homeworkSubmission = z.object({ contentText: z.string().trim().min(1).max(20_000), contentUrl: safeHttpsUrl.optional(), studentComment: z.string().trim().max(2000).optional() });
const portfolioInput = z.object({ reflection: z.string().trim().max(3000).optional(), learned: z.string().trim().max(3000).optional() });

export function registerStudentRoutes(app: FastifyInstance, repository: AppRepository, ai: AiMentorService, authenticate: preHandlerHookHandler): void {
  const secured = { preHandler: authenticate };
  app.get('/api/v1/me', secured, async request => repository.getProfile(request.auth.userId));
  app.get('/api/v1/profile', secured, async request => repository.getProfile(request.auth.userId));
  app.get('/api/v1/home', secured, async request => repository.getHome(request.auth.userId));
  app.get('/api/v1/bootstrap', secured, async request => {
    const userId = request.auth.userId;
    const [home, learning, projects, profile, conversations, schedule, homework, portfolio] = await Promise.all([
      repository.getHome(userId), repository.getLearning(userId), repository.listProjects(userId),
      repository.getProfile(userId), repository.listConversations(userId), repository.getSchedule(userId),
      repository.listHomework(userId), repository.getPortfolio(userId)
    ]);
    return { home, learning, projects, profile, conversations, schedule, homework, portfolio };
  });
  app.get('/api/v1/schedule', secured, async request => repository.getSchedule(request.auth.userId));
  app.get('/api/v1/classes/:sessionId', secured, async request => {
    const { sessionId } = z.object({ sessionId: uuid }).parse(request.params);
    const schedule = await repository.getSchedule(request.auth.userId);
    const session = [...schedule.upcoming, ...schedule.past].find(item => item.id === sessionId);
    if (!session) throw new AppError('CLASS_NOT_FOUND', 404, 'Заняття не знайдено');
    return session;
  });
  app.get('/api/v1/homework', secured, async request => repository.listHomework(request.auth.userId));
  app.get('/api/v1/homework/:homeworkId', secured, async request => {
    const { homeworkId } = z.object({ homeworkId: uuid }).parse(request.params);
    const homework = (await repository.listHomework(request.auth.userId)).find(item => item.id === homeworkId);
    if (!homework) throw new AppError('HOMEWORK_NOT_FOUND', 404, 'Домашнє завдання не знайдено');
    return homework;
  });
  app.post('/api/v1/homework/:homeworkId/submissions', secured, async (request, reply) => {
    const { homeworkId } = z.object({ homeworkId: uuid }).parse(request.params);
    const parsed = homeworkSubmission.parse(request.body);
    const input: { contentText: string; contentUrl?: string; studentComment?: string } = { contentText: parsed.contentText };
    if (parsed.contentUrl !== undefined) input.contentUrl = parsed.contentUrl;
    if (parsed.studentComment !== undefined) input.studentComment = parsed.studentComment;
    return reply.status(201).send(await repository.submitHomework(request.auth.userId, homeworkId, input));
  });
  app.get('/api/v1/portfolio', secured, async request => repository.getPortfolio(request.auth.userId));
  app.post('/api/v1/portfolio/projects/:projectId', secured, async (request, reply) => {
    const { projectId } = z.object({ projectId: uuid }).parse(request.params);
    const parsed = portfolioInput.parse(request.body ?? {});
    const input: { reflection?: string; learned?: string } = {};
    if (parsed.reflection !== undefined) input.reflection = parsed.reflection;
    if (parsed.learned !== undefined) input.learned = parsed.learned;
    return reply.status(201).send(await repository.addProjectToPortfolio(request.auth.userId, projectId, input));
  });
  app.get('/api/v1/mentor/availability', secured, async request => repository.listMentorSlots(request.auth.userId));
  app.post('/api/v1/mentor/bookings', secured, async (request, reply) => {
    const { availabilityId } = z.object({ availabilityId: uuid }).parse(request.body);
    return reply.status(201).send(await repository.bookMentorSlot(request.auth.userId, availabilityId));
  });
  app.get('/api/v1/learning', secured, async request => repository.getLearning(request.auth.userId));
  app.get('/api/v1/courses', secured, async request => [await repository.getLearning(request.auth.userId).then(result => result.course)]);
  app.get('/api/v1/lessons/:lessonId', secured, async request => {
    const { lessonId } = z.object({ lessonId: uuid }).parse(request.params);
    const lesson = await repository.getLesson(request.auth.userId, lessonId);
    if (!lesson) throw new AppError('LESSON_NOT_FOUND', 404, 'Урок не знайдено');
    return lesson;
  });
  app.post('/api/v1/lessons/:lessonId/complete', secured, async request => {
    const { lessonId } = z.object({ lessonId: uuid }).parse(request.params);
    const body = idempotency.parse(request.body);
    return repository.completeLesson(request.auth.userId, lessonId, body.idempotencyKey);
  });

  app.get('/api/v1/projects', secured, async request => repository.listProjects(request.auth.userId));
  app.post('/api/v1/projects', secured, async (request, reply) => reply.status(201).send(await repository.createProject(request.auth.userId, projectInput.parse(request.body))));
  app.patch('/api/v1/projects/:projectId', secured, async request => {
    const { projectId } = z.object({ projectId: uuid }).parse(request.params);
    const parsed = projectUpdate.parse(request.body);
    const input: { title?: string; summary?: string } = {};
    if (parsed.title !== undefined) input.title = parsed.title;
    if (parsed.summary !== undefined) input.summary = parsed.summary;
    const project = await repository.updateProject(request.auth.userId, projectId, input);
    if (!project) throw new AppError('PROJECT_NOT_FOUND', 404, 'Проєкт не знайдено');
    return project;
  });
  app.post('/api/v1/projects/:projectId/tasks/:taskId/complete', secured, async request => {
    const { projectId, taskId } = z.object({ projectId: uuid, taskId: uuid }).parse(request.params);
    const result = await repository.completeProjectTask(request.auth.userId, projectId, taskId, idempotency.parse(request.body).idempotencyKey);
    if (!result) throw new AppError('PROJECT_TASK_NOT_FOUND', 404, 'Завдання не знайдено');
    return result;
  });

  app.get('/api/v1/achievements', secured, async request => repository.listAchievements(request.auth.userId));
  app.get('/api/v1/ai/conversations', secured, async request => repository.listConversations(request.auth.userId));
  app.post('/api/v1/ai/conversations', secured, async (request, reply) => {
    const body = z.object({ title: z.string().trim().min(1).max(120).optional() }).parse(request.body ?? {});
    return reply.status(201).send(await repository.createConversation(request.auth.userId, body.title));
  });
  app.get('/api/v1/ai/conversations/:conversationId/messages', secured, async request => {
    const { conversationId } = z.object({ conversationId: uuid }).parse(request.params);
    const { limit, before } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), before: z.string().datetime().optional() }).parse(request.query);
    return repository.listMessages(request.auth.userId, conversationId, limit, before);
  });
  app.post('/api/v1/ai/conversations/:conversationId/messages', { ...secured, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async request => {
    const { conversationId } = z.object({ conversationId: uuid }).parse(request.params);
    const body = messageInput.parse(request.body);
    return ai.send(request.auth.userId, conversationId, body.content, body.clientMessageId);
  });
}
