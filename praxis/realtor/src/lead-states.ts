// Everything the CRM derives from a lead and its touches. Pure: no Supabase,
// no fetch, no Date-of-record beyond "now". Every function here is safe to
// call from a page, an endpoint, or a test.
//
// The rule this module exists to hold: sub-state is DERIVED, never stored.
// "Untouched / attempted / contacted" is a reading of the touch log, so it can
// never drift from what actually happened. The only thing a human stores is
// what they did, and the only thing that stamps recency is a human confirming
// a real event — there is no fabricated "last contacted".

import { edition, type Edition } from './edition.ts';
import {
  DEFAULT_REALTOR_STAGE,
  MANUAL_REALTOR_STAGES,
  REALTOR_STAGES,
  REALTOR_STAGE_LABELS,
  REASON_REQUIRED_STAGES,
  isRealtorOpen,
  isRealtorSystemStage,
} from './realtor/stages.ts';

// THE THREE STAGES, and the one rule that keeps them honest.
//
//   lead     — nobody has filled the intake. Whether they have been called
//              yet is the DERIVED sub-state (untouched / attempted /
//              contacted), not a stage. This is the sales partner's pond.
//   prospect — the intake came back. They said what they want; nothing is
//              signed. Stamped by intake-submit and by convert, never by a
//              button.
//   client   — the SOW is signed. A paying customer. Stamped by
//              mark-contract, never by a button.
//
// parked and dnc sit off to the side of all three: a lead or a prospect can
// go quiet or ask not to be contacted, and coming back out of either lands on
// whichever of the three rungs the RECORD says they are on (naturalStage).
//
// Why prospect and client are not hand-settable: both have a fact behind them
// -- an intake_submissions row, and a sow_signed_at on it. A button that could
// say "prospect" without a form having come back would let the pond disagree
// with the pipeline, and then neither number can be read out loud.
export type LeadStage = 'lead' | 'prospect' | 'client' | 'parked' | 'dnc';

export type TouchChannel = 'call' | 'email' | 'sms' | 'meeting' | 'note';

export type TouchOutcome =
  | 'no_answer'
  | 'voicemail'
  | 'talked'
  | 'meeting_set'
  | 'not_interested'
  | 'wrong_number'
  | 'sent'
  | 'note';

export type TouchStatus = 'drafted' | 'sent' | 'skipped' | 'logged';

/** The slice of a `leads` row every derivation here needs. */
export interface LeadStateInput {
  stage: string;
  last_touch_at?: string | null;
  next_follow_up_at?: string | null;
}

/** The slice of a `lead_touches` row every derivation here needs. */
export interface TouchStateInput {
  channel: string;
  outcome?: string | null;
  status: string;
  sent_at?: string | null;
  created_at: string;
}

export const STAGE_LABELS: Record<LeadStage, string> = {
  lead: 'Lead',
  prospect: 'Prospect',
  client: 'Client',
  parked: 'Parked',
  dnc: 'Do not contact',
};

/**
 * The stages a person may set by hand. Prospect and client are left out on
 * purpose: see the type above.
 */
export const MANUAL_STAGES: LeadStage[] = ['lead', 'parked', 'dnc'];

// ── The edition seam ─────────────────────────────────────────────────────────
//
// One question, "what are the stages on this deploy", answered in one place.
// GJC's answer is the constants above, untouched; the realtor edition's is
// src/lib/realtor/stages.ts. Pages and endpoints that name a stage ask
// stageVocab() instead of importing either table, so the same list, profile
// and bulk bar serve both editions without a GJC word changing.

export interface StageVocab {
  edition: Edition;
  /** Every stage, in tab order. */
  stages: readonly string[];
  labels: Readonly<Record<string, string>>;
  /** What a person may set by hand. */
  manual: readonly string[];
  /** What a row is stamped with when nobody said otherwise. */
  defaultStage: string;
  /** Where "pick it back up" lands before the record has its say. */
  reopenTo: string;
  /** Closing it off needs a reason. */
  reasonRequired: readonly string[];
  /** Stages an Undo may write back: every stage a row can legitimately be at
   *  before a mass action touched it. */
  restorable: readonly string[];
  isSystem(stage: string): boolean;
}

