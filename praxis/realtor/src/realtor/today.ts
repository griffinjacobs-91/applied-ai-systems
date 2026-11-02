// Who to call today, and why. Pure: no Supabase, no fetch, no clock beyond the
// `today` and `now` a caller passes. Tested off disk by test/realtor-today.test.mjs.
//
// THE REASONS. Each one is a fact on file that has come due, never a guess:
//
//   follow_up    a follow-up she planned has arrived (leads.next_follow_up_at).
//   anniversary  a closing of hers that still earns an anniversary falls in
//                the next ANNIVERSARY_WINDOW_DAYS (closings.ts decides which
//                closings earn one; the void rule and entities live there).
//   birthday     a birthday on file falls in the next BIRTHDAY_WINDOW_DAYS.
//                A company or a household card has no birthday.
//   inquiry      a contact who came in from her website and has no touch of
//                any kind yet (not even a draft).
//   recording    a recording attached in the last RECORDING_FRESH_HOURS with
//                nothing typed on it and no note logged after it.
//   quiet        a past client whose last contact on file (her last touch, or
//                the closing itself when she has never logged one) is
//                QUIET_PAST_CLIENT_DAYS or more ago, with nothing planned.
//   likely_mover a contact whose buy-or-sell likelihood (propensity/rubric.ts,
//                computed by code from dated signals) is a 4 or a 5, with no
//                contact logged in LIKELY_MOVER_QUIET_DAYS and nothing planned.
//                Last in REASON_ORDER: a score is read off the record, and
//                anything she planned or anything dated outranks it.
//
// ONE REASON PER ROW. A contact with three reasons is one row, and the reason
// shown is the first of REASON_ORDER that applies: a promise she made
// outranks a fact that is merely true. The list is then ordered by the due
// date of the reason shown, oldest first, so what is overdue is on top.
//
// DONE ROWS FALL OFF by the facts moving, never by a "done" flag:
//   follow_up    the follow-up date moves or clears (logging a touch does that).
//   anniversary  a note was drafted for it (its marker is on a touch), or she
//   birthday     has logged a contact since the window opened.
//   inquiry      any touch at all exists.
//   recording    a note is logged after it, or it ages past the fresh window.
//   quiet        she logs a contact, or plans a follow-up.
//   likely_mover she logs a contact, or plans a follow-up, or the score drops.
//
// Parked and do-not-contact rows are never on the list.

import { addDays, denverDate } from '../lead-states.ts';
import { isRealtorOpen } from './stages.ts';
import { isEntityName } from './anniversary.ts';
import type { ClosingView } from './closings.ts';

export type ReasonKind = 'follow_up' | 'anniversary' | 'birthday' | 'inquiry' | 'recording' | 'quiet' | 'likely_mover';

/** Which reason a row shows when several apply. */
export const REASON_ORDER: readonly ReasonKind[] = ['follow_up', 'recording', 'inquiry', 'anniversary', 'birthday', 'quiet', 'likely_mover'];

export const REASON_LABELS: Record<ReasonKind, string> = {
  follow_up: 'Follow-up due',
  anniversary: 'Home anniversary',
  birthday: 'Birthday',
  inquiry: 'Website inquiry',
  recording: 'New recording, no note',
  quiet: 'Quiet 180 days',
  likely_mover: 'Likely to buy or sell',
};

export const ANNIVERSARY_WINDOW_DAYS = 14;
export const BIRTHDAY_WINDOW_DAYS = 14;
export const QUIET_PAST_CLIENT_DAYS = 180;
export const RECORDING_FRESH_HOURS = 24;
export const LIKELY_MOVER_QUIET_DAYS = 60;

/** What a drafted anniversary or birthday note carries in template_id, so the
 *  row knows it has been done and a second press is refused. */
export const DRAFT_MARKER_PREFIX = 'realtor:';

export function anniversaryMarker(txId: string, date: string): string {
  return `${DRAFT_MARKER_PREFIX}anniversary:${txId}:${date}`;
}

export function birthdayMarker(date: string): string {
  return `${DRAFT_MARKER_PREFIX}birthday:${date}`;
}

