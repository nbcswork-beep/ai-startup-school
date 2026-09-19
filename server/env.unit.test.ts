import { describe, expect, it } from 'vitest';
import { EnvironmentConfigurationError, loadEnv } from './config/env.js';

const productionEnvironment = ():NodeJS.ProcessEnv => ({
  NODE_ENV:'production',
  DATA_BACKEND:'memory',
  ALLOW_VOLATILE_DATA_IN_PRODUCTION:'true',
  APP_ORIGINS:'https://ai-startup-school.vercel.app',
  APP_JWT_PRIVATE_KEY_BASE64:'private-key-placeholder',
  APP_JWT_PUBLIC_KEY_BASE64:'public-key-placeholder',
  SESSION_TOKEN_PEPPER:'session-pepper-placeholder',
  TELEGRAM_BOT_TOKEN:'123456789:test-token',
  WEB_AUTH_ACCOUNTS_JSON:'[{"userId":"12000000-0000-4000-8000-000000000001"}]',
  TELEGRAM_WEBHOOK_SECRET:'valid_webhook_secret_123456',
  MINI_APP_URL:'https://ai-startup-school.vercel.app',
  SESSION_REDIS_PREFIX:'aiss:production:sessions:v1',
  UPSTASH_REDIS_REST_KV_REST_API_URL:'https://integration-redis.example.test',
  UPSTASH_REDIS_REST_KV_REST_API_TOKEN:'integration-token-placeholder',
  DEV_AUTH_ENABLED:'false',
  DEV_EPHEMERAL_JWT:'false'
});

describe('environment diagnostics',()=>{
  it('accepts the Production Vercel integration names and configured session prefix',()=>{
    const env=loadEnv(productionEnvironment());
    expect(env.UPSTASH_REDIS_REST_URL).toBe('https://integration-redis.example.test');
    expect(env.SESSION_REDIS_PREFIX).toBe('aiss:production:sessions:v1');
  });

  it('safely trims external whitespace from the Telegram webhook secret',()=>{
    const env=loadEnv({...productionEnvironment(),TELEGRAM_WEBHOOK_SECRET:'  valid_webhook_secret_123456\r\n'});
    expect(env.TELEGRAM_WEBHOOK_SECRET).toBe('valid_webhook_secret_123456');
  });

  it('reports invalid field names without exposing secret values',()=>{
    const secret='invalid+webhook/secret=';
    let caught:unknown;
    try{loadEnv({...productionEnvironment(),TELEGRAM_WEBHOOK_SECRET:secret,SESSION_REDIS_PREFIX:'invalid prefix'})}catch(error){caught=error}
    expect(caught).toBeInstanceOf(EnvironmentConfigurationError);
    const message=(caught as Error).message;
    expect(message).toContain('TELEGRAM_WEBHOOK_SECRET');
    expect(message).toContain('SESSION_REDIS_PREFIX');
    expect(message).not.toContain(secret);
    expect(message).not.toContain('integration-token-placeholder');
  });

  it('identifies an invalid integration URL without exposing it',()=>{
    const invalidUrl='http://redis-with-private-host.example.test';
    let caught:unknown;
    try{loadEnv({...productionEnvironment(),UPSTASH_REDIS_REST_KV_REST_API_URL:invalidUrl})}catch(error){caught=error}
    expect(caught).toBeInstanceOf(EnvironmentConfigurationError);
    const message=(caught as Error).message;
    expect(message).toContain('UPSTASH_REDIS_REST_KV_REST_API_URL');
    expect(message).not.toContain(invalidUrl);
  });
});
