import { AppError } from '../errors/app-error.js';
import type { NewSession } from '../types/domain.js';

export interface StoredSession extends NewSession {
  revokedAt: Date | null;
  replacedBy: string | null;
}

export type SessionRotation =
  | { status: 'ok'; session: NewSession }
  | { status: 'invalid' | 'expired' | 'revoked' | 'reused' };

export interface SessionStore {
  create(session: NewSession): Promise<void>;
  rotate(currentTokenHash: string, next: NewSession, now: Date): Promise<SessionRotation>;
  revokeFamily(refreshTokenHash: string, now: Date): Promise<boolean>;
  isActive(userId: string, sessionId: string, now: Date): Promise<boolean>;
  revokeById(sessionId: string, now: Date): Promise<StoredSession | null>;
  revokeUser(userId: string, now: Date): Promise<void>;
  listActive(now: Date): Promise<StoredSession[]>;
  extendById(sessionId:string, expectedExpiresAt:string, now:Date):Promise<StoredSession>;
}

export interface LoginAttemptLimiter {
  consume(key: string, maxAttempts: number, windowSeconds: number): Promise<boolean>;
  reset(key: string): Promise<void>;
}

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, StoredSession>();

  async create(session: NewSession): Promise<void> {
    if ([...this.sessions.values()].some(item => item.refreshTokenHash === session.refreshTokenHash)) {
      throw new AppError('SESSION_CONFLICT', 409, 'Session token conflict');
    }
    this.sessions.set(session.id, { ...session, revokedAt: null, replacedBy: null });
  }

  async rotate(currentTokenHash: string, next: NewSession, now: Date): Promise<SessionRotation> {
    const current = [...this.sessions.values()].find(item => item.refreshTokenHash === currentTokenHash);
    if (!current) return { status: 'invalid' };
    if (current.replacedBy) {
      for (const session of this.sessions.values()) if (session.familyId === current.familyId) session.revokedAt = now;
      return { status: 'reused' };
    }
    if (current.revokedAt) return { status: 'revoked' };
    if (current.expiresAt.getTime() <= now.getTime()) return { status: 'expired' };
    current.revokedAt = now;
    current.replacedBy = next.id;
    const rotated = { ...next, familyId: current.familyId, userId: current.userId, provider: current.provider,
      expiresAt: new Date(Math.max(next.expiresAt.getTime(),current.expiresAt.getTime())) };
    this.sessions.set(next.id, { ...rotated, revokedAt: null, replacedBy: null });
    return { status: 'ok', session: rotated };
  }

  async revokeFamily(refreshTokenHash: string, now: Date): Promise<boolean> {
    const current = [...this.sessions.values()].find(item => item.refreshTokenHash === refreshTokenHash);
    if (!current) return false;
    for (const session of this.sessions.values()) if (session.familyId === current.familyId) session.revokedAt ??= now;
    return true;
  }

  async isActive(userId: string, sessionId: string, now: Date): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    return Boolean(session && session.userId === userId && !session.revokedAt && session.expiresAt.getTime() > now.getTime());
  }

  async revokeById(sessionId: string, now: Date): Promise<StoredSession | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    for (const item of this.sessions.values()) if (item.familyId === session.familyId) item.revokedAt ??= now;
    return structuredClone(session);
  }

  async revokeUser(userId: string, now: Date): Promise<void> {
    for (const session of this.sessions.values()) if (session.userId === userId) session.revokedAt ??= now;
  }

  async listActive(now: Date): Promise<StoredSession[]> {
    return [...this.sessions.values()]
      .filter(item => !item.revokedAt && item.expiresAt.getTime() > now.getTime())
      .map(item => structuredClone(item));
  }

  async extendById(sessionId:string,expectedExpiresAt:string,now:Date):Promise<StoredSession>{
    const session=this.sessions.get(sessionId);
    if(!session||session.revokedAt||session.replacedBy||session.expiresAt.getTime()<=now.getTime())throw new AppError('SESSION_NOT_ACTIVE',409,'Сесія вже неактивна');
    if(session.expiresAt.toISOString()!==expectedExpiresAt)throw new AppError('SESSION_CHANGED',409,'Сесію вже змінено. Оновіть таблицю.');
    session.expiresAt=new Date(session.expiresAt.getTime()+180*86_400_000);
    return structuredClone(session);
  }
}

export class MemoryLoginAttemptLimiter implements LoginAttemptLimiter {
  private readonly attempts = new Map<string, { count: number; expiresAt: number }>();

  async consume(key: string, maxAttempts: number, windowSeconds: number): Promise<boolean> {
    const now = Date.now();
    const current = this.attempts.get(key);
    const value = !current || current.expiresAt <= now
      ? { count: 1, expiresAt: now + windowSeconds * 1000 }
      : { ...current, count: current.count + 1 };
    this.attempts.set(key, value);
    return value.count <= maxAttempts;
  }