/** The slice of a `leads` row the picker reads. */
export interface TodayContact {
  id: string;
  name: string;
  first_name: string | null;
  kind: string | null;
  stage: string;
  source: string | null;
  birthday: string | null;
  last_touch_at: string | null;
  next_follow_up_at: string | null;
  follow_up_note: string | null;
  created_at: string;
  /** The stored likelihood score (propensity_scores), when the loader read one. */
  likelihood?: TodayLikelihood | null;
  /** When an import wrote this contact (leads.found_at on a source_type 'import' row).
   *  The quiet clock starts no earlier than this: a book imported today is not
   *  285 people she has neglected for 180 days. Null for a contact added by hand. */
  imported_at?: string | null;
}

/** What the picker needs of a likelihood score: the code's number and its top signals. */
export interface TodayLikelihood {
  score: number | null;
  /** The top signals, as code wrote them: label and date. */
  top: ReadonlyArray<{ label: string; date: string }>;
  /** The one model-worded line, when one passed the checks. */
  reason: string | null;
}

/** The import stamp of a leads row: found_at when an import wrote it, else null. */
export function importedAt(row: { source_type?: string | null; found_at?: string | null }): string | null {
  return row.source_type === 'import' && row.found_at ? row.found_at : null;
}

/** The slice of a `lead_touches` row the picker reads. */
export interface TodayTouch {
  id: string;
  channel: string;
  status: string;
  template_id: string | null;
  subject: string | null;
  body: string | null;
  created_at: string;
  sent_at?: string | null;
}

interface ReasonBase {
  kind: ReasonKind;
  /** YYYY-MM-DD: when this came due (or comes due, for a date ahead). */
  due: string;
}

export type Reason =
  | (ReasonBase & { kind: 'follow_up'; note: string | null })
  | (ReasonBase & {
      kind: 'anniversary';
      tx_id: string;
      property_id: string;
      /** The anniversary itself, YYYY-MM-DD. */
      date: string;
      years: number;
      close_date: string;
      deed_price_cents: number | null;
      deed_price_source: string | null;
      /** The window opened on this day; a contact logged since counts as done. */
      window_start: string;
    })
  | (ReasonBase & { kind: 'birthday'; date: string; window_start: string })
  | (ReasonBase & { kind: 'inquiry'; received: string })
  | (ReasonBase & { kind: 'recording'; touch_id: string; name: string; attached_at: string })
  | (ReasonBase & {
      kind: 'quiet';
      /** YYYY-MM-DD of the last contact on file. */
      last_contact: string;
      last_contact_from: 'touch' | 'closing';
      days: number;
    })
  | (ReasonBase & {
      kind: 'likely_mover';
      score: number;
      /** The top signals, labels and dates as code wrote them. */
      top: ReadonlyArray<{ label: string; date: string }>;
      /** YYYY-MM-DD of her last logged contact, or null for never. */
      last_contact: string | null;
      /** Days since that contact, or null for never. */
      days: number | null;
    });

function day(v: string | null | undefined): string {
  return (v ?? '').slice(0, 10);
}

/** The Denver calendar day of a timestamp (a date column passes through). */
function localDay(v: string | null | undefined): string {
  if (!v) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return denverDate(v) ?? day(v);
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

function daysFrom(a: string, b: string): number {
  // Whole calendar days from a to b, both YYYY-MM-DD.
  return Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) -
    Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86_400_000);
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** The next birthday on or after today, YYYY-MM-DD. A Feb 29 birthday is kept
 *  on Feb 28 in a common year. Null when the stored date does not parse. */
