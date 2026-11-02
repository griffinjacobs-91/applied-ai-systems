// Jordan's follow-up schedule: WHEN a lead who has not answered hears from him
// next, and what kind of message it is.
//
// WHY ITS OWN FILE. Until now Jordan could only answer. The playbook's
// "Follow-up cadence" (day 0 first touch, day 3 bump, day 7 value, day 14 the
// graceful exit, one revival at day 90) lived only in prose, and nothing sent
// the first message at all. This file turns that prose into a few pure
// functions the cron tick (pipeline.ts runSequenceTick) asks every five
// minutes, so the rule and the test that holds it are the same code.
//
// THE RULES, in the order nextTouch applies them:
//   1. Do not contact, unsubscribed, handed to Griffin, booked or replied: the
//      schedule never touches them. A reply means the inbound loop owns the
//      thread from then on.
//   2. A lead is never touched after step 6 (revived once). Revival happens
//      once, ever.
//   3. A lead with no way to reach them never enters the schedule: a text
//      only with recorded consent and a phone, else email, else nothing.
//   4. Nothing goes before next_touch_at, and nothing goes outside the send
//      window: weekdays, 9 AM to 5 PM Mountain, email and text alike (a text
//      also inside texting hours). No holiday list, on purpose: weekdays only.
//   5. One message per channel per day, and never two unanswered messages on
//      the same day across channels (touchedToday, checked by the tick against
//      the stored messages).
//
// The day marks are counted from the first touch, not from the message
// before, so a bump that slipped a day does not push the whole cadence back;
// but no message ever lands on the same Mountain day as the one before it.
//
// Pure. Imports only time.ts. Every function takes the instant it is asked
// about, so a test can stand on any weekday of any year.

import { denverInstant, denverParts, slotLabel, withinTextingHours } from './time.ts';
import type { Channel } from './types.ts';

// ── The steps ───────────────────────────────────────────────────────────────

/** jordan_leads.sequence_step: how far through the schedule a lead is. */
export const STEP = {
  /** Nothing sent yet (or a "not now" with a date, waiting to start again). */
  NONE: 0,
  FIRST_TOUCH: 1,
  BUMP: 2,
  VALUE: 3,
  EXIT: 4,
  DORMANT: 5,
  /** Revived once. Never touched by the schedule again. */
  REVIVED: 6,
} as const;

/** The playbook's day marks, counted from the first touch. */
export const CADENCE_DAYS = { bump: 3, value: 7, exit: 14, revive: 90 } as const;

/** The send window, Mountain wall clock: 9:00 AM up to (not including) 5:00 PM. */
export const SEND_OPEN_HOUR = 9;
export const SEND_CLOSE_HOUR = 17;

/**
 * An admitted lead is first touched no sooner than this after intake, so the
 * research brief is written first and Griffin has a moment to take a lead
 * back out ("jordan skip") before anything goes.
 */
export const ADMIT_GRACE_MINUTES = 60;

/** Admitted after this hour on a weekday, the first touch waits for the next business morning. */
export const SAME_DAY_CUTOFF_HOUR = 15;

export type TouchKind = 'first-touch' | 'bump' | 'value' | 'exit' | 'revive';

/** The step a lead is at once this kind of message has gone out. */
export function stepAfter(kind: TouchKind): number {
  switch (kind) {
    case 'first-touch':
      return STEP.FIRST_TOUCH;
    case 'bump':
      return STEP.BUMP;
    case 'value':
      return STEP.VALUE;
    case 'exit':
      return STEP.EXIT;
    case 'revive':
      return STEP.REVIVED;
  }
}

/** The moves the cadence itself writes (the outbound moves that are not answers). */
export const CADENCE_MOVES: ReadonlySet<string> = new Set(['first-touch', 'bump', 'value']);

// ── Calendar arithmetic in Mountain days ────────────────────────────────────

interface Day {
  year: number;
  month: number;
  day: number;
}

/** The Mountain calendar day an instant falls on. */
function dayOf(at: Date): Day {
  const p = denverParts(at);
  return { year: p.year, month: p.month, day: p.day };
}

/** A calendar day plus n days (month and year roll over; no clock involved). */
function addDays(d: Day, n: number): Day {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + n));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/** 0 Sunday .. 6 Saturday, for a calendar day. */
function weekdayOf(d: Day): number {
  return new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
}

