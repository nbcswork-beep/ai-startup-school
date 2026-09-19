import { z } from 'zod';
import { PILOT_TEACHERS } from '../data/seed.js';
import { hashPassword, normalizeEmail, WebCredentialDirectory } from './password-credentials.js';

const bootstrapInputSchema = z.object({
  maksym: z.object({ email:z.string().trim().email().max(254), password:z.string().min(14).max(128) }),
  vadym: z.object({ email:z.string().trim().email().max(254), password:z.string().min(14).max(128) })
}).strict();

function teacherId(key: 'maksym'|'vadym'): string {
  const teacher = PILOT_TEACHERS.find(item => item.key === key);
  if (!teacher) throw new Error(`Missing pilot teacher identity: ${key}`);
  return teacher.id;
}

export const WEB_AUTH_BOOTSTRAP_IDENTITIES = [
  { key:'maksym' as const, userId:teacherId('maksym'), name:'Анохін Максим', roles:['teacher','mentor','admin'] as const },
  { key:'vadym' as const, userId:teacherId('vadym'), name:'Кривич Вадим', roles:['teacher'] as const }
] as const;

export type WebAuthBootstrapInput = {
  maksym: { email: string; password: string };
  vadym: { email: string; password: string };
};

export async function buildWebAuthAccountsJson(
  input: WebAuthBootstrapInput,
  passwordHasher: (password: string) => Promise<string> = hashPassword
): Promise<string> {
  const parsed = bootstrapInputSchema.parse(input);
  const maksymEmail = normalizeEmail(parsed.maksym.email);
  const vadymEmail = normalizeEmail(parsed.vadym.email);
  if (maksymEmail === vadymEmail) throw new Error('Each web-auth account must use a unique email');

  const accounts = [];
  for (const identity of WEB_AUTH_BOOTSTRAP_IDENTITIES) {
    const credentials = parsed[identity.key];
    accounts.push({
      userId:identity.userId,
      email:normalizeEmail(credentials.email),
      passwordHash:await passwordHasher(credentials.password)
    });
  }

  const json = JSON.stringify(accounts);
  new WebCredentialDirectory(json);
  return json;
}
