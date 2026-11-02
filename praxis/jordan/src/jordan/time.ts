// Jordan's clock: everything he says or checks about time is Mountain time.
//
// The servers run in UTC. Griffin, his calendar and every lead on the Western
// Slope run on America/Denver. The first build read the server's own clock
// for working hours (so "8am to 6pm" meant 2am to noon Mountain) and guessed
// daylight saving from the month. Both are replaced here by the platform's
// own timezone database through Intl, in one place, so the rule and the
// sentence Jordan writes can never disagree about what time it is.
//
// Pure. No imports. Every function takes the instant as an argument, so a
// test can stand at any moment of any year.

import type { Slot } from './types.ts';

export const JORDAN_TIMEZONE = 'America/Denver';

export interface LocalParts {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
  hour: number; // 0..23
  minute: number;
  /** 0 Sunday .. 6 Saturday */
  weekday: number;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The wall-clock reading in Mountain time for an instant. */
export function denverParts(at: Date): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: JORDAN_TIMEZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'long',
    hourCycle: 'h23',
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(at)) p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    weekday: WEEKDAYS.indexOf(p.weekday),
  };
}

/** Mountain's offset from UTC at this instant, in ms (e.g. -6h in summer). */
function denverOffsetMs(at: Date): number {
  const p = denverParts(at);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return wallAsUtc - Math.floor(at.getTime() / 60_000) * 60_000;
}

/**
 * The instant at which a Mountain wall-clock reading occurs. The offset is
 * read back from the zone itself for that date, so a slot in November after
 * the clocks change lands an hour later in UTC than the same reading in
 * October, without this file knowing when the change is.
 *
 * TWO passes. The first reads the offset at a guess (the wall reading taken
 * as UTC), which is six or seven hours away from the answer; on the two
 * clock-change days that guess can sit on the other side of the change, so
 * one pass returned the wrong hour for 2 to 7 AM on 1 Nov 2026 and 3 to 8 AM
 * on 14 Mar 2027 (a text held overnight released at 9 AM, not 8). The second
 * pass reads the offset again at the corrected instant, which is the offset
 * actually in force at the answer.
 */
export function denverInstant(year: number, month: number, day: number, hour: number, minute = 0): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const first = wall - denverOffsetMs(new Date(wall));
  return new Date(wall - denverOffsetMs(new Date(first)));
}

/** "1:30 PM" / "10 AM": the clock time the way Jordan writes it. */
export function clockLabel(at: Date): string {
  const p = denverParts(at);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const suffix = p.hour < 12 ? 'AM' : 'PM';
  return p.minute === 0 ? `${h12} ${suffix}` : `${h12}:${String(p.minute).padStart(2, '0')} ${suffix}`;
}

/** "Thursday, October 8 at 1:30 PM": a slot the way Jordan says it. */
export function slotLabel(at: Date): string {
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone: JORDAN_TIMEZONE,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(at);
  return `${date} at ${clockLabel(at)}`;
}

/** A Slot from an instant: the one place the label is derived from the time. */
export function toSlot(at: Date): Slot {
  return { startsAt: at.toISOString(), label: slotLabel(at) };
}

/**
 * Texting hours: 8am to 8pm Mountain, every day. Outside them an outbound
 * text is held, never sent and never dropped.
 */
export function withinTextingHours(at: Date = new Date()): boolean {
  const { hour } = denverParts(at);
  return hour >= 8 && hour < 20;
}

/** The next instant texting hours are open: now if open, else 8am Mountain. */
export function nextTextingOpen(at: Date = new Date()): Date {
  if (withinTextingHours(at)) return at;
  const p = denverParts(at);
  if (p.hour < 8) return denverInstant(p.year, p.month, p.day, 8);
  const tomorrow = denverParts(new Date(denverInstant(p.year, p.month, p.day, 12).getTime() + 24 * 3600_000));
  return denverInstant(tomorrow.year, tomorrow.month, tomorrow.day, 8);
}