const isWeekday = (d: Day) => {
  const w = weekdayOf(d);
  return w >= 1 && w <= 5;
};

/** The day itself if it is a weekday, else the Monday after. */
function onOrAfterWeekday(d: Day): Day {
  let x = d;
  while (!isWeekday(x)) x = addDays(x, 1);
  return x;
}

/** 9:00 AM Mountain on a calendar day. */
function morning(d: Day): Date {
  return denverInstant(d.year, d.month, d.day, SEND_OPEN_HOUR);
}

/** Midnight Mountain at the start of the day this instant falls on. */
export function mountainDayStart(at: Date): Date {
  const d = dayOf(at);
  return denverInstant(d.year, d.month, d.day, 0);
}

/** 9:00 AM Mountain on the first weekday AFTER the day this instant falls on. */
export function nextBusinessMorning(at: Date): Date {
  return morning(onOrAfterWeekday(addDays(dayOf(at), 1)));
}

// ── The send window ─────────────────────────────────────────────────────────

export interface SendWindow {
  open: boolean;
  /** Now when open; otherwise the next instant the window opens. */
  opensAt: Date;
  reason: string;
}

/**
 * Whether Jordan may start or continue an unanswered thread at this instant:
 * weekdays, 9 AM to 5 PM Mountain, for email and text alike. A text must also
 * be inside texting hours (8 AM to 8 PM, time.ts), which the window already
 * sits inside; it is checked anyway so the two rules cannot drift apart.
 */
export function sendWindow(now: Date, channel: Channel = 'email'): SendWindow {
  const p = denverParts(now);
  const weekday = p.weekday >= 1 && p.weekday <= 5;
  const inHours = p.hour >= SEND_OPEN_HOUR && p.hour < SEND_CLOSE_HOUR;
  const texting = channel !== 'text' || withinTextingHours(now);
  if (weekday && inHours && texting) return { open: true, opensAt: now, reason: 'inside the send window' };
  const opensAt = weekday && p.hour < SEND_OPEN_HOUR ? morning(dayOf(now)) : nextBusinessMorning(now);
  return {
    open: false,
    opensAt,
    reason: weekday ? 'outside the send window (weekdays, 9 AM to 5 PM Mountain)' : 'the send window is weekdays only',
  };
}

/**
 * When a newly admitted lead's first message is due: later today when they
 * are admitted on a weekday before 3 PM Mountain (an hour after intake, and
 * not before 9 AM), otherwise 9 AM on the next business day.
 */
export function firstTouchAt(admittedAt: Date): Date {
  const p = denverParts(admittedAt);
  const weekday = p.weekday >= 1 && p.weekday <= 5;
  if (weekday && p.hour < SAME_DAY_CUTOFF_HOUR) {
    // Rounded up to the quarter hour, so the owner reads "2:30 PM", not "2:23 PM".
    const quarter = 15 * 60_000;
    const soon = new Date(Math.ceil((admittedAt.getTime() + ADMIT_GRACE_MINUTES * 60_000) / quarter) * quarter);
    const opens = morning(dayOf(admittedAt));
    return soon.getTime() > opens.getTime() ? soon : opens;
  }
  return nextBusinessMorning(admittedAt);
}

// ── The schedule ────────────────────────────────────────────────────────────

/** The day mark (from the first touch) of the message that follows each step. */
const NEXT_DAY_MARK: Record<number, number> = {
  [STEP.FIRST_TOUCH]: CADENCE_DAYS.bump,
  [STEP.BUMP]: CADENCE_DAYS.value,
  [STEP.VALUE]: CADENCE_DAYS.exit,
  [STEP.EXIT]: CADENCE_DAYS.revive,
  [STEP.DORMANT]: CADENCE_DAYS.revive,
};

/**
 * When the next message is due after the message for `step` went out at
 * `sentAt`: 9 AM Mountain on day 3, 7, 14 and then 90 counted from the first
 * touch, moved to the Monday when it lands on a weekend, and never on the
 * same Mountain day as the message just sent. Null after the revival (step 6)
 * and before anything was sent (step 0): nothing more is ever scheduled.
 */