const GJC_VOCAB: StageVocab = {
  edition: 'gjc',
  stages: ['lead', 'prospect', 'client', 'parked', 'dnc'],
  labels: STAGE_LABELS,
  manual: MANUAL_STAGES,
  defaultStage: 'lead',
  reopenTo: 'lead',
  reasonRequired: ['parked', 'dnc'],
  restorable: MANUAL_STAGES,
  isSystem: isSystemStage,
};

// Built on first use, not at load: src/lib/realtor/stages.ts imports this file
// for its date helpers, so reading its constants while this module is still
// being evaluated would meet them uninitialised.
let realtorVocab: StageVocab | null = null;
function buildRealtorVocab(): StageVocab {
  return {
    edition: 'realtor',
    stages: REALTOR_STAGES,
    labels: REALTOR_STAGE_LABELS,
    manual: MANUAL_REALTOR_STAGES,
    defaultStage: DEFAULT_REALTOR_STAGE,
    reopenTo: 'nurture',
    reasonRequired: REASON_REQUIRED_STAGES,
    restorable: REALTOR_STAGES,
    isSystem: isRealtorSystemStage,
  };
}

/** The stage table for an edition (the running one by default). */
export function stageVocab(ed: Edition = edition()): StageVocab {
  if (ed !== 'realtor') return GJC_VOCAB;
  realtorVocab ??= buildRealtorVocab();
  return realtorVocab;
}

/** Stamped by an event, never by a button. */
export function isSystemStage(stage: string): boolean {
  return stage === 'prospect' || stage === 'client';
}

/**
 * Which of the three rungs the RECORD says this row is on, whatever stage it
 * is parked at. This is what "back to the pond" restores to, so unparking a
 * prospect never demotes them to a lead who has not filled the intake.
 */
export function naturalStage(hasSubmission: boolean, sowSigned: boolean): LeadStage {
  if (sowSigned) return 'client';
  return hasSubmission ? 'prospect' : 'lead';
}

export const OUTCOME_LABELS: Record<TouchOutcome, string> = {
  no_answer: 'No answer',
  voicemail: 'Left a voicemail',
  talked: 'Talked to them',
  meeting_set: 'Set a meeting',
  not_interested: 'Not interested',
  wrong_number: 'Wrong number',
  sent: 'Sent',
  note: 'Note',
};

/** Stages that are still ours to work. */
const OPEN_STAGES = new Set<string>(['lead', 'prospect']);

/** A drafted email or text this old is a promise nobody kept. */
export const STALE_DRAFT_DAYS = 3;

/** A prospect who has heard nothing for this long has gone quiet on us. */
export const QUIET_PROSPECT_DAYS = 14;

/** A lead we tried and did not reach, with nothing planned, waits this long. */
export const ATTEMPTED_LEAD_DAYS = 5;

/** The outcomes that mean "we tried and nobody was on the other end". */
const NO_CONTACT_OUTCOMES = new Set<string>(['no_answer', 'voicemail']);

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Today's date in Denver, as YYYY-MM-DD.
 *
 * Follow-up dates are calendar dates, not instants: "call him Tuesday" means
 * Tuesday where the sales partner is standing. Comparing a `date` column against a UTC
 * clock would show tomorrow's follow-ups as due from 6pm the night before.
 * en-CA is asked for on purpose — it formats as YYYY-MM-DD, which is what the
 * date column stores, so the comparison is a plain string compare.
 */