  async reset(key: string): Promise<void> { this.attempts.delete(key); }
}

type RedisReply<T> = { result?: T; error?: string };

class RedisRestClient {
  constructor(private readonly url: string, private readonly token: string) {}

  async command<T>(command: Array<string | number>): Promise<T> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(command.map(value => String(value))),
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error(`Session storage request failed (${response.status})`);
    const payload = await response.json() as RedisReply<T>;
    if (payload.error) throw new Error('Session storage command failed');
    return payload.result as T;
  }
}

type SerializedSession = Omit<StoredSession, 'createdAt' | 'expiresAt' | 'revokedAt'> & {
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
};

function serializeSession(session: NewSession, revokedAt: Date | null = null, replacedBy: string | null = null): SerializedSession {
  return { ...session, createdAt: session.createdAt.toISOString(), expiresAt: session.expiresAt.toISOString(), revokedAt: revokedAt?.toISOString() ?? null, replacedBy };
}

function deserializeSession(value: string): StoredSession {
  const session = JSON.parse(value) as SerializedSession;
  return { ...session, createdAt: new Date(session.createdAt), expiresAt: new Date(session.expiresAt), revokedAt: session.revokedAt ? new Date(session.revokedAt) : null };
}

const CREATE_SESSION_SCRIPT = `
local prefix = ARGV[1]
local session = cjson.decode(ARGV[2])
local ttl = tonumber(ARGV[3])
if redis.call('EXISTS', prefix .. ':refresh:' .. session.refreshTokenHash) == 1 then return 'conflict' end
redis.call('SET', prefix .. ':session:' .. session.id, ARGV[2], 'EX', ttl)
redis.call('SET', prefix .. ':refresh:' .. session.refreshTokenHash, session.id, 'EX', ttl)
redis.call('SADD', prefix .. ':family:' .. session.familyId, session.id)
if redis.call('TTL', prefix .. ':family:' .. session.familyId) < ttl then redis.call('EXPIRE', prefix .. ':family:' .. session.familyId, ttl) end
redis.call('SADD', prefix .. ':user:' .. session.userId, session.id)
if redis.call('TTL', prefix .. ':user:' .. session.userId) < ttl then redis.call('EXPIRE', prefix .. ':user:' .. session.userId, ttl) end
redis.call('ZADD', prefix .. ':active', tonumber(ARGV[4]), session.id)
return 'ok'`;

const ROTATE_SESSION_SCRIPT = `
local prefix = ARGV[1]
local currentId = redis.call('GET', prefix .. ':refresh:' .. ARGV[2])
if not currentId then return cjson.encode({status='invalid'}) end
local currentKey = prefix .. ':session:' .. currentId
local currentRaw = redis.call('GET', currentKey)
if not currentRaw then return cjson.encode({status='invalid'}) end
local current = cjson.decode(currentRaw)
local now = tonumber(ARGV[4])
if current.replacedBy and current.replacedBy ~= cjson.null then
  local familyKey = prefix .. ':family:' .. current.familyId
  local members = redis.call('SMEMBERS', familyKey)
  for _, id in ipairs(members) do
    local key = prefix .. ':session:' .. id
    local raw = redis.call('GET', key)
    if raw then
      local item = cjson.decode(raw)
      if not item.revokedAt or item.revokedAt == cjson.null then item.revokedAt = ARGV[5] end
      local ttl = redis.call('TTL', key)
      if ttl > 0 then redis.call('SET', key, cjson.encode(item), 'EX', ttl) end
    end
  end
  return cjson.encode({status='reused'})
end
if current.revokedAt and current.revokedAt ~= cjson.null then return cjson.encode({status='revoked'}) end
if tonumber(current.expiresAtMs) <= now then return cjson.encode({status='expired'}) end
local next = cjson.decode(ARGV[3])
next.familyId = current.familyId
next.userId = current.userId
next.provider = current.provider
if tonumber(current.expiresAtMs) > tonumber(next.expiresAtMs) then
  next.expiresAtMs = current.expiresAtMs
  next.expiresAt = current.expiresAt
end
current.revokedAt = ARGV[5]
current.replacedBy = next.id
local oldTtl = redis.call('TTL', currentKey)
if oldTtl > 0 then redis.call('SET', currentKey, cjson.encode(current), 'EX', oldTtl) end
local ttl = math.max(1, math.ceil((tonumber(next.expiresAtMs) - now) / 1000))
redis.call('SET', prefix .. ':session:' .. next.id, cjson.encode(next), 'EX', ttl)
redis.call('SET', prefix .. ':refresh:' .. next.refreshTokenHash, next.id, 'EX', ttl)
redis.call('SADD', prefix .. ':family:' .. current.familyId, next.id)
if redis.call('TTL', prefix .. ':family:' .. current.familyId) < ttl then redis.call('EXPIRE', prefix .. ':family:' .. current.familyId, ttl) end
redis.call('SADD', prefix .. ':user:' .. current.userId, next.id)
if redis.call('TTL', prefix .. ':user:' .. current.userId) < ttl then redis.call('EXPIRE', prefix .. ':user:' .. current.userId, ttl) end
redis.call('ZADD', prefix .. ':active', tonumber(next.expiresAtMs), next.id)
return cjson.encode({status='ok',session=next})`;

