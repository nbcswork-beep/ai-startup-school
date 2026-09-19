import { describe, expect, it, vi } from 'vitest';
import { buildWebAuthAccountsJson, WEB_AUTH_BOOTSTRAP_IDENTITIES } from './auth/bootstrap-accounts.js';
import { WebCredentialDirectory } from './auth/password-credentials.js';

describe('Production web-auth bootstrap', () => {
  it('keeps the fixed pilot identities and roles', () => {
    expect(WEB_AUTH_BOOTSTRAP_IDENTITIES).toEqual([
      { key:'maksym', userId:'12000000-0000-4000-8000-000000000001', name:'Анохін Максим', roles:['teacher','mentor','admin'] },
      { key:'vadym', userId:'12000000-0000-4000-8000-000000000002', name:'Кривич Вадим', roles:['teacher'] }
    ]);
  });

  it('builds compact account JSON without exposing plaintext passwords', async () => {
    const hasher = vi.fn(async password => `scrypt$65536$8$1$${Buffer.from(password).toString('base64url')}$${Buffer.alloc(64, 1).toString('base64url')}`);
    const json = await buildWebAuthAccountsJson({
      maksym:{ email:'  MAKSYM@Example.test ', password:'maksym-password-123' },
      vadym:{ email:'vadym@example.test', password:'vadym-password-456' }
    }, hasher);
    const accounts = JSON.parse(json);
    expect(accounts).toMatchObject([
      { userId:'12000000-0000-4000-8000-000000000001', email:'maksym@example.test' },
      { userId:'12000000-0000-4000-8000-000000000002', email:'vadym@example.test' }
    ]);
    expect(json).not.toContain('maksym-password-123');
    expect(json).not.toContain('vadym-password-456');
    expect(hasher).toHaveBeenCalledTimes(2);
  });

  it('rejects duplicate emails before hashing passwords', async () => {
    const hasher = vi.fn(async () => 'unused');
    await expect(buildWebAuthAccountsJson({
      maksym:{ email:'same@example.test', password:'maksym-password-123' },
      vadym:{ email:'SAME@example.test', password:'vadym-password-456' }
    }, hasher)).rejects.toThrow(/unique email/);
    expect(hasher).not.toHaveBeenCalled();
  });

  it('generates credentials accepted by the production credential directory', async () => {
    const json = await buildWebAuthAccountsJson({
      maksym:{ email:'maksym@example.test', password:'maksym-production-test-123' },
      vadym:{ email:'vadym@example.test', password:'vadym-production-test-456' }
    });
    const directory = new WebCredentialDirectory(json);
    await expect(directory.authenticate('maksym@example.test', 'maksym-production-test-123')).resolves.toMatchObject({ userId:'12000000-0000-4000-8000-000000000001' });
    await expect(directory.authenticate('vadym@example.test', 'vadym-production-test-456')).resolves.toMatchObject({ userId:'12000000-0000-4000-8000-000000000002' });
  });
});