export function nextBirthday(birthday: string | null | undefined, today: string): string | null {
  const m = ISO.exec(day(birthday));
  if (!m) return null;
  const [mo, d] = [Number(m[2]), Number(m[3])];
  const ty = Number(today.slice(0, 4));
  for (const y of [ty, ty + 1]) {
    const dd = mo === 2 && d === 29 && !isLeap(y) ? 28 : d;
    const date = `${y}-${String(mo).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    if (date >= today) return date;
  }
  return null;
}

/** A recording touch Praxis attached (lead-recordings.ts marks them `plaud:`). */
export function isRecording(t: Pick<TodayTouch, 'template_id'>): boolean {
  return typeof t.template_id === 'string' && t.template_id.startsWith('plaud:');
}

/**
 * Did anybody type a note on this recording? The attach endpoint writes what
 * the operator typed first and then the transcript, which always opens with
 * buildIngestText's `Recording:` header line. So a body that starts with that
 * header has nothing typed above it.
 */
export function recordingHasNote(body: string | null | undefined): boolean {
  const first = (body ?? '').trimStart().split('\n', 1)[0] ?? '';
  if (first === '') return false;
  return !/^Recording:\s/.test(first);
}

/** A company, trust or builder: never an anniversary, never a birthday. */
export function isEntityContact(c: Pick<TodayContact, 'kind' | 'name'>): boolean {
  return c.kind === 'entity' || isEntityName(c.name);
}

export interface ReasonContext {
  /** YYYY-MM-DD in Denver. */
  today: string;
  /** The instant, for the recording's fresh window. */
  now: Date;
}

/** Every reason on file for one contact, in REASON_ORDER. Empty for parked,
 *  do-not-contact, or a contact with nothing due. */
export function reasonsFor(
  c: TodayContact,
  touches: readonly TodayTouch[],
  closings: readonly ClosingView[],
  ctx: ReasonContext,
): Reason[] {
  if (!isRealtorOpen(c.stage)) return [];
  const { today, now } = ctx;
  const out: Reason[] = [];
  const lastTouch = localDay(c.last_touch_at);
  const planned = day(c.next_follow_up_at);
  const markers = new Set(touches.map((t) => t.template_id ?? '').filter((m) => m.startsWith(DRAFT_MARKER_PREFIX)));
  const entity = isEntityContact(c);

  // follow_up
  if (planned && planned <= today) out.push({ kind: 'follow_up', due: planned, note: (c.follow_up_note ?? '').trim() || null });

  // recording: the newest fresh, note-less one with no note logged after it.
  const freshFrom = now.getTime() - RECORDING_FRESH_HOURS * 3_600_000;
  const recs = touches
    .filter((t) => isRecording(t) && Date.parse(t.created_at) >= freshFrom && !recordingHasNote(t.body))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  for (const r of recs) {
    const noted = touches.some((t) => t.channel === 'note' && t.status !== 'drafted' && Date.parse(t.created_at) > Date.parse(r.created_at));
    if (noted) continue;
    out.push({
      kind: 'recording',
      due: localDay(r.created_at),
      touch_id: r.id,
      name: (r.subject ?? '').trim() || 'Untitled recording',
      attached_at: r.created_at,
    });
    break;
  }

  // inquiry
  if (c.source === 'website' && touches.length === 0 && !lastTouch) {
    out.push({ kind: 'inquiry', due: localDay(c.created_at), received: c.created_at });
  }

  // anniversary: the soonest one inside the window that has not been handled.
  if (!entity) {
    const ann = closings
      .filter((v) => v.anniversary?.on && v.anniversary.next)
      .map((v) => ({ v, date: v.anniversary!.next! }))
      .filter(({ date }) => date >= today && daysFrom(today, date) <= ANNIVERSARY_WINDOW_DAYS)
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    for (const { v, date } of ann) {
      const windowStart = addDays(date, -ANNIVERSARY_WINDOW_DAYS);
      if (markers.has(anniversaryMarker(v.tx.id, date))) continue;
      if (lastTouch && lastTouch >= windowStart) continue;
      out.push({
        kind: 'anniversary',
        due: date,
        tx_id: v.tx.id,
        property_id: v.tx.property_id,
        date,
        years: v.anniversary!.years ?? 0,
        close_date: day(v.tx.close_date),
        deed_price_cents: v.tx.deed_price_cents,
        deed_price_source: v.tx.deed_price_source ?? null,
        window_start: windowStart,
      });
      break;
    }
  }

  // birthday: a person only.
  if (!entity && (c.kind ?? 'person') === 'person') {
    const date = nextBirthday(c.birthday, today);
    if (date && daysFrom(today, date) <= BIRTHDAY_WINDOW_DAYS) {
      const windowStart = addDays(date, -BIRTHDAY_WINDOW_DAYS);
      if (!markers.has(birthdayMarker(date)) && !(lastTouch && lastTouch >= windowStart)) {
        out.push({ kind: 'birthday', due: date, date, window_start: windowStart });
      }
    }
  }

  // quiet past client: a plan on the calendar silences it, as in Praxis.
  if (c.stage === 'past_client' && !planned) {
    const lastClose = closings
      .filter((v) => v.closed)
      .map((v) => day(v.tx.close_date))
      .sort()
      .pop() ?? '';
    const from: 'touch' | 'closing' | null = lastTouch && lastTouch >= lastClose ? 'touch' : lastClose ? 'closing' : null;
    const last = from === 'touch' ? lastTouch : from === 'closing' ? lastClose : '';
    // An imported contact's quiet clock starts at the import at the earliest.
    const imported = localDay(c.imported_at ?? null);
    const clockFrom = imported && imported > last ? imported : last;
    if (from && last) {
      const days = daysFrom(last, today);
      if (days >= QUIET_PAST_CLIENT_DAYS && daysFrom(clockFrom, today) >= QUIET_PAST_CLIENT_DAYS) {
        out.push({ kind: 'quiet', due: addDays(last, QUIET_PAST_CLIENT_DAYS), last_contact: last, last_contact_from: from, days });
      }
    }
  }

  // likely mover: a 4 or 5 by the rubric, nobody talked to in 60 days, nothing planned.
  const lk = c.likelihood;
  if (lk && typeof lk.score === 'number' && lk.score >= 4 && !planned) {
    const days = lastTouch ? daysFrom(lastTouch, today) : null;
    if (days === null || days >= LIKELY_MOVER_QUIET_DAYS) {
      out.push({
        kind: 'likely_mover',
        due: lastTouch ? addDays(lastTouch, LIKELY_MOVER_QUIET_DAYS) : localDay(c.created_at) || today,
        score: lk.score,
        top: lk.top.slice(0, 3),
        last_contact: lastTouch || null,
        days,
      });
    }
  }

  return out.sort((a, b) => REASON_ORDER.indexOf(a.kind) - REASON_ORDER.indexOf(b.kind));
}

/** The one reason a row shows, or null. */
export function pickReason(reasons: readonly Reason[]): Reason | null {
  let best: Reason | null = null;
  for (const r of reasons) {
    if (!best || REASON_ORDER.indexOf(r.kind) < REASON_ORDER.indexOf(best.kind)) best = r;
  }
  return best;
}

export interface TodayRow {
  contact: TodayContact;
  reason: Reason;
  /** How many other reasons this contact also has today. */
  more: number;
}

/** The Today list: one row per contact with a reason, oldest due first. */
export function todayRows(
  items: ReadonlyArray<{ contact: TodayContact; touches: readonly TodayTouch[]; closings: readonly ClosingView[] }>,
  ctx: ReasonContext,
): TodayRow[] {
  const rows: TodayRow[] = [];
  for (const it of items) {
    const all = reasonsFor(it.contact, it.touches, it.closings, ctx);
    const reason = pickReason(all);
    if (reason) rows.push({ contact: it.contact, reason, more: all.length - 1 });
  }
  return rows.sort((a, b) => {
    if (a.reason.due !== b.reason.due) return a.reason.due < b.reason.due ? -1 : 1;
    const k = REASON_ORDER.indexOf(a.reason.kind) - REASON_ORDER.indexOf(b.reason.kind);
    return k !== 0 ? k : a.contact.name.localeCompare(b.contact.name);
  });
}

/** Counts per reason kind, for the page's summary line. */
export function reasonCounts(rows: readonly TodayRow[]): Record<ReasonKind, number> {
  const out = { follow_up: 0, anniversary: 0, birthday: 0, inquiry: 0, recording: 0, quiet: 0, likely_mover: 0 } as Record<ReasonKind, number>;
  for (const r of rows) out[r.reason.kind] += 1;
  return out;
}

/** Whole calendar days between two YYYY-MM-DD dates (b minus a). */
export function daysBetweenDates(a: string, b: string): number {
  return daysFrom(a, b);
}