const REVOKE_FAMILY_SCRIPT = `
local prefix = ARGV[1]
local currentId = redis.call('GET', prefix .. ':refresh:' .. ARGV[2])
if not currentId then return 0 end
local currentRaw = redis.call('GET', prefix .. ':session:' .. currentId)
if not currentRaw then return 0 end
local current = cjson.decode(currentRaw)
local members = redis.call('SMEMBERS', prefix .. ':family:' .. current.familyId)
for _, id in ipairs(members) do
  local key = prefix .. ':session:' .. id
  local raw = redis.call('GET', key)
  if raw then
    local item = cjson.decode(raw)
    if not item.revokedAt or item.revokedAt == cjson.null then item.revokedAt = ARGV[3] end
    local ttl = redis.call('TTL', key)
    if ttl > 0 then redis.call('SET', key, cjson.encode(item), 'EX', ttl) end
  end
end
return 1`;

const REVOKE_USER_SCRIPT = `
local prefix = ARGV[1]
local members = redis.call('SMEMBERS', prefix .. ':user:' .. ARGV[2])
for _, id in ipairs(members) do
  local key = prefix .. ':session:' .. id
  local raw = redis.call('GET', key)
  if raw then
    local item = cjson.decode(raw)
    if not item.revokedAt or item.revokedAt == cjson.null then item.revokedAt = ARGV[3] end
    local ttl = redis.call('TTL', key)
    if ttl > 0 then redis.call('SET', key, cjson.encode(item), 'EX', ttl) end
  end
end
return #members`;

const REVOKE_BY_ID_SCRIPT = `
local prefix = ARGV[1]
local raw = redis.call('GET', prefix .. ':session:' .. ARGV[2])
if not raw then return false end
local current = cjson.decode(raw)
local members = redis.call('SMEMBERS', prefix .. ':family:' .. current.familyId)
for _, id in ipairs(members) do
  local key = prefix .. ':session:' .. id
  local itemRaw = redis.call('GET', key)
  if itemRaw then
    local item = cjson.decode(itemRaw)
    if not item.revokedAt or item.revokedAt == cjson.null then item.revokedAt = ARGV[3] end
    local ttl = redis.call('TTL', key)
    if ttl > 0 then redis.call('SET', key, cjson.encode(item), 'EX', ttl) end
  end
end
return raw`;

export class RedisRestSessionStore implements SessionStore {
  private readonly client: RedisRestClient;
  constructor(url: string, token: string, private readonly prefix: string) { this.client = new RedisRestClient(url, token); }

  async create(session: NewSession): Promise<void> {
    const serialized = { ...serializeSession(session), expiresAtMs: session.expiresAt.getTime() };
    const ttl = Math.max(1, Math.ceil((session.expiresAt.getTime() - Date.now()) / 1000));
    const result = await this.client.command<string>(['EVAL', CREATE_SESSION_SCRIPT, 0, this.prefix, JSON.stringify(serialized), ttl, session.expiresAt.getTime()]);
    if (result === 'conflict') throw new AppError('SESSION_CONFLICT', 409, 'Session token conflict');
  }

  async rotate(currentTokenHash: string, next: NewSession, now: Date): Promise<SessionRotation> {
    const serialized = { ...serializeSession(next), expiresAtMs: next.expiresAt.getTime() };
    const ttl = Math.max(1, Math.ceil((next.expiresAt.getTime() - now.getTime()) / 1000));
    const raw = await this.client.command<string>(['EVAL', ROTATE_SESSION_SCRIPT, 0, this.prefix, currentTokenHash, JSON.stringify(serialized), now.getTime(), now.toISOString(), ttl]);
    const result = JSON.parse(raw) as { status: SessionRotation['status']; session?: SerializedSession & { expiresAtMs?: number } };
    if (result.status !== 'ok' || !result.session) return { status: result.status as Exclude<SessionRotation['status'], 'ok'> };
    return { status: 'ok', session: deserializeSession(JSON.stringify(result.session)) };
  }

