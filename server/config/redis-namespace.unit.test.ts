import { describe, expect, it } from 'vitest';
import { RedisNamespaceIsolationError, assertRedisNamespaceIsolation, loadEnv, resolveDeployEnvironment, resolveRuntimeRedisPrefix } from './env.js';

const guard = (deployEnvironment: 'production' | 'preview' | 'development' | 'local', ...prefixes: string[]) =>
  () => assertRedisNamespaceIsolation({
    deployEnvironment,
    prefixes: prefixes.map((value, index) => ({ field: index === 0 ? 'SESSION_REDIS_PREFIX' : 'PILOT_RUNTIME_REDIS_PREFIX', value }))
  });

describe('Redis namespace isolation guard', () => {
  it('accepts a production deployment on a production namespace', () => {
    expect(guard('production', 'aiss:production:sessions:v1')).not.toThrow();
    expect(guard('production', 'aiss:prod:sessions:v1', 'aiss:prod:runtime:v1')).not.toThrow();
  });

  it('accepts a preview deployment on a preview namespace', () => {
    expect(guard('preview', 'aiss:preview:sessions:v1')).not.toThrow();
    expect(guard('preview', 'aiss:preview:sessions:v1', 'aiss:preview:runtime:v1')).not.toThrow();
  });

  it('rejects a preview deployment that points at the production namespace', () => {
    expect(guard('preview', 'aiss:production:sessions:v1')).toThrow(RedisNamespaceIsolationError);
    expect(guard('preview', 'aiss:production:sessions:v1')).toThrow(/preview must never share the production namespace/);
  });

  it('rejects a preview deployment whose runtime prefix leaks into production', () => {
    let caught: unknown;
    try { guard('preview', 'aiss:preview:sessions:v1', 'aiss:live:pilot-runtime:v1')(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(RedisNamespaceIsolationError);
    expect((caught as RedisNamespaceIsolationError).fields).toEqual(['PILOT_RUNTIME_REDIS_PREFIX']);
  });

  it('rejects a production deployment sitting on a preview or local namespace', () => {
    expect(guard('production', 'aiss:preview:sessions:v1')).toThrow(/scoped to "preview"/);
    expect(guard('production', 'aiss:local:sessions:v1')).toThrow(/scoped to "local"/);
    expect(guard('production', 'aiss:staging:sessions:v1')).toThrow(/scoped to "staging"/);
  });

  it('rejects a production namespace that is not explicitly scoped to production', () => {
    expect(guard('production', 'aiss:sessions:v1')).toThrow(/must contain a production namespace segment/);
  });

  it('makes a shared namespace impossible: no prefix satisfies both environments', () => {
    for (const prefix of ['aiss:production:sessions:v1', 'aiss:preview:sessions:v1', 'aiss:sessions:v1', 'aiss:live:v1']) {
      const productionOk = !((): boolean => { try { guard('production', prefix)(); return false; } catch { return true; } })();
      const previewOk = !((): boolean => { try { guard('preview', prefix)(); return false; } catch { return true; } })();
      expect(productionOk && previewOk).toBe(false);
    }
  });

  it('leaves local development and unmarked deployments alone', () => {
    expect(guard('local', 'aiss:local:sessions:v1')).not.toThrow();
    expect(guard('local', 'aiss:production:sessions:v1')).not.toThrow();
    expect(guard('development', 'anything:at:all')).not.toThrow();
  });

  it('never repeats a credential value in its diagnostics', () => {
    let message = '';
    try { guard('preview', 'aiss:production:sessions:v1')(); } catch (error) { message = (error as Error).message; }
    expect(message).toContain('SESSION_REDIS_PREFIX');
    expect(message).not.toMatch(/token|password|secret-value/i);
  });
});

describe('deployment environment and runtime prefix resolution', () => {
  it('reads the platform marker and falls back to local', () => {
    expect(resolveDeployEnvironment({ VERCEL_ENV: 'production' })).toBe('production');
    expect(resolveDeployEnvironment({ VERCEL_TARGET_ENV: 'preview' })).toBe('preview');
    expect(resolveDeployEnvironment({})).toBe('local');
    expect(resolveDeployEnvironment({ NODE_ENV: 'production' })).toBe('local');
  });

  it('keeps the historical runtime key derivation so existing data stays addressable', () => {
    expect(resolveRuntimeRedisPrefix({ SESSION_REDIS_PREFIX: 'aiss:production:sessions:v1' }))
      .toBe('aiss:production:sessions:v1:pilot-runtime:v1');
    expect(resolveRuntimeRedisPrefix({ SESSION_REDIS_PREFIX: 'aiss:production:sessions:v1', PILOT_RUNTIME_REDIS_PREFIX: 'aiss:production:runtime:v2' }))
      .toBe('aiss:production:runtime:v2');
  });

  it('fails loading the environment when a preview deployment is aimed at production data', () => {
    expect(() => loadEnv({
      NODE_ENV: 'development', DATA_BACKEND: 'memory', DEV_EPHEMERAL_JWT: 'true',
      SESSION_TOKEN_PEPPER: 'local-pepper', VERCEL_ENV: 'preview', SESSION_REDIS_PREFIX: 'aiss:production:sessions:v1'
    })).toThrow(RedisNamespaceIsolationError);
  });

  it('loads a correctly scoped deployment and exposes the derived values', () => {
    const env = loadEnv({
      NODE_ENV: 'development', DATA_BACKEND: 'memory', DEV_EPHEMERAL_JWT: 'true',
      SESSION_TOKEN_PEPPER: 'local-pepper', VERCEL_ENV: 'preview', SESSION_REDIS_PREFIX: 'aiss:preview:sessions:v1'
    });
    expect(env.deployEnvironment).toBe('preview');
    expect(env.runtimeRedisPrefix).toBe('aiss:preview:sessions:v1:pilot-runtime:v1');
    expect(env.ALLOW_RUNTIME_STATE_BOOTSTRAP).toBe(false);
  });

  it('still works for a plain local run with no platform markers', () => {
    const env = loadEnv({ NODE_ENV: 'development', DATA_BACKEND: 'memory', DEV_EPHEMERAL_JWT: 'true', SESSION_TOKEN_PEPPER: 'local-pepper' });
    expect(env.deployEnvironment).toBe('local');
    expect(env.runtimeRedisPrefix).toBe('aiss:local:sessions:v1:pilot-runtime:v1');
  });
});