export function todayDenver(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Denver',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Still ours to work: lead or prospect. Converted, parked and dnc are not. */
export function isOpen(lead: LeadStateInput): boolean {
  // The realtor edition has its own open set (a past client is worked for
  // years). Its stage words never occur in GJC's database, and GJC's never in
  // a realtor's, so the branch cannot change what GJC reads.
  if (edition() === 'realtor') return isRealtorOpen(lead.stage);
  return OPEN_STAGES.has(lead.stage);
}

/** Open, and the planned follow-up date has arrived (or passed). */
export function isDue(lead: LeadStateInput, today: string = todayDenver()): boolean {
  if (!isOpen(lead)) return false;
  const due = (lead.next_follow_up_at ?? '').slice(0, 10);
  if (!due) return false;
  return due <= today;
}

function daysBetween(fromIso: string, now: Date): number | null {
  const t = Date.parse(fromIso);
  if (Number.isNaN(t)) return null;
  return Math.floor((now.getTime() - t) / DAY_MS);
}

/**
 * Whole days since the last confirmed contact, or null when there has never
 * been one. Null is rendered as "Never" — never as 0, and never as a number
 * counted from the row's creation, which would invent a contact that did not
 * happen.
 */
export function quietDays(lead: LeadStateInput, now: Date = new Date()): number | null {
  if (!lead.last_touch_at) return null;
  const d = daysBetween(lead.last_touch_at, now);
  return d === null ? null : Math.max(0, d);
}

/**
 * Nobody has ever confirmed contacting this open lead. That is the pond, not
 * a debt: 754 rows nobody has called yet is a list to work through, and
 * counting all of them as "needs contact" makes the badge mean nothing. The
 * worklist is what has gone wrong since somebody DID something.
 */
export function isUntouched(lead: LeadStateInput): boolean {
  return isOpen(lead) && !lead.last_touch_at;
}

/**
 * The worklist test. An open lead needs contact when one of four things has
 * gone unattended:
 *   - the follow-up they were promised is due, or
 *   - a draft has been sitting unsent for more than three days, or
 *   - they are a prospect who has heard nothing for two weeks, or
 *   - they are a lead we tried and did not reach, with nothing planned and
 *     five days gone by.
 *
 * An untouched lead is NOT on this list. See isUntouched().
 *
 * Touches are optional. Both arms that read them (the stale draft and the
 * last outcome) treat an empty log as "nothing to go on" rather than as
 * proof, so a caller that has only the lead row gets the follow-up and
 * prospect arms and never a false positive from the other two.
 */
export function needsContact(
  lead: LeadStateInput,
  touches?: TouchStateInput[],
  now: Date = new Date(),
): boolean {
  if (!isOpen(lead)) return false;
  const log = touches ?? [];
  if (isDue(lead, todayDenver(now))) return true;
  if (hasStaleDraft(log, now)) return true;

  const quiet = quietDays(lead, now);
  if (quiet === null) return false; // untouched: the pond, not a debt

  // A plan already on the calendar is answered by the due arm above, not by
  // the quiet arms: a prospect you agreed to call back in three weeks is not
  // owed anything today.
  if ((lead.next_follow_up_at ?? '').slice(0, 10)) return false;

  if (lead.stage === 'prospect') return quiet >= QUIET_PROSPECT_DAYS;

  // A lead, then. Only the ones we actually tried and missed.
  const last = lastOutcome(log);
  return !!last && NO_CONTACT_OUTCOMES.has(last) && quiet >= ATTEMPTED_LEAD_DAYS;
}

/** True when any drafted touch is older than STALE_DRAFT_DAYS. */
export function hasStaleDraft(touches: TouchStateInput[], now: Date = new Date()): boolean {
  return touches.some((t) => {
    if (t.status !== 'drafted') return false;
    const age = daysBetween(t.created_at, now);
    return age !== null && age > STALE_DRAFT_DAYS;
  });
}

/**
 * How far into the conversation this lead is, read off the touch log.
 *   untouched — nothing has actually happened yet (drafts do not count)
 *   attempted — we tried and did not reach anybody
 *   contacted — a human on the other end said something back
 */
export function subState(touches: TouchStateInput[]): 'untouched' | 'attempted' | 'contacted' {
  let attempted = false;
  for (const t of touches) {
    if (t.status === 'drafted' || t.status === 'skipped') continue;
    attempted = true;
    if (t.outcome === 'talked' || t.outcome === 'meeting_set') return 'contacted';
    if (t.channel === 'meeting' && t.status === 'logged') return 'contacted';
  }
  return attempted ? 'attempted' : 'untouched';
}

/**
 * The most recent settled outcome, newest first by created_at. Drafts have no
 * outcome yet, so they are skipped rather than reported as an empty one.
 */
export function lastOutcome(touches: TouchStateInput[]): TouchOutcome | null {
  const settled = touches
    .filter((t) => t.status !== 'drafted' && t.outcome)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const outcome = settled[0]?.outcome;
  return outcome ? (outcome as TouchOutcome) : null;
}

export interface PondCounts {
  total: number;
  lead: number;
  prospect: number;
  client: number;
  parked: number;
  dnc: number;
  needsContact: number;
  /** Open leads nobody has confirmed contacting yet: the pond left to fish. */
  untouched: number;
  due: number;
}

/** The counts strip at the top of the pond. */
export function pondCounts(leads: LeadStateInput[], now: Date = new Date()): PondCounts {
  const today = todayDenver(now);
  const counts: PondCounts = {
    total: leads.length,
    lead: 0,
    prospect: 0,
    client: 0,
    parked: 0,
    dnc: 0,
    needsContact: 0,
    untouched: 0,
    due: 0,
  };
  for (const lead of leads) {
    if (lead.stage in STAGE_LABELS) counts[lead.stage as LeadStage] += 1;
    if (needsContact(lead, undefined, now)) counts.needsContact += 1;
    if (isUntouched(lead)) counts.untouched += 1;
    if (isDue(lead, today)) counts.due += 1;
  }
  return counts;
}

export interface WeekActivity {
  calls: number;
  talked: number;
  meetings_set: number;
  since: string;
}

/**
 * The three numbers the sales partner reports at the Monday check-in, counted since the
 * most recent Monday in Denver. Monday, because that is when the week is
 * reported — a rolling seven days would make the same call show up in two
 * different check-ins.
 */
export function weekActivity(touches: TouchStateInput[], now: Date = new Date()): WeekActivity {
  const since = mondayDenver(now);
  let calls = 0;
  let talked = 0;
  let meetingsSet = 0;
  for (const t of touches) {
    if (t.status === 'drafted' || t.status === 'skipped') continue;
    const at = Date.parse(t.sent_at ?? t.created_at);
    if (Number.isNaN(at)) continue;
    // Compare the touch's DENVER calendar date against Monday's, rather than
    // an instant against a hardcoded offset: Denver is UTC-7 half the year and
    // UTC-6 the other half, and a fixed offset would mis-bucket the Sunday
    // night / Monday morning edge twice a year.
    if (todayDenver(new Date(at)) < since) continue;
    if (t.channel === 'call') calls += 1;
    if (t.outcome === 'talked') talked += 1;
    if (t.outcome === 'meeting_set') meetingsSet += 1;
  }
  return { calls, talked, meetings_set: meetingsSet, since };
}

/** The most recent Monday on or before today, Denver time, as YYYY-MM-DD. */
export function mondayDenver(now: Date = new Date()): string {
  const today = todayDenver(now);
  // Parse as UTC noon so the weekday of the DATE is read, not the instant.
  const asUtc = new Date(`${today}T12:00:00Z`);
  const dow = asUtc.getUTCDay(); // 0 Sun … 6 Sat
  const back = dow === 0 ? 6 : dow - 1;
  asUtc.setUTCDate(asUtc.getUTCDate() - back);
  return asUtc.toISOString().slice(0, 10);
}

/**
 * Which of the four Praxis state badges this row wears.
 *
 * The amber `current` badge is the one rule worth stating out loud: it marks
 * only the thing it is your turn to do. So it fires on needsContact and
 * nothing else — not on "is a lead", which would paint the whole pond amber
 * and mean nothing.
 */
export function stageBadgeClass(
  lead: LeadStateInput,
  touches?: TouchStateInput[],
  now: Date = new Date(),
): 'current' | 'done' | 'stuck' | 'waiting' | '' {
  if (lead.stage === 'client') return 'done';
  // Realtor: a closing is the finished thing, the way a signed SOW is here.
  if (lead.stage === 'closed' && edition() === 'realtor') return 'done';
  if (lead.stage === 'dnc') return 'stuck';
  if (lead.stage === 'parked') return 'waiting';
  if (needsContact(lead, touches, now)) return 'current';
  return '';
}

// ── The week ────────────────────────────────────────────────────────────────
//
// Everything /admin/crm/week derives, kept here for the same reason the rest
// of this file exists: the Monday check-in reads numbers out loud, and a
// number nobody can test is a number nobody should say. The loader in
// lead-data.ts fetches; aggregateWeek() decides what the rows mean.
//
// The week is Monday to Sunday in DENVER, because that is where the sales partner is
// standing and that is when the check-in happens. Every bucket compares
// Denver calendar dates, never UTC instants against a fixed offset.

/** The channel names, in the words a person would use out loud. */
export const CHANNEL_LABELS: Record<string, string> = {
  call: 'Call',
  email: 'Email',
  sms: 'Text',
  meeting: 'Meeting',
  note: 'Note',
};

/** A touch, plus the three things the week report needs beyond the state. */
export interface WeekTouchInput extends TouchStateInput {
  id: string;
  lead_id: string;
  actor_name: string | null;
  subject?: string | null;
  body?: string | null;
}

/** An admin_activity row, narrowed to what the week report reads. */
export interface WeekChangeInput {
  id: string;
  actor_name: string | null;
  action: string;
  detail: Record<string, unknown> | null;
  created_at: string;
}

/** The nine numbers reported per person at the Monday check-in. */
export interface WeekCounts {
  /** Calls made: channel call, any outcome. A no-answer is still a call. */
  calls: number;
  /** Somebody on the other end talked back: outcome talked or meeting_set. */
  conversations: number;
  meetings_set: number;
  emails_sent: number;
  texts_sent: number;
  notes: number;
  intakes: number;
  clients: number;
  added: number;
}

export interface WeekActorRow extends WeekCounts {
  actor: string;
}

export interface WeekEntry {
  id: string;
  kind: 'touch' | 'change';
  /** The instant, for sorting. */
  at: string;
  /** The Denver calendar date it belongs to, YYYY-MM-DD. */
  date: string;
  /** The Denver clock time, e.g. "2:05 PM". */
  time: string;
  actor: string;
  lead_id: string | null;
  /** Filled in by the loader, which is the only thing that can read names. */
  lead_name: string | null;
  /** The channel, or what changed. */
  what: string;
  /** The outcome in words, or '' when there is not one. */
  outcome: string;
  /** One line of what was said, at most. */
  preview: string;
}

export interface WeekDay {
  date: string;
  /** "Monday" … "Sunday". */
  label: string;
  entries: WeekEntry[];
}

export interface WeekAggregate {
  perActor: WeekActorRow[];
  totals: WeekCounts;
  /** All seven days, Monday first. The page decides which to show. */
  days: WeekDay[];
}

const WEEKDAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The Denver calendar date of an instant, or null when it is not one. */
export function denverDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return todayDenver(new Date(t));
}