  async revokeFamily(refreshTokenHash: string, now: Date): Promise<boolean> {
    return (await this.client.command<number>(['EVAL', REVOKE_FAMILY_SCRIPT, 0, this.prefix, refreshTokenHash, now.toISOString()])) === 1;
  }

  async isActive(userId: string, sessionId: string, now: Date): Promise<boolean> {
    const raw = await this.client.command<string | null>(['GET', `${this.prefix}:session:${sessionId}`]);
    if (!raw) return false;
    const session = deserializeSession(raw);
    return session.userId === userId && !session.revokedAt && session.expiresAt.getTime() > now.getTime();
  }

  async revokeById(sessionId: string, now: Date): Promise<StoredSession | null> {
    const raw = await this.client.command<string | null>(['EVAL', REVOKE_BY_ID_SCRIPT, 0, this.prefix, sessionId, now.toISOString()]);
    if (!raw) return null;
    const session = deserializeSession(raw);
    session.revokedAt ??= now;
    return session;
  }

  async revokeUser(userId: string, now: Date): Promise<void> {
    await this.client.command(['EVAL', REVOKE_USER_SCRIPT, 0, this.prefix, userId, now.toISOString()]);
  }

  async listActive(now: Date): Promise<StoredSession[]> {
    await this.client.command(['ZREMRANGEBYSCORE', `${this.prefix}:active`, '-inf', now.getTime()]);
    const ids = await this.client.command<string[]>(['ZRANGEBYSCORE', `${this.prefix}:active`, now.getTime(), '+inf', 'LIMIT', 0, 200]);
    const values = await Promise.all(ids.map(id => this.client.command<string | null>(['GET', `${this.prefix}:session:${id}`])));
    return values.filter((value): value is string => Boolean(value)).map(deserializeSession).filter(item => !item.revokedAt);
  }

  async extendById(sessionId:string,expectedExpiresAt:string,now:Date):Promise<StoredSession>{
    const raw=await this.client.command<string>(['EVAL',EXTEND_SESSION_SCRIPT,0,this.prefix,sessionId,expectedExpiresAt,now.getTime(),new Date(Date.parse(expectedExpiresAt)+180*86_400_000).toISOString()]);
    if(raw==='inactive')throw new AppError('SESSION_NOT_ACTIVE',409,'Сесія вже неактивна');
    if(raw==='changed')throw new AppError('SESSION_CHANGED',409,'Сесію вже змінено. Оновіть таблицю.');
    return deserializeSession(raw);
  }
}

// Compare-and-extend atomically with revoke/rotate. Update every lookup/index TTL too.
const EXTEND_SESSION_SCRIPT = `
local prefix = ARGV[1]
local key = prefix .. ':session:' .. ARGV[2]
local raw = redis.call('GET', key)
if not raw then return 'inactive' end
local session = cjson.decode(raw)
local now = tonumber(ARGV[4])
if (session.revokedAt and session.revokedAt ~= cjson.null) or
   (session.replacedBy and session.replacedBy ~= cjson.null) or tonumber(session.expiresAtMs) <= now then return 'inactive' end
if session.expiresAt ~= ARGV[3] then return 'changed' end
session.expiresAtMs = tonumber(session.expiresAtMs) + 180 * 86400000
-- ISO formatting is supplied by the server after the CAS read through a fixed increment.
-- Redis Lua has no date formatter: derive ISO in JS and pass it as a checked argument.
session.expiresAt = ARGV[5]
local ttl = math.max(1, math.ceil((session.expiresAtMs - now) / 1000))
redis.call('SET', key, cjson.encode(session), 'EX', ttl)
redis.call('SET', prefix .. ':refresh:' .. session.refreshTokenHash, session.id, 'EX', ttl)
for _, index in ipairs({prefix .. ':family:' .. session.familyId, prefix .. ':user:' .. session.userId}) do
  redis.call('SADD', index, session.id)
  if redis.call('TTL', index) < ttl then redis.call('EXPIRE', index, ttl) end
end
redis.call('ZADD', prefix .. ':active', session.expiresAtMs, session.id)
return cjson.encode(session)`;

const LOGIN_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1])) end
return count`;

export class RedisRestLoginAttemptLimiter implements LoginAttemptLimiter {
  private readonly client: RedisRestClient;
  constructor(url: string, token: string, private readonly prefix: string) { this.client = new RedisRestClient(url, token); }
  async consume(key: string, maxAttempts: number, windowSeconds: number): Promise<boolean> {
    const count = await this.client.command<number>(['EVAL', LOGIN_LIMIT_SCRIPT, 1, `${this.prefix}:login:${key}`, windowSeconds]);
    return count <= maxAttempts;
  }
  async reset(key: string): Promise<void> { await this.client.command(['DEL', `${this.prefix}:login:${key}`]); }
}