export function scheduleAfter(step: number, sentAt: Date, firstTouchAt: Date = sentAt): Date | null {
  const days = NEXT_DAY_MARK[step];
  if (days === undefined) return null;
  const mark = morning(onOrAfterWeekday(addDays(dayOf(firstTouchAt), days)));
  const floor = nextBusinessMorning(sentAt);
  return mark.getTime() >= floor.getTime() ? mark : floor;
}

/** What the schedule needs to know about a lead: a subset of store.ts LeadRow. */
export interface SequenceLead {
  status: string;
  do_not_contact: boolean;
  email?: string | null;
  phone?: string | null;
  text_consent?: string | null;
  sequence_step?: number | null;
  next_touch_at?: string | null;
  sequence_channel?: Channel | null;
  revived_at?: string | null;
}

export interface NextTouch {
  action: TouchKind | 'wait' | 'none';
  /** When it is (or was) due; null for none. */
  dueAt: Date | null;
  /** Plain words, for the tick's report and for tests. */
  reason: string;
}

const ACTION_BY_STEP: Record<number, TouchKind> = {
  [STEP.NONE]: 'first-touch',
  [STEP.FIRST_TOUCH]: 'bump',
  [STEP.BUMP]: 'value',
  [STEP.VALUE]: 'exit',
  [STEP.EXIT]: 'revive',
  [STEP.DORMANT]: 'revive',
};

/** The lead statuses each kind of message may go to. Anything else is out of the schedule. */
const STATUSES_FOR: Record<TouchKind, ReadonlySet<string>> = {
  // not_now: a "not now, try me in November" coming back on its date.
  'first-touch': new Set(['new', 'researching', 'in_sequence', 'not_now']),
  bump: new Set(['new', 'in_sequence']),
  value: new Set(['new', 'in_sequence']),
  exit: new Set(['new', 'in_sequence']),
  // After the exit the lead is dormant (or not_now, once a held exit went out).
  revive: new Set(['dormant', 'not_now']),
};

/** The channel a lead is reached on, or null when there is no way to reach them. */
export function sequenceChannelFor(lead: { email?: string | null; phone?: string | null; text_consent?: string | null }): Channel | null {
  if (lead.text_consent && lead.phone) return 'text';
  if (lead.email) return 'email';
  return null;
}

/**
 * The next thing the schedule does for this lead at this instant. 'wait'
 * carries when; 'none' means the schedule is finished with them (or never
 * had them), and says why.
 */
export function nextTouch(lead: SequenceLead, now: Date): NextTouch {
  const none = (reason: string): NextTouch => ({ action: 'none', dueAt: null, reason });
  if (lead.do_not_contact || lead.status === 'unsubscribed' || lead.status === 'do_not_contact') return none('The lead asked not to be contacted.');
  if (lead.status === 'replied') return none('The lead replied; the conversation owns the thread now.');
  if (lead.status === 'booked') return none('A call is booked.');
  if (lead.status === 'escalated') return none('The conversation was handed to Griffin.');
  const step = lead.sequence_step ?? STEP.NONE;
  if (step >= STEP.REVIVED) return none('Revived once already; the schedule never writes to them again.');
  const channel = lead.sequence_channel ?? null;
  if (!channel) return none('There is no way to reach them that the schedule may use.');
  if (channel === 'text' && (!lead.phone || !lead.text_consent)) return none('A text needs a phone number and recorded consent to be texted.');
  if (channel === 'email' && !lead.email) return none('There is no email address on file.');
  if (!lead.next_touch_at) return none('Nothing is scheduled.');
  const due = new Date(lead.next_touch_at);
  if (!Number.isFinite(due.getTime())) return none('The scheduled time cannot be read.');

  const action = ACTION_BY_STEP[step];
  if (!action) return none('The step on file is not one the schedule knows.');
  if (action === 'revive' && lead.revived_at) return none('Revived once already; the schedule never writes to them again.');
  if (!STATUSES_FOR[action].has(lead.status)) return none(`A lead whose status is ${lead.status.replace(/_/g, ' ')} is not in the schedule.`);

  if (now.getTime() < due.getTime()) return { action: 'wait', dueAt: due, reason: `Not due until ${slotLabel(due)} Mountain.` };
  const window = sendWindow(now, channel);
  if (!window.open) return { action: 'wait', dueAt: window.opensAt, reason: `Due, but ${window.reason}.` };
  return { action, dueAt: due, reason: 'Due now.' };
}

