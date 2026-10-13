import { lauxlib, lua, lualib, to_jsstring, to_luastring } from 'fengari';
import type { RedisCommandClient } from '../store.js';

/**
 * In-memory Redis for tests that runs the store's real Lua scripts in a Lua VM (fengari), with
 * Redis's conversion rules between Lua values and replies. Each EVAL runs to completion before the
 * next command, exactly like Redis, so the atomicity the scripts rely on is reproduced.
 * fengari is Lua 5.3 with 32-bit integers: keep test amounts below 2^31 (Redis itself uses doubles).
 */

type Entry =
  | { type: 'string'; value: string; expiresAt: number | null }
  | { type: 'hash'; value: Map<string, string>; expiresAt: number | null }
  | { type: 'list'; value: string[]; expiresAt: number | null };

type Reply = string | number | null | Reply[] | { status: string };

class RedisError extends Error {}

export class RedisEmulator implements RedisCommandClient {
  private readonly data = new Map<string, Entry>();
  commandCount = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  async command<T>(command: Array<string | number>): Promise<T> {
    return this.exec(command.map(value => String(value))) as T;
  }

  async pipeline<T>(commands: Array<Array<string | number>>): Promise<T[]> {
    return commands.map(command => this.exec(command.map(value => String(value))) as T);
  }

  keys(): string[] { return [...this.data.keys()]; }

  /** Everything stored, as text — for asserting what never reaches storage. */
  dump(): string {
    return JSON.stringify([...this.data].map(([key, entry]) => [key, entry.type === 'hash' ? [...entry.value] : entry.value]));
  }

  private live(key: string): Entry | undefined {
    const entry = this.data.get(key);
    if (entry?.expiresAt !== null && entry?.expiresAt !== undefined && entry.expiresAt <= this.now()) { this.data.delete(key); return undefined; }
    return entry;
  }

  private hash(key: string, create: boolean): Map<string, string> | undefined {
    const entry = this.live(key);
    if (!entry) {
      if (!create) return undefined;
      const value = new Map<string, string>();
      this.data.set(key, { type: 'hash', value, expiresAt: null });
      return value;
    }
    if (entry.type !== 'hash') throw new RedisError('WRONGTYPE');
    return entry.value;
  }

  private list(key: string, create: boolean): string[] | undefined {
    const entry = this.live(key);
    if (!entry) {
      if (!create) return undefined;
      const value: string[] = [];
      this.data.set(key, { type: 'list', value, expiresAt: null });
      return value;
    }
    if (entry.type !== 'list') throw new RedisError('WRONGTYPE');
    return entry.value;
  }

  private integer(value: string | undefined): number {
    if (value === undefined || !/^-?\d+$/.test(value)) throw new RedisError('ERR value is not an integer or out of range');
    return Number(value);
  }

  private range<T>(items: T[], startRaw: string | undefined, stopRaw: string | undefined): T[] {
    const length = items.length;
    let start = this.integer(startRaw), stop = this.integer(stopRaw);
    if (start < 0) start = Math.max(0, length + start);
    if (stop < 0) stop = length + stop;
    if (start > stop || start >= length) return [];
    return items.slice(start, Math.min(stop, length - 1) + 1);
  }

  exec(args: string[]): Reply {
    this.commandCount += 1;
    const [name, ...rest] = args;
    const command = (name ?? '').toUpperCase();
    const key = rest[0] ?? '';
    switch (command) {
      case 'GET': {
        const entry = this.live(key);
        if (!entry) return null;
        if (entry.type !== 'string') throw new RedisError('WRONGTYPE');
        return entry.value;
      }
      case 'SET': {
        let expiresAt: number | null = null;
        const ex = rest.findIndex(item => item.toUpperCase() === 'EX');
        if (ex !== -1) expiresAt = this.now() + this.integer(rest[ex + 1]) * 1000;
        this.data.set(key, { type: 'string', value: rest[1] ?? '', expiresAt });
        return { status: 'OK' };
      }
      case 'DEL': return rest.reduce((count, item) => count + (this.live(item) && this.data.delete(item) ? 1 : 0), 0);
      case 'EXISTS': return rest.reduce((count, item) => count + (this.live(item) ? 1 : 0), 0);
      case 'EXPIRE': {
        const entry = this.live(key);
        if (!entry) return 0;
        entry.expiresAt = this.now() + this.integer(rest[1]) * 1000;
        return 1;
      }
      case 'INCR': {
        const entry = this.live(key);
        if (entry && entry.type !== 'string') throw new RedisError('WRONGTYPE');
        const next = this.integer(entry?.value ?? '0') + 1;
        this.data.set(key, { type: 'string', value: String(next), expiresAt: entry?.expiresAt ?? null });
        return next;
      }
      case 'HGET': return this.hash(key, false)?.get(rest[1] ?? '') ?? null;
      case 'HMGET': { const hash = this.hash(key, false); return rest.slice(1).map(field => hash?.get(field) ?? null); }
      case 'HSET': {
        const hash = this.hash(key, true)!;
        let added = 0;
        for (let index = 1; index + 1 < rest.length; index += 2) {
          if (!hash.has(rest[index]!)) added += 1;
          hash.set(rest[index]!, rest[index + 1]!);
        }
        return added;
      }
      case 'HDEL': {
        const hash = this.hash(key, false);
        const removed = rest.slice(1).reduce((count, field) => count + (hash?.delete(field) ? 1 : 0), 0);
        if (hash && !hash.size) this.data.delete(key);
        return removed;
      }
      case 'HEXISTS': return this.hash(key, false)?.has(rest[1] ?? '') ? 1 : 0;
      case 'HLEN': return this.hash(key, false)?.size ?? 0;
      case 'HGETALL': return [...(this.hash(key, false) ?? new Map<string, string>())].flat();
      case 'HINCRBY': {
        const hash = this.hash(key, true)!;
        const next = this.integer(hash.get(rest[1] ?? '') ?? '0') + this.integer(rest[2]);
        hash.set(rest[1] ?? '', String(next));
        return next;
      }
      case 'LPUSH': { const list = this.list(key, true)!; for (const value of rest.slice(1)) list.unshift(value); return list.length; }
      case 'RPUSH': { const list = this.list(key, true)!; list.push(...rest.slice(1)); return list.length; }
      case 'LRANGE': return this.range(this.list(key, false) ?? [], rest[1], rest[2]);
      case 'LTRIM': {
        const list = this.list(key, false);
        if (!list) return { status: 'OK' };
        const kept = this.range(list, rest[1], rest[2]);
        list.splice(0, list.length, ...kept);
        if (!list.length) this.data.delete(key);
        return { status: 'OK' };
      }
      case 'EVAL': return this.eval(rest[0] ?? '', this.integer(rest[1]), rest.slice(2));
      default: throw new RedisError(`ERR unknown command '${command}'`);
    }
  }