/** The Denver clock time of an instant, e.g. "2:05 PM". Empty when unparseable. */
export function denverTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(t));
}

/**
 * Move a YYYY-MM-DD date by whole days.
 *
 * Parsed at UTC noon on purpose: the arithmetic is on the DATE, not on an
 * instant, so it never slips a day across a daylight-saving boundary the way
 * a local-midnight parse does.
 */
export function addDays(dateISO: string, days: number): string {
  const d = new Date(`${dateISO}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateISO;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 0 Sun … 6 Sat for a YYYY-MM-DD date, read at UTC noon like addDays. */
function weekdayOf(dateISO: string): number | null {
  const d = new Date(`${dateISO}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.getUTCDay();
}

/**
 * The follow-up date to offer when an outcome is tapped, or null when there
 * is nothing to offer.
 *
 * Only the two outcomes where nobody was on the other end propose a date:
 * a no answer is worth another try tomorrow, a voicemail deserves three days
 * before you ring again. Talked, meeting set, not interested and wrong number
 * all mean a person decided something, and the machine does not get to decide
 * the next date on top of them -- it asks.
 *
 * A proposed date that lands on a weekend rolls to the Monday. Nobody at a
 * roofing company answers the phone on Sunday, and a follow-up that comes due
 * on a day it cannot be kept shows up overdue on Monday morning for no reason.
 */
export function proposedFollowUp(outcome: TouchOutcome | string, today: string): string | null {
  const days = outcome === 'no_answer' ? 1 : outcome === 'voicemail' ? 3 : 0;
  if (days === 0) return null;
  const target = addDays(today, days);
  const dow = weekdayOf(target);
  if (dow === 6) return addDays(target, 2); // Saturday -> Monday
  if (dow === 0) return addDays(target, 1); // Sunday -> Monday
  return target;
}

/** The Monday on or before a given calendar date. */
export function mondayOf(dateISO: string): string {
  const d = new Date(`${dateISO}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateISO;
  const dow = d.getUTCDay(); // 0 Sun … 6 Sat
  d.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  return d.toISOString().slice(0, 10);
}

/**
 * Read the ?week= parameter into the Monday it names.
 *
 * Anything that is not a real YYYY-MM-DD date falls back to this week, and a
 * date mid-week is snapped back to its Monday — so a hand-edited URL lands on
 * a real week rather than on a seven-day window starting Wednesday.
 */
export function weekParam(raw: string | null | undefined, now: Date = new Date()): string {
  const v = (raw ?? '').trim();
  if (!ISO_DATE_RE.test(v)) return mondayDenver(now);
  const d = new Date(`${v}T12:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) return mondayDenver(now);
  return mondayOf(v);
}

/** The seven Denver dates of the week starting at `monday`. */
export function weekDates(mondayISO: string): string[] {
  return WEEKDAY_LABELS.map((_, i) => addDays(mondayISO, i));
}

function emptyCounts(): WeekCounts {
  return {
    calls: 0,
    conversations: 0,
    meetings_set: 0,
    emails_sent: 0,
    texts_sent: 0,
    notes: 0,
    intakes: 0,
    clients: 0,
    added: 0,
  };
}

/** Sum of every count, so a page can ask "was anything logged at all". */
export function weekTotal(counts: WeekCounts): number {
  return (
    counts.calls +
    counts.conversations +
    counts.meetings_set +
    counts.emails_sent +
    counts.texts_sent +
    counts.notes +
    counts.intakes +
    counts.clients +
    counts.added
  );
}

/** The first line of a body, collapsed and capped. Never the whole email. */
export function onePreview(text: string | null | undefined, cap = 140): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= cap) return clean;
  return `${clean.slice(0, cap - 1).trimEnd()}…`;
}