/** One outbound message already written to this lead today (sent, held or being sent). */
export interface RecentTouch {
  channel: Channel;
}

/**
 * The per-day rule, read against the messages already stored for today
 * (Mountain): one message per channel per day, and never two unanswered
 * messages on the same day across channels. Null means the lead may be
 * written to; otherwise the reason it waits until tomorrow.
 */
export function touchedToday(recent: RecentTouch[], channel: Channel): string | null {
  if (recent.some((r) => r.channel === channel)) return `Jordan already wrote to them ${channel === 'text' ? 'by text' : 'by email'} today.`;
  if (recent.length > 0) return 'Jordan already wrote to them today on the other channel.';
  return null;
}

// ── "Not now, try me in November" ───────────────────────────────────────────
//
// The pipeline writes whatever deferDate returns straight into next_touch_at,
// so a wrong date is a message sent at the wrong time, on its own. The rule
// here is to read the sentence the way a person would, and to hand anything
// that is not clear back to Griffin (null) rather than guess:
//   - every date word is read where it appears in the sentence, not in
//     calendar order;
//   - a month after "not", "through", "until", "till" or "before" is a bound
//     ("slammed through November"), never the date to come back;
//   - except a month WITH a day right after "until", "till" or "through"
//     (or a numeric date there): that names the day to come back. "Out
//     until November 12" is back on the 12th; "away through Nov 3rd" (and
//     "through the 3rd of November") is back the day after, the 4th. A bare
//     month there stays a bound, and so does anything after "before" or
//     "not" alone (Session 6, defect 13: "out until November 12" used to go
//     to Griffin by hand);
//   - two different months still standing after that is a question, not an
//     answer: null;
//   - month words that are also names (Jan, June, May, April, Aug, August)
//     only count as months with a cue before them ("in June", "early May") or
//     a day or year after them ("June 12"), so "my partner Jan" and "talk to
//     June" are people;
//   - the day it lands on is never a weekend and never a fixed federal
//     holiday (New Year's Day, July 4, Christmas, or the weekday each is
//     observed on). The send window has no holiday list; this date does,
//     because it is chosen once and written down, not retried every five
//     minutes.

const MONTH_WORD =
  /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/gi;

const MONTH_BY_PREFIX: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Month words that are also first names or common verbs. */
const NAME_LIKE = new Set(['jan', 'june', 'may', 'april', 'aug', 'august']);

/** What must sit right before a name-like month word for it to be a month. */
const MONTH_CUE_BEFORE =
  /(?:\b(?:in|after|by|until|till|til|thru|through|not|before|come|early|late|next|end of|beginning of|start of|middle of)\s+|\bmid-?\s*|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?)$/i;

/** A bound, not a target: "not October", "through November", "until early May". */
const BOUND_BEFORE =
  /\b(?:not|through|thru|until|till|til|before)\s+(?:(?:in|at)\s+)?(?:(?:the\s+)?(?:end|middle|start|beginning)\s+of\s+|early\s+|late\s+|mid-?\s*)?$/i;

/** One date the text names. */
interface Reading {
  /** Where it appears in the text. */
  index: number;
  /** The month it points at (before any weekend or holiday roll), for comparing readings. */
  year: number;
  month: number;
  /** The calendar day it resolves to, already rolled to a workday. */
  at: Day;
  /** A named day ("November 12", "11/14") rather than a whole month or season. */
  exact: boolean;
}

const sameDay = (a: Day, b: Day) => a.year === b.year && a.month === b.month && a.day === b.day;

/** The weekday a fixed-date federal holiday is observed on: Friday before a Saturday, Monday after a Sunday. */
function observedOn(d: Day): Day {
  const w = weekdayOf(d);
  if (w === 6) return addDays(d, -1);
  if (w === 0) return addDays(d, 1);
  return d;
}

