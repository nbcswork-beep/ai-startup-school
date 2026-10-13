/** Calendar keys in school time (Europe/Kyiv): months for allowance renewal, days and hours for stats. */

const TIME_ZONE = 'Europe/Kyiv';

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
});

function parts(date: Date): { year: string; month: string; day: string; hour: string } {
  const values = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  return { year: values.year ?? '0000', month: values.month ?? '01', day: values.day ?? '01', hour: values.hour ?? '00' };
}

export function monthKey(date: Date): string {
  const { year, month } = parts(date);
  return `${year}-${month}`;
}

export function dayKey(date: Date): string {
  const { year, month, day } = parts(date);
  return `${year}-${month}-${day}`;
}

export function hourKey(date: Date): string {
  const { year, month, day, hour } = parts(date);
  return `${year}-${month}-${day}T${hour}`;
}

/** The last `count` school days, oldest first, ending today. */
export function recentDays(now: Date, count: number): string[] {
  const keys: string[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) keys.push(dayKey(new Date(now.getTime() - offset * 86_400_000)));
  return [...new Set(keys)];
}

/** The last `count` hours, oldest first, ending with the current hour. */
export function recentHours(now: Date, count: number): string[] {
  const keys: string[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) keys.push(hourKey(new Date(now.getTime() - offset * 3_600_000)));
  return [...new Set(keys)];
}

/** Days from `from` to `now` inclusive (school time), capped to the stats retention window. */
export function daysSince(from: Date, now: Date, cap = 400): string[] {
  const span = Math.min(cap, Math.max(1, Math.ceil((now.getTime() - from.getTime()) / 86_400_000) + 1));
  return recentDays(now, span).filter(key => key >= dayKey(from));
}