const UNKNOWN_ACTOR = 'Unknown';

function actorOf(name: string | null | undefined): string {
  return (name ?? '').trim() || UNKNOWN_ACTOR;
}

/**
 * The week's numbers and its day-by-day, per person and in total.
 *
 * Pure: the caller has already fetched, and has already decided which rows to
 * offer (settled touches, successful lead_stage / lead_convert / lead_client /
 * lead_add).
 * What this decides is which of them fall inside the Denver week and what
 * each one counts as.
 *
 * A touch is dated by sent_at when it has one — a draft written Friday and
 * marked sent on Monday happened on Monday — and by created_at otherwise.
 * Drafted and skipped rows are not contact and are dropped here as well as in
 * the query, so a caller that widens its query cannot widen the numbers.
 *
 * Follow-ups planned are deliberately NOT a number on this page. `follow_up`
 * is an action on a lead rather than a touch, and "how many follow-ups were
 * planned for this week" is not derivable from what is stored — leads carry
 * only their CURRENT next_follow_up_at, with no record of when it was set or
 * what it replaced. A number that cannot be derived is not reported.
 */
export function aggregateWeek(
  touches: WeekTouchInput[],
  changes: WeekChangeInput[],
  mondayISO: string,
): WeekAggregate {
  const dates = weekDates(mondayISO);
  const inWeek = new Set(dates);

  const byActor = new Map<string, WeekActorRow>();
  const totals = emptyCounts();
  const byDate = new Map<string, WeekEntry[]>();
  for (const d of dates) byDate.set(d, []);

  function bump(actor: string, key: keyof WeekCounts, by = 1): void {
    let row = byActor.get(actor);
    if (!row) {
      row = { actor, ...emptyCounts() };
      byActor.set(actor, row);
    }
    row[key] += by;
    totals[key] += by;
  }

  for (const t of touches) {
    if (t.status !== 'sent' && t.status !== 'logged') continue;
    const at = t.sent_at ?? t.created_at;
    const date = denverDate(at);
    if (!date || !inWeek.has(date)) continue;

    const actor = actorOf(t.actor_name);
    if (t.channel === 'call') bump(actor, 'calls');
    if (t.outcome === 'talked' || t.outcome === 'meeting_set') bump(actor, 'conversations');
    if (t.outcome === 'meeting_set') bump(actor, 'meetings_set');
    if (t.channel === 'email' && t.status === 'sent') bump(actor, 'emails_sent');
    if (t.channel === 'sms' && t.status === 'sent') bump(actor, 'texts_sent');
    if (t.channel === 'note') bump(actor, 'notes');

    byDate.get(date)!.push({
      id: `t-${t.id}`,
      kind: 'touch',
      at,
      date,
      time: denverTime(at),
      actor,
      lead_id: t.lead_id,
      lead_name: null,
      what: CHANNEL_LABELS[t.channel] ?? t.channel,
      outcome: t.outcome ? (OUTCOME_LABELS[t.outcome as TouchOutcome] ?? t.outcome) : '',
      preview: onePreview(t.body ?? t.subject ?? ''),
    });
  }

  for (const c of changes) {
    const date = denverDate(c.created_at);
    if (!date || !inWeek.has(date)) continue;

    const actor = actorOf(c.actor_name);
    const detail = c.detail ?? {};
    const to = typeof detail.to === 'string' ? detail.to : '';
    const leadId = typeof detail.lead_id === 'string' ? detail.lead_id : null;

    let what = '';
    if (c.action === 'lead_stage') {
      // Parked and do-not-contact are not numbers at the check-in, but they
      // still belong on the day: a lead taken off the board is something the
      // two of them talk about. The two rungs that ARE numbers arrive as
      // their own actions below, because both are stamped by an event.
      what = `Moved to ${stageVocab().labels[to] ?? (to || 'a new stage')}`;
    } else if (c.action === 'lead_convert') {
      // The intake came back (or the sales partner filled it out with them). That is the
      // move onto the prospect rung, and it is the number he reports.
      bump(actor, 'intakes');
      what = 'Filled out the intake';
    } else if (c.action === 'lead_client') {
      bump(actor, 'clients');
      what = 'Signed — became a client';
    } else if (c.action === 'lead_add') {
      bump(actor, 'added');
      what = 'Added by hand';
    } else {
      continue;
    }

    byDate.get(date)!.push({
      id: `a-${c.id}`,
      kind: 'change',
      at: c.created_at,
      date,
      time: denverTime(c.created_at),
      actor,
      lead_id: leadId,
      lead_name: typeof detail.business_name === 'string' ? detail.business_name : null,
      what,
      outcome: '',
      preview: '',
    });
  }

  // Newest first inside each day, the way the profile's timeline reads.
  const days: WeekDay[] = dates.map((date, i) => ({
    date,
    label: WEEKDAY_LABELS[i],
    entries: byDate.get(date)!.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
  }));

  // Busiest first, then by name, so the person who did the most is the first
  // row read out loud. Never sorted by seat or by role.
  const perActor = [...byActor.values()].sort((a, b) => {
    const d = weekTotal(b) - weekTotal(a);
    return d !== 0 ? d : a.actor.localeCompare(b.actor);
  });

  return { perActor, totals, days };
}
