import type { TeacherMentorAvailabilityDto, TeacherMentorBookingDto } from '../types/domain.js';

export type StoredMentorAvailability = Omit<TeacherMentorAvailabilityDto, 'status'> & {
  status: 'open' | 'blocked' | 'cancelled';
};

export interface StoredMentorBooking extends TeacherMentorBookingDto {
  availabilityId: string;
}

export type MentorBookingUpdate = Pick<StoredMentorBooking, 'status' | 'meetingUrl' | 'startsAt' | 'endsAt'>;

export interface MentoringStore {
  listAvailability(mentorId: string): Promise<StoredMentorAvailability[]>;
  listBookings(mentorId: string): Promise<StoredMentorBooking[]>;
  createAvailability(availability: StoredMentorAvailability): Promise<'created' | 'conflict'>;
  bookAvailability(availabilityId: string, booking: StoredMentorBooking, now: Date): Promise<StoredMentorBooking | null>;
  updateBooking(mentorId: string, bookingId: string, update: MentorBookingUpdate): Promise<'updated' | 'not_found' | 'conflict'>;
}

const ACTIVE_BOOKING_STATUSES = new Set<StoredMentorBooking['status']>(['reserved', 'confirmed', 'rescheduled']);

function overlaps(left: { startsAt: string; endsAt: string }, right: { startsAt: string; endsAt: string }): boolean {
  return Date.parse(left.startsAt) < Date.parse(right.endsAt) && Date.parse(left.endsAt) > Date.parse(right.startsAt);
}

export class MemoryMentoringStore implements MentoringStore {
  private readonly availability = new Map<string, StoredMentorAvailability>();
  private readonly bookings = new Map<string, StoredMentorBooking>();

  async listAvailability(mentorId: string): Promise<StoredMentorAvailability[]> {
    return [...this.availability.values()].filter(item => item.mentorId === mentorId).map(item => structuredClone(item));
  }

  async listBookings(mentorId: string): Promise<StoredMentorBooking[]> {
    return [...this.bookings.values()].filter(item => item.mentorId === mentorId).map(item => structuredClone(item));
  }

  async createAvailability(availability: StoredMentorAvailability): Promise<'created' | 'conflict'> {
    const conflictingAvailability = [...this.availability.values()].some(item =>
      item.mentorId === availability.mentorId && item.status !== 'cancelled' && overlaps(item, availability));
    const conflictingBooking = [...this.bookings.values()].some(item =>
      item.mentorId === availability.mentorId && ACTIVE_BOOKING_STATUSES.has(item.status) && overlaps(item, availability));
    if (conflictingAvailability || conflictingBooking) return 'conflict';
    this.availability.set(availability.id, structuredClone(availability));
    return 'created';
  }

  async bookAvailability(availabilityId: string, booking: StoredMentorBooking, now: Date): Promise<StoredMentorBooking | null> {
    const availability = this.availability.get(availabilityId);
    if (!availability || availability.status !== 'open' || Date.parse(availability.startsAt) <= now.getTime()) return null;
    const conflict = [...this.bookings.values()].some(item =>
      item.mentorId === availability.mentorId && ACTIVE_BOOKING_STATUSES.has(item.status) && overlaps(item, availability));
    if (conflict) return null;
    this.bookings.set(booking.id, structuredClone(booking));
    return structuredClone(booking);
  }

  async updateBooking(mentorId: string, bookingId: string, update: MentorBookingUpdate): Promise<'updated' | 'not_found' | 'conflict'> {
    const booking = this.bookings.get(bookingId);
    if (!booking || booking.mentorId !== mentorId) return 'not_found';
    const next = { ...booking, ...update };
    const conflict = ACTIVE_BOOKING_STATUSES.has(next.status) && [...this.bookings.values()].some(item =>
      item.id !== bookingId && item.mentorId === mentorId && ACTIVE_BOOKING_STATUSES.has(item.status) && overlaps(item, next));
    if (conflict) return 'conflict';
    this.bookings.set(bookingId, structuredClone(next));
    return 'updated';
  }
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
    if (!response.ok) throw new Error(`Mentoring storage request failed (${response.status})`);
    const payload = await response.json() as RedisReply<T>;
    if (payload.error) throw new Error('Mentoring storage command failed');
    return payload.result as T;
  }
}

function parseList<T>(values: string[] | null): T[] {
  return (values ?? []).map(value => JSON.parse(value) as T);
}

const CREATE_AVAILABILITY_SCRIPT = `
local availabilityKey = KEYS[1]
local bookingsKey = KEYS[2]
local candidate = cjson.decode(ARGV[1])
for _, raw in ipairs(redis.call('HVALS', availabilityKey)) do
  local item = cjson.decode(raw)
  if item.mentorId == candidate.mentorId and item.status ~= 'cancelled' and tonumber(item.startsAtMs) < tonumber(candidate.endsAtMs) and tonumber(item.endsAtMs) > tonumber(candidate.startsAtMs) then
    return 'conflict'
  end
end
for _, raw in ipairs(redis.call('HVALS', bookingsKey)) do
  local item = cjson.decode(raw)
  if item.mentorId == candidate.mentorId and (item.status == 'reserved' or item.status == 'confirmed' or item.status == 'rescheduled') and tonumber(item.startsAtMs) < tonumber(candidate.endsAtMs) and tonumber(item.endsAtMs) > tonumber(candidate.startsAtMs) then
    return 'conflict'
  end
end
redis.call('HSET', availabilityKey, candidate.id, ARGV[1])
return 'created'`;