  private eval(script: string, keyCount: number, values: string[]): Reply {
    const L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(L);
    const pushStrings = (items: string[], name: string) => {
      lua.lua_createtable(L, items.length, 0);
      items.forEach((item, index) => { lua.lua_pushstring(L, to_luastring(item)); lua.lua_rawseti(L, -2, index + 1); });
      lua.lua_setglobal(L, to_luastring(name));
    };
    pushStrings(values.slice(0, keyCount), 'KEYS');
    pushStrings(values.slice(keyCount), 'ARGV');

    lua.lua_newtable(L);
    const call = (state: unknown) => {
      const count = lua.lua_gettop(state);
      const args: string[] = [];
      for (let index = 1; index <= count; index += 1) {
        if (lua.lua_type(state, index) === lua.LUA_TNUMBER) {
          // Redis turns Lua numbers into integers when they are whole, like "%.17g".
          const value = lua.lua_tonumber(state, index);
          args.push(Number.isInteger(value) ? String(value) : String(value));
        } else if (lua.lua_type(state, index) === lua.LUA_TSTRING) {
          args.push(to_jsstring(lua.lua_tostring(state, index)));
        } else {
          return lauxlib.luaL_error(state, to_luastring('Lua redis() command arguments must be strings or integers'));
        }
      }
      let reply: Reply;
      try { reply = this.exec(args); } catch (error) {
        return lauxlib.luaL_error(state, to_luastring(error instanceof Error ? error.message : 'ERR'));
      }
      this.pushReply(state, reply);
      return 1;
    };
    lua.lua_pushjsfunction(L, call);
    lua.lua_setfield(L, -2, to_luastring('call'));
    lua.lua_setglobal(L, to_luastring('redis'));

    if (lauxlib.luaL_loadstring(L, to_luastring(script)) !== lua.LUA_OK) {
      throw new RedisError(`ERR compiling script: ${to_jsstring(lua.lua_tostring(L, -1))}`);
    }
    if (lua.lua_pcall(L, 0, 1, 0) !== lua.LUA_OK) {
      throw new RedisError(`ERR running script: ${to_jsstring(lua.lua_tostring(L, -1))}`);
    }
    return this.readReply(L, -1);
  }

  private pushReply(L: unknown, reply: Reply): void {
    if (reply === null) lua.lua_pushboolean(L, false);
    // fengari integers are 32-bit; larger whole numbers go in as floats, like Redis's own doubles.
    else if (typeof reply === 'number') { if (Number.isInteger(reply) && Math.abs(reply) <= 2_147_483_647) lua.lua_pushinteger(L, reply); else lua.lua_pushnumber(L, reply); }
    else if (typeof reply === 'string') lua.lua_pushstring(L, to_luastring(reply));
    else if (Array.isArray(reply)) {
      lua.lua_createtable(L, reply.length, 0);
      reply.forEach((item, index) => { this.pushReply(L, item); lua.lua_rawseti(L, -2, index + 1); });
    } else {
      lua.lua_createtable(L, 0, 1);
      lua.lua_pushstring(L, to_luastring(reply.status));
      lua.lua_setfield(L, -2, to_luastring('ok'));
    }
  }

  private readReply(L: unknown, index: number): Reply {
    const type = lua.lua_type(L, index);
    if (type === lua.LUA_TNUMBER) return Math.trunc(lua.lua_tonumber(L, index));
    if (type === lua.LUA_TSTRING) return to_jsstring(lua.lua_tostring(L, index));
    if (type === lua.LUA_TBOOLEAN) return lua.lua_toboolean(L, index) ? 1 : null;
    if (type === lua.LUA_TTABLE) {
      const absolute = lua.lua_absindex(L, index);
      const out: Reply[] = [];
      for (let position = 1; ; position += 1) {
        lua.lua_rawgeti(L, absolute, position);
        if (lua.lua_type(L, -1) === lua.LUA_TNIL) { lua.lua_pop(L, 1); break; }
        out.push(this.readReply(L, -1));
        lua.lua_pop(L, 1);
      }
      return out;
    }
    return null;
  }
}
