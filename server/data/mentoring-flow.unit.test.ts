import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { createJwtService, type JwtService } from '../auth/jwt-service.js';
import { MemorySessionStore } from '../auth/session-store.js';
import { loadEnv } from '../config/env.js';
import { MockAiProvider } from '../services/ai-provider.js';
import { MemoryMentoringStore } from './mentoring-store.js';
import { MemoryRepository } from './memory-repository.js';
import { DEV_IDS, PILOT_STUDENTS } from './seed.js';

const MENTOR_ID = '12000000-0000-4000-8000-000000000001';
const NON_MENTOR_TEACHER_ID = '12000000-0000-4000-8000-000000000002';
const SECOND_STUDENT_ID = '10000000-0000-4000-8000-000000000002';
let jwt: JwtService;
const apps: FastifyInstance[] = [];

beforeAll(async () => {
  jwt = await createJwtService(loadEnv({
    NODE_ENV: 'test', DATA_BACKEND: 'memory', DEV_AUTH_ENABLED: 'true',
    DEV_EPHEMERAL_JWT: 'true', SESSION_TOKEN_PEPPER: 'mentoring-flow-test-pepper'
  }));
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
});

async function appFor(userId: string, sessions: MemorySessionStore, mentoring: MemoryMentoringStore): Promise<{ app: FastifyInstance; headers: { authorization: string } }> {
  const env = loadEnv({
    NODE_ENV: 'test', DATA_BACKEND: 'memory', DEV_AUTH_ENABLED: 'true', DEV_USER_ID: userId,
    DEV_EPHEMERAL_JWT: 'true', SESSION_TOKEN_PEPPER: 'mentoring-flow-test-pepper'
  });
  const app = await buildApp({
    env,
    repository: new MemoryRepository(undefined, { sessionStore: sessions, mentoringStore: mentoring }),
    jwt,
    aiProvider: new MockAiProvider()
  });
  apps.push(app);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/development' });
  expect(login.statusCode).toBe(200);
  return { app, headers: { authorization: `Bearer ${login.json().accessToken as string}` } };
}

describe('mentoring slots end-to-end', () => {
  it('shares a slot across isolated instances, books it atomically and shows the student to the mentor', async () => {
    const sessions = new MemorySessionStore();
    const mentoring = new MemoryMentoringStore();
    const teacher = await appFor(MENTOR_ID, sessions, mentoring);
    const firstStudent = await appFor(DEV_IDS.user, sessions, mentoring);
    const secondStudent = await appFor(SECOND_STUDENT_ID, sessions, mentoring);
    const startsAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const endsAt = new Date(Date.now() + 2 * 86_400_000 + 30 * 60_000).toISOString();

    const created = await teacher.app.inject({
      method: 'POST', url: '/api/v1/teacher/mentor/availability', headers: teacher.headers,
      payload: { startsAt, endsAt, timezone: 'Europe/Kyiv', status: 'open' }
    });
    expect(created.statusCode).toBe(201);

    const studentSlots = await firstStudent.app.inject({ method: 'GET', url: '/api/v1/mentor/availability', headers: firstStudent.headers });
    expect(studentSlots.statusCode).toBe(200);
    const slot = (studentSlots.json() as Array<{ id: string; startsAt: string; available: boolean }>).find(item => item.startsAt === startsAt);
    expect(slot).toMatchObject({ startsAt, available: true });

    const booked = await firstStudent.app.inject({
      method: 'POST', url: '/api/v1/mentor/bookings', headers: firstStudent.headers,
      payload: { availabilityId: slot!.id }
    });
    expect(booked.statusCode).toBe(201);
    expect(booked.json()).toMatchObject({ startsAt, status: 'reserved' });

    const afterBooking = await secondStudent.app.inject({ method: 'GET', url: '/api/v1/mentor/availability', headers: secondStudent.headers });
    expect((afterBooking.json() as Array<{ id: string; available: boolean }>).find(item => item.id === slot!.id)).toMatchObject({ available: false });
    expect(JSON.stringify(afterBooking.json())).not.toContain(PILOT_STUDENTS[0].fullName);
    const duplicate = await secondStudent.app.inject({
      method: 'POST', url: '/api/v1/mentor/bookings', headers: secondStudent.headers,
      payload: { availabilityId: slot!.id }
    });
    expect(duplicate.statusCode).toBe(409);

    const refreshedTeacher = await appFor(MENTOR_ID, sessions, mentoring);
    const workspace = await refreshedTeacher.app.inject({ method: 'GET', url: '/api/v1/teacher/bootstrap', headers: refreshedTeacher.headers });
    expect(workspace.statusCode).toBe(200);
    expect(workspace.json().mentor.availability).toContainEqual(expect.objectContaining({ id: slot!.id, status: 'booked' }));
    expect(workspace.json().mentor.bookings).toContainEqual(expect.objectContaining({
      id: booked.json().id,
      studentId: DEV_IDS.user,
      studentName: PILOT_STUDENTS[0].fullName,
      status: 'reserved'
    }));
    expect(workspace.json().students.find((student: { id: string }) => student.id === DEV_IDS.user).mentorBookings).toContainEqual(expect.objectContaining({ id: booked.json().id }));
    expect(workspace.json().students.find((student: { id: string }) => student.id === SECOND_STUDENT_ID).mentorBookings).toEqual([]);
    const refreshedProfile = await firstStudent.app.inject({ method: 'GET', url: '/api/v1/profile', headers: firstStudent.headers });
    expect(refreshedProfile.json().mentor.nextMeetingAt).toBe(startsAt);
    expect((await firstStudent.app.inject({ method: 'GET', url: '/api/v1/teacher/bootstrap', headers: firstStudent.headers })).statusCode).toBe(403);
    expect((await firstStudent.app.inject({
      method: 'POST', url: '/api/v1/teacher/mentor/availability', headers: firstStudent.headers,
      payload: { startsAt, endsAt, timezone: 'Europe/Kyiv', status: 'open' }
    })).statusCode).toBe(403);
  });

  it('does not let a non-mentor teacher publish mentor availability', async () => {
    const actor = await appFor(NON_MENTOR_TEACHER_ID, new MemorySessionStore(), new MemoryMentoringStore());
    const startsAt = new Date(Date.now() + 86_400_000).toISOString();
    const endsAt = new Date(Date.now() + 86_400_000 + 30 * 60_000).toISOString();
    const response = await actor.app.inject({
      method: 'POST', url: '/api/v1/teacher/mentor/availability', headers: actor.headers,
      payload: { startsAt, endsAt, timezone: 'Europe/Kyiv', status: 'open' }
    });
    expect(response.statusCode).toBe(403);
  });
});