/** New Year's Day, Independence Day or Christmas Day, or the weekday it is observed on. */
function isFixedHoliday(d: Day): boolean {
  const fixed: Day[] = [
    { year: d.year, month: 1, day: 1 },
    { year: d.year, month: 7, day: 4 },
    { year: d.year, month: 12, day: 25 },
    { year: d.year + 1, month: 1, day: 1 }, // a Saturday New Year's is observed on Friday December 31
  ];
  return fixed.some((h) => sameDay(d, h) || sameDay(d, observedOn(h)));
}

/** The first weekday on or after this day that is not a fixed holiday. */
function onOrAfterWorkday(d: Day): Day {
  let x = d;
  while (!isWeekday(x) || isFixedHoliday(x)) x = addDays(x, 1);
  return x;
}

/** True when the words just before this index make what follows a bound, not a target. */
const isBound = (t: string, index: number) => BOUND_BEFORE.test(t.slice(Math.max(0, index - 48), index));

/** "until" / "till" / "through" right before a named day: the day to come back, not a bound. */
const UNTIL_BEFORE = /\b(?:not\s+)?(until|till|til|through|thru)\s+$/i;

/**
 * Days to add to a named day after a bound word: 0 for "until X" (back on
 * X), 1 for "through X" (back the day after X), null when the bound word is
 * not one that names a day to come back ("before", "not", "until early").
 */
function comeBackShift(t: string, index: number): number | null {
  const m = UNTIL_BEFORE.exec(t.slice(Math.max(0, index - 48), index));
  if (!m) return null;
  return /^th/i.test(m[1]) ? 1 : 0;
}

/**
 * The date a "not now" names, as the instant the schedule should come back:
 * 9 AM Mountain on the first workday of the month they named ("reach out in
 * November", "next month", "next quarter", "Q1", "after the holidays"), or on
 * the day they named ("November 12", "11/12"), rolled past weekends and fixed
 * federal holidays. Never earlier than the next workday morning. Null when no
 * date can be read, or when it is not clear which one they meant (two
 * different months, only bounds, the current month or quarter with no day):
 * Griffin keeps that one by hand.
 */
