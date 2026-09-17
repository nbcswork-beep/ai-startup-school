import { describe, expect, it } from 'vitest';
import { createJwtService } from '../auth/jwt-service.js';
import { loadEnv } from '../config/env.js';
import { MemoryRepository } from '../data/memory-repository.js';
import { AuthService } from './auth-service.js';

function testEnv() {
  return loadEnv({ NODE_ENV:'test', DATA_BACKEND:'memory', DEV_AUTH_ENABLED:'true', DEV_EPHEMERAL_JWT:'true', SESSION_TOKEN_PEPPER:'a-long-test-pepper', ACCESS_TOKEN_TTL_SECONDS:'600' });
}

describe('refresh-session rotation', () => {
  it('rotates once and revokes the family if an old token is reused', async () => {
    const env=testEnv(); const repository=new MemoryRepository(); const jwt=await createJwtService(env); const auth=new AuthService(repository,jwt,env);
    const login=await auth.loginDevelopmentUser();
    const rotated=await auth.refresh(login.refreshToken);
    expect((await jwt.verify(rotated.accessToken)).provider).toBe('development');
    await expect(auth.refresh(login.refreshToken)).rejects.toMatchObject({ code:'REFRESH_TOKEN_REUSE' });
    await expect(auth.refresh(rotated.refreshToken)).rejects.toMatchObject({ code:'REFRESH_TOKEN_INVALID' });
  });
  it('revokes a refresh family on logout', async () => {
    const env=testEnv(); const repository=new MemoryRepository(); const jwt=await createJwtService(env); const auth=new AuthService(repository,jwt,env);
    const login=await auth.loginDevelopmentUser();
    await auth.logout(login.refreshToken);
    await expect(auth.refresh(login.refreshToken)).rejects.toMatchObject({ code:'REFRESH_TOKEN_INVALID' });
  });
});