const BOOK_AVAILABILITY_SCRIPT = `
local availabilityKey = KEYS[1]
local bookingsKey = KEYS[2]
local availabilityRaw = redis.call('HGET', availabilityKey, ARGV[1])
if not availabilityRaw then return false end
local availability = cjson.decode(availabilityRaw)
if availability.status ~= 'open' or tonumber(availability.startsAtMs) <= tonumber(ARGV[3]) then return false end
for _, raw in ipairs(redis.call('HVALS', bookingsKey)) do
  local item = cjson.decode(raw)
  if item.mentorId == availability.mentorId and (item.status == 'reserved' or item.status == 'confirmed' or item.status == 'rescheduled') and tonumber(item.startsAtMs) < tonumber(availability.endsAtMs) and tonumber(item.endsAtMs) > tonumber(availability.startsAtMs) then
    return false
  end
end
local booking = cjson.decode(ARGV[2])
redis.call('HSET', bookingsKey, booking.id, ARGV[2])
return ARGV[2]`;

const UPDATE_BOOKING_SCRIPT = `
local bookingsKey = KEYS[1]
local currentRaw = redis.call('HGET', bookingsKey, ARGV[1])
if not currentRaw then return 'not_found' end
local current = cjson.decode(currentRaw)
if current.mentorId ~= ARGV[2] then return 'not_found' end
local candidate = cjson.decode(ARGV[3])
if candidate.status == 'reserved' or candidate.status == 'confirmed' or candidate.status == 'rescheduled' then
  local values = redis.call('HVALS', bookingsKey)
  for _, raw in ipairs(values) do
    local item = cjson.decode(raw)
    if item.id ~= candidate.id and item.mentorId == candidate.mentorId and (item.status == 'reserved' or item.status == 'confirmed' or item.status == 'rescheduled') and tonumber(item.startsAtMs) < tonumber(candidate.endsAtMs) and tonumber(item.endsAtMs) > tonumber(candidate.startsAtMs) then
      return 'conflict'
    end
  end
end
redis.call('HSET', bookingsKey, candidate.id, ARGV[3])
return 'updated'`;

type StoredAvailabilityJson = StoredMentorAvailability & { startsAtMs: number; endsAtMs: number };
type StoredBookingJson = StoredMentorBooking & { startsAtMs: number; endsAtMs: number };

function serializeAvailability(value: StoredMentorAvailability): StoredAvailabilityJson {
  return { ...value, startsAtMs: Date.parse(value.startsAt), endsAtMs: Date.parse(value.endsAt) };
}

function serializeBooking(value: StoredMentorBooking): StoredBookingJson {
  return { ...value, startsAtMs: Date.parse(value.startsAt), endsAtMs: Date.parse(value.endsAt) };
}

function stripStorageFields<T extends { startsAtMs?: number; endsAtMs?: number }>(value: T): Omit<T, 'startsAtMs' | 'endsAtMs'> {
  const { startsAtMs: _startsAtMs, endsAtMs: _endsAtMs, ...record } = value;
  return record;
}

export class RedisRestMentoringStore implements MentoringStore {
  private readonly client: RedisRestClient;
  private readonly availabilityKey: string;
  private readonly bookingsKey: string;

  constructor(url: string, token: string, prefix: string) {
    this.client = new RedisRestClient(url, token);
    this.availabilityKey = `${prefix}:availability`;
    this.bookingsKey = `${prefix}:bookings`;
  }

  async listAvailability(mentorId: string): Promise<StoredMentorAvailability[]> {
    const values = await this.client.command<string[] | null>(['HVALS', this.availabilityKey]);
    return parseList<StoredAvailabilityJson>(values)
      .filter(item => item.mentorId === mentorId)
      .map(item => stripStorageFields(item));
  }

  async listBookings(mentorId: string): Promise<StoredMentorBooking[]> {
    const values = await this.client.command<string[] | null>(['HVALS', this.bookingsKey]);
    return parseList<StoredBookingJson>(values)
      .filter(item => item.mentorId === mentorId)
      .map(item => stripStorageFields(item));
  }

  async createAvailability(availability: StoredMentorAvailability): Promise<'created' | 'conflict'> {
    return this.client.command<'created' | 'conflict'>([
      'EVAL', CREATE_AVAILABILITY_SCRIPT, 2, this.availabilityKey, this.bookingsKey, JSON.stringify(serializeAvailability(availability))
    ]);
  }

  async bookAvailability(availabilityId: string, booking: StoredMentorBooking, now: Date): Promise<StoredMentorBooking | null> {
    const raw = await this.client.command<string | null>([
      'EVAL', BOOK_AVAILABILITY_SCRIPT, 2, this.availabilityKey, this.bookingsKey,
      availabilityId, JSON.stringify(serializeBooking(booking)), now.getTime()
    ]);
    return raw ? stripStorageFields(JSON.parse(raw) as StoredBookingJson) : null;
  }

  async updateBooking(mentorId: string, bookingId: string, update: MentorBookingUpdate): Promise<'updated' | 'not_found' | 'conflict'> {
    const raw = await this.client.command<string | null>(['HGET', this.bookingsKey, bookingId]);
    if (!raw) return 'not_found';
    const current = stripStorageFields(JSON.parse(raw) as StoredBookingJson);
    if (current.mentorId !== mentorId) return 'not_found';
    const candidate: StoredMentorBooking = { ...current, ...update };
    return this.client.command<'updated' | 'not_found' | 'conflict'>([
      'EVAL', UPDATE_BOOKING_SCRIPT, 1, this.bookingsKey, bookingId, mentorId, JSON.stringify(serializeBooking(candidate))
    ]);
  }
}