export function deferDate(text: string, now: Date): Date | null {
  const t = text.slice(0, 2_000);
  const today = dayOf(now);
  const readings: Reading[] = [];
  let ambiguous = false;

  const wholeMonth = (index: number, year: number, month: number) =>
    readings.push({ index, year, month, at: onOrAfterWorkday({ year, month, day: 1 }), exact: false });

  // A numeric date: 11/12 or 11/12/26 (US order).
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g)) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    const shift = isBound(t, m.index) ? comeBackShift(t, m.index) : 0;
    if (shift === null) continue;
    let year = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : today.year;
    if (!m[3] && (month < today.month || (month === today.month && day <= today.day))) year += 1;
    readings.push({ index: m.index, year, month, at: onOrAfterWorkday(addDays({ year, month, day }, shift)), exact: true });
  }

  for (const m of t.matchAll(/\bnext month\b/gi)) {
    if (isBound(t, m.index)) continue;
    const d = addDays({ year: today.year, month: today.month, day: 1 }, 32);
    wholeMonth(m.index, d.year, d.month);
  }

  // A quarter: "next quarter", "Q1", "Q2 2027", "first quarter". The quarter
  // they are in (or one already gone) says nothing about which part: ambiguous.
  const currentQuarter = Math.floor((today.month - 1) / 3) + 1;
  const quarter = (index: number, q: number, explicitYear: number | null) => {
    let year = explicitYear ?? today.year;
    if (explicitYear === null && q < currentQuarter) year += 1;
    if (year < today.year || (year === today.year && q <= currentQuarter)) {
      ambiguous = true;
      return;
    }
    wholeMonth(index, year, (q - 1) * 3 + 1);
  };
  for (const m of t.matchAll(/\b(?:next|following) quarter\b/gi)) {
    if (isBound(t, m.index)) continue;
    const q = (currentQuarter % 4) + 1;
    quarter(m.index, q, q === 1 ? today.year + 1 : today.year);
  }
  for (const m of t.matchAll(/\bq([1-4])\b(?:\s*(?:of\s+)?(\d{4})\b)?/gi)) {
    if (isBound(t, m.index)) continue;
    quarter(m.index, Number(m[1]), m[2] ? Number(m[2]) : null);
  }
  const ORDINAL: Record<string, number> = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4 };
  for (const m of t.matchAll(/\b(first|1st|second|2nd|third|3rd|fourth|4th)\s+quarter\b(?:\s*(?:of\s+)?(\d{4})\b)?/gi)) {
    if (isBound(t, m.index)) continue;
    quarter(m.index, ORDINAL[m[1].toLowerCase()], m[2] ? Number(m[2]) : null);
  }

  // "After the holidays" / "after the new year": the first workday on or after
  // January 2 of the coming year. Said in the first half of January the
  // holidays are behind them: the coming Monday (a week out when said on a
  // Monday), never a year later.
  for (const m of t.matchAll(/\b(?:after the holidays|(?:after|in) the new year|after new year'?s|after the first of the year)\b/gi)) {
    if (isBound(t, m.index)) continue;
    if (today.month === 1 && today.day <= 15) {
      const at = onOrAfterWorkday(addDays(today, (8 - weekdayOf(today)) % 7 || 7));
      readings.push({ index: m.index, year: at.year, month: at.month, at, exact: false });
    } else {
      const year = today.year + 1;
      readings.push({ index: m.index, year, month: 1, at: onOrAfterWorkday({ year, month: 1, day: 2 }), exact: false });
    }
  }

  for (const m of t.matchAll(/\bnext year\b/gi)) {
    if (isBound(t, m.index)) continue;
    wholeMonth(m.index, today.year + 1, 1);
  }

  // Month names, where they appear.
  for (const m of t.matchAll(MONTH_WORD)) {
    const word = m[1].toLowerCase();
    const month = MONTH_BY_PREFIX[word.slice(0, 3)];
    const before = t.slice(Math.max(0, m.index - 48), m.index);
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 24);
    const dayAfter = /^,?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4})\b)?/.exec(after);
    const yearAfter = /^,?\s+(\d{4})\b/.exec(after);
    const dayBefore = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?$/.exec(before);
    // A name ("my partner Jan", "talk to June") or the verb ("you may") is not a month.
    if (NAME_LIKE.has(word) && !MONTH_CUE_BEFORE.test(before) && !dayAfter && !yearAfter) continue;
    // After "until" or "through", a month with a day after it is the day to
    // come back; a bare month there is a bound. "Through the 3rd of
    // November" is read the same way from the words before the day.
    let shift = 0;
    if (isBound(t, m.index)) {
      const s = dayAfter ? comeBackShift(t, m.index) : null;
      if (s === null) continue;
      shift = s;
    } else if (dayBefore && !dayAfter) {
      shift = comeBackShift(before, dayBefore.index - (/\bthe\s+$/i.exec(before.slice(0, dayBefore.index))?.[0].length ?? 0)) ?? 0;
    }

    const dayNum = Number((dayAfter ?? dayBefore)?.[1] ?? NaN);
    const hasDay = Number.isFinite(dayNum) && dayNum >= 1 && dayNum <= 31;
    const explicitYear = dayAfter?.[2] ? Number(dayAfter[2]) : yearAfter ? Number(yearAfter[1]) : null;
    let year = explicitYear ?? today.year;
    if (explicitYear === null) {
      if (!hasDay && month === today.month) {
        ambiguous = true; // this month, no day
        continue;
      }
      if (month < today.month || (month === today.month && hasDay && dayNum <= today.day)) year += 1;
    }
    if (hasDay) readings.push({ index: m.index, year, month, at: onOrAfterWorkday(addDays({ year, month, day: dayNum }, shift)), exact: true });
    else wholeMonth(m.index, year, month);
  }

  if (ambiguous || readings.length === 0) return null;
  // Two different months still standing: Griffin decides.
  if (new Set(readings.map((r) => `${r.year}-${r.month}`)).size > 1) return null;
  // One month, but two different named days in it: still a question.
  const exact = readings.filter((r) => r.exact);
  if (new Set(exact.map((r) => `${r.at.year}-${r.at.month}-${r.at.day}`)).size > 1) return null;
  const chosen = exact[0] ?? readings.sort((a, b) => a.index - b.index)[0];
  const when = morning(chosen.at);
  const floor = morning(onOrAfterWorkday(addDays(today, 1)));
  return when.getTime() >= floor.getTime() ? when : floor;
}
