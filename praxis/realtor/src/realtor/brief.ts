// The before-you-call brief. Pure: no Supabase, no fetch, no model. Tested off
// disk by test/realtor-brief.test.mjs.
//
// The honesty pattern is Praxis research's (src/lib/research/profile.ts):
//
//   - CODE picks every fact and every number on the brief, from a named row,
//     and records where each number came from (the trace). A fact the book
//     does not hold reads "not known"; nothing is estimated, and there is no
//     value or equity figure anywhere (valuation is Legwork's, item 10).
//   - CODE picks the one reason to call now (today.ts, the same picker as the
//     Today list), and writes the sentence that states it.
//   - THE MODEL only words a two-sentence opener from a small evidence bundle
//     built here. validateOpener() refuses an opener with a number the bundle
//     does not hold (digits and number words), any percentage or dollar
//     figure, one that talks money or value, or one that runs long.
//
//     The digit check is research's inventedNumbers rule made stricter:
//     research asks whether the digits appear anywhere in the evidence text,
//     which lets "12%" through when the evidence says "August 12". Here each
//     number is compared as a whole number against the numbers in the
//     evidence, and a percent or a dollar sign is refused outright because
//     the evidence never holds one.
//     A refused or missing opener leaves the brief whole: it renders every
//     fact and the reason with no opener at all.

import { createHash } from 'node:crypto';
import { CHANNEL_LABELS, OUTCOME_LABELS, denverDate } from '../lead-states.ts';
import { ROLE_LABELS, SOURCE_LABELS, type ContactRole, type ContactSource } from './roles.ts';
import { priceText, type ClosingView } from './closings.ts';
import { VOID_REASON_LABELS } from './anniversary.ts';
import {
  REASON_LABELS,
  isRecording,
  nextBirthday,
  daysBetweenDates,
  type Reason,
  type TodayTouch,
} from './today.ts';

export const NOT_KNOWN = 'not known';

// ── Dates, in words ──────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parts(iso: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** "25 Sep 2024". Empty for a date that does not parse. */
export function dateText(iso: string | null | undefined): string {
  const p = parts(iso ?? '');
  return p ? `${p.d} ${MONTHS[p.m - 1]} ${p.y}` : '';
}

/** "Thu 25 Sep". */
export function dayText(iso: string | null | undefined): string {
  const p = parts(iso ?? '');
  if (!p) return '';
  const wd = new Date(Date.UTC(p.y, p.m - 1, p.d, 12)).getUTCDay();
  return `${WEEKDAYS[wd]} ${p.d} ${MONTHS[p.m - 1]}`;
}

/** "September 25", for the model's evidence: words it can say out loud. */
function spokenDate(iso: string): string {
  const p = parts(iso);
  return p ? `${MONTHS_LONG[p.m - 1]} ${p.d}` : '';
}

function yearsText(n: number): string {
  return `${n} ${n === 1 ? 'year' : 'years'}`;
}

/** Whole years from a to b (both YYYY-MM-DD), the way a birthday counts. */
export function wholeYears(from: string, to: string): number | null {
  const a = parts(from);
  const b = parts(to);
  if (!a || !b) return null;
  let y = b.y - a.y;
  if (b.m < a.m || (b.m === a.m && b.d < a.d)) y -= 1;
  return y < 0 ? null : y;
}

// ── The shapes ───────────────────────────────────────────────────────────────

/** Where one number on the brief came from. */
export interface TraceLine {
  /** Exactly as the brief prints it. */
  shown: string;
  /** What the number is, in words. */
  what: string;
  /** table.column, or a derivation over named columns. */
  from: string;
  /** The row id it was read from. */
  row: string;
  /** The row's own *_source, when it has one. */
  source: string | null;
}

export interface BriefFact {
  label: string;
  value: string;
  known: boolean;
}

export interface BriefContact {
  id: string;
  name: string;
  first_name: string | null;
  kind: string | null;
  stage: string;
  roles: readonly string[];
  source: string | null;
  birthday: string | null;
  created_at: string;
  household_name: string | null;
}

export interface BriefProperty {
  id: string;
  address: string;
  parcel_id: string | null;
  county: string | null;
}

export interface BriefInput {
  today: string;
  contact: BriefContact;
  /** Every touch on the contact, any order. */
  touches: readonly (TodayTouch & { outcome?: string | null })[];
  closings: readonly ClosingView[];
  /** The primary property, when there is one. */
  home: BriefProperty | null;
  /** Addresses by property id, for closings on other properties. */
  propertyText: Readonly<Record<string, string>>;
  /** today.ts's pick, computed by the caller from the same rows. */
  reason: Reason | null;
  /** The pitch engine's angles for this contact (pitch/contexts/contact.ts),
   * computed by the caller from the same rows. Null when the caller does not
   * run it; the brief renders whole without it. */
  pitch: import('./pitch/contexts/contact.ts').ContactPitch | null;
}

export interface BriefTouchLine {
  id: string;
  date: string;
  line: string;
}

export interface Brief {
  relationship: BriefFact[];
  touches: BriefTouchLine[];
  recording: { id: string; name: string; date: string; text: string; from: 'note' | 'plaud_summary' | null } | null;
  home: BriefFact[];
  dates: BriefFact[];
  reason: Reason | null;
  reasonLabel: string | null;
  reasonLine: string;
  /** The engine's angles for this contact, or null when none fired. */
  pitch: import('./pitch/contexts/contact.ts').ContactPitch | null;
  trace: TraceLine[];
}

// ── Reading a touch ──────────────────────────────────────────────────────────

/** The part of a recording touch a person wrote, or Plaud's own summary. */
export function recordingSummary(body: string | null | undefined): { text: string; from: 'note' | 'plaud_summary' } | null {
  const b = (body ?? '').trim();
  if (!b) return null;
  const header = b.search(/^Recording:\s/m);
  if (header > 0) {
    const note = b.slice(0, header).trim();
    if (note) return { text: note.slice(0, 600), from: 'note' };
  }
  const i = b.indexOf('--- PLAUD SUMMARY ---');
  if (i >= 0) {
    const s = b.slice(i + '--- PLAUD SUMMARY ---'.length).trim();
    if (s) return { text: s.length > 600 ? `${s.slice(0, 600).trimEnd()}…` : s, from: 'plaud_summary' };
  }
  return null;
}

function touchDate(t: { sent_at?: string | null; created_at: string }): string {
  return denverDate(t.sent_at ?? t.created_at) ?? (t.created_at ?? '').slice(0, 10);
}

/** "Call · Talked to them · asked about schools". */
export function touchLine(t: TodayTouch & { outcome?: string | null }): string {
  if (isRecording(t)) return `Recording · ${(t.subject ?? '').trim() || 'Untitled recording'}`;
  const bits = [CHANNEL_LABELS[t.channel] ?? t.channel];
  const outcome = t.outcome ? OUTCOME_LABELS[t.outcome as keyof typeof OUTCOME_LABELS] ?? t.outcome : '';
  if (outcome && !(t.channel === 'note' && t.outcome === 'note')) bits.push(outcome);
  const what = (t.subject ?? '').trim() || (t.body ?? '').trim().split('\n', 1)[0].slice(0, 120);
  if (what) bits.push(what);
  return bits.join(' · ');
}

// ── The reason, as a sentence ────────────────────────────────────────────────

/**
 * The one sentence that says why, written by code from the reason's facts.
 * Used on the Today row and on the brief, so the two never disagree.
 */
export function reasonSentence(r: Reason, address: (propertyId: string) => string): string {
  switch (r.kind) {
    case 'follow_up':
      return `Follow-up you planned for ${dayText(r.due)}${r.note ? `: ${r.note}` : '.'}`;
    case 'anniversary': {
      const where = address(r.property_id) || 'their home';
      const price = r.deed_price_cents ? `, deed price ${priceText(r.deed_price_cents)}` : '';
      return `Bought ${where} on ${dateText(r.close_date)}${price}. ${yearsText(r.years)} on ${dayText(r.date)}.`;
    }
    case 'birthday':
      return `Birthday on ${dayText(r.date)}.`;
    case 'inquiry':
      return `Came in from your website on ${dateText(denverDate(r.received) ?? r.due)}. Nobody has reached out yet.`;
    case 'recording':
      return `Recording "${r.name}" attached ${dateText(denverDate(r.attached_at) ?? r.due)} with no note on it yet.`;
    case 'quiet':
      return `Past client, last contact on file ${dateText(r.last_contact)} (${r.last_contact_from === 'closing' ? 'the closing' : 'your last touch'}), ${r.days} days ago.`;
    case 'likely_mover': {
      const why = r.top.map((t) => `${t.label.toLowerCase()} (${dateText(t.date)})`).join('; ');
      const last = r.last_contact ? `last contact ${dateText(r.last_contact)}` : 'no contact logged';
      return `Likelihood ${r.score} of 5 to buy or sell: ${why || 'see the Likelihood card'}. ${last[0].toUpperCase()}${last.slice(1)}.`;
    }
  }
}

// ── The brief ────────────────────────────────────────────────────────────────

function fact(label: string, value: string | null | undefined): BriefFact {
  const v = (value ?? '').trim();
  return { label, value: v || NOT_KNOWN, known: v !== '' };
}

/** The purchase the Home card is about: the newest closed purchase on the
 *  primary property, or failing that the newest closed purchase at all. */
function homeClosing(closings: readonly ClosingView[], home: BriefProperty | null): ClosingView | null {
  const bought = closings.filter((v) => v.closed && v.purchase);
  if (home) {
    const onHome = bought.find((v) => v.tx.property_id === home.id);
    if (onHome) return onHome;
    return null;
  }
  return bought[0] ?? null;
}

export function buildBrief(input: BriefInput): Brief {
  const { contact: c, today } = input;
  const trace: TraceLine[] = [];

  // Relationship: roles, how long she has known them, where they came from.
  const roles = c.roles.map((r) => ROLE_LABELS[r as ContactRole] ?? r).join(', ');
  const candidates: Array<{ date: string; what: string; from: string; row: string; source: string | null }> = [];
  const created = (c.created_at ?? '').slice(0, 10);
  if (created) candidates.push({ date: created, what: 'added to the book', from: 'leads.created_at', row: c.id, source: null });
  for (const t of input.touches) {
    if (t.status === 'drafted' || t.status === 'skipped') continue;
    candidates.push({ date: touchDate(t), what: 'first logged touch', from: 'lead_touches.sent_at or created_at', row: t.id, source: null });
  }
  for (const v of input.closings) {
    const d = (v.tx.contract_date ?? v.tx.close_date ?? '').slice(0, 10);
    // The contract date's own source is not read here, so a contract date is
    // traced without one rather than borrowing the close date's.
    if (d) candidates.push({ date: d, what: 'first deal on file', from: v.tx.contract_date ? 'transactions.contract_date' : 'transactions.close_date', row: v.tx.id, source: v.tx.contract_date ? null : v.tx.close_date_source ?? null });
  }
  candidates.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const first = candidates[0] ?? null;
  let since = '';
  if (first) {
    const p = parts(first.date);
    since = p ? `${MONTHS[p.m - 1]} ${p.y} (${first.what})` : '';
    if (p) trace.push({ shown: `${MONTHS[p.m - 1]} ${p.y}`, what: 'known since', from: first.from, row: first.row, source: first.source });
  }
  const relationship = [
    fact('Roles', roles),
    fact('Known since', since),
    fact('Came from', c.source ? SOURCE_LABELS[c.source as ContactSource] ?? c.source : ''),
    ...(c.household_name ? [fact('Household', c.household_name)] : []),
  ];

  // The last three touches that happened (drafts are not contacts).
  const settled = input.touches
    .filter((t) => t.status !== 'drafted' && t.status !== 'skipped')
    .sort((a, b) => Date.parse(b.sent_at ?? b.created_at) - Date.parse(a.sent_at ?? a.created_at));
  const touches: BriefTouchLine[] = settled.slice(0, 3).map((t) => {
    const date = touchDate(t);
    trace.push({ shown: dateText(date), what: 'touch date', from: t.sent_at ? 'lead_touches.sent_at' : 'lead_touches.created_at', row: t.id, source: null });
    return { id: t.id, date, line: touchLine(t) };
  });

  // The last recording and what is written on it.
  const rec = settled.find((t) => isRecording(t)) ?? null;
  let recording: Brief['recording'] = null;
  if (rec) {
    const s = recordingSummary(rec.body);
    const date = touchDate(rec);
    recording = { id: rec.id, name: (rec.subject ?? '').trim() || 'Untitled recording', date, text: s?.text ?? '', from: s?.from ?? null };
    trace.push({ shown: dateText(date), what: 'recording date', from: 'lead_touches.sent_at', row: rec.id, source: 'Plaud' });
  }

  // Home: from the deed, or "not known".
  const hc = homeClosing(input.closings, input.home);
  const homeAddress = input.home?.address ?? (hc ? input.propertyText[hc.tx.property_id] ?? '' : '');
  const boughtOn = hc ? (hc.tx.close_date ?? '').slice(0, 10) : '';
  const owned = boughtOn ? wholeYears(boughtOn, today) : null;
  const price = hc?.tx.deed_price_cents ? priceText(hc.tx.deed_price_cents) : '';
  const deedRef = hc?.tx.deed_reception_number
    ? `rec. ${hc.tx.deed_reception_number}${hc.tx.deed_reception_source ? ` (${hc.tx.deed_reception_source})` : ''}`
    : '';
  if (hc && boughtOn) trace.push({ shown: dateText(boughtOn), what: 'bought on', from: 'transactions.close_date', row: hc.tx.id, source: hc.tx.close_date_source ?? null });
  if (hc && price) trace.push({ shown: price, what: 'deed price', from: 'transactions.deed_price_cents', row: hc.tx.id, source: hc.tx.deed_price_source ?? null });
  if (hc && owned !== null) trace.push({ shown: String(owned), what: 'years owned', from: `whole years from transactions.close_date to today (${today})`, row: hc.tx.id, source: hc.tx.close_date_source ?? null });
  if (hc && hc.tx.deed_reception_number) trace.push({ shown: hc.tx.deed_reception_number, what: 'deed reception number', from: 'transactions.deed_reception_number', row: hc.tx.id, source: hc.tx.deed_reception_source ?? null });
  const home = [
    fact('Address', homeAddress),
    fact('Bought on', dateText(boughtOn)),
    fact('Deed price', price ? `${price}${hc?.tx.deed_price_source ? ` (${hc.tx.deed_price_source})` : ''}` : ''),
    fact('Years owned', owned === null ? '' : String(owned)),
    fact('Deed record', deedRef),
  ];
  if (input.home?.parcel_id) {
    home.push(fact('Parcel', input.home.parcel_id));
    trace.push({ shown: input.home.parcel_id, what: 'parcel id', from: 'properties.parcel_id', row: input.home.id, source: input.home.county });
  }

  // Dates coming up.
  const dates: BriefFact[] = [];
  const annOn = input.closings.filter((v) => v.anniversary?.on && v.anniversary.next).sort((a, b) => (a.anniversary!.next! < b.anniversary!.next! ? -1 : 1))[0];
  const annOff = input.closings.find((v) => v.anniversary && !v.anniversary.on);
  if (annOn) {
    const a = annOn.anniversary!;
    const where = input.propertyText[annOn.tx.property_id] ?? '';
    dates.push(fact('Home anniversary', `${dayText(a.next)} ${parts(a.next!)?.y ?? ''}, ${yearsText(a.years ?? 0)}${where ? ` at ${where}` : ''}`));
    trace.push({ shown: `${dayText(a.next)} ${parts(a.next!)?.y ?? ''}`, what: 'next anniversary', from: 'transactions.close_date, next occurrence on or after today', row: annOn.tx.id, source: annOn.tx.close_date_source ?? null });
    trace.push({ shown: yearsText(a.years ?? 0), what: 'anniversary years', from: 'next anniversary year minus transactions.close_date year', row: annOn.tx.id, source: annOn.tx.close_date_source ?? null });
  } else if (annOff?.anniversary?.reason) {
    dates.push({ label: 'Home anniversary', value: `None: ${VOID_REASON_LABELS[annOff.anniversary.reason].toLowerCase()}`, known: true });
  } else {
    dates.push(fact('Home anniversary', ''));
  }
  const bday = c.kind === 'person' || !c.kind ? nextBirthday(c.birthday, today) : null;
  if (bday) {
    dates.push(fact('Birthday', `${dayText(bday)} ${parts(bday)?.y ?? ''}`));
    trace.push({ shown: `${dayText(bday)} ${parts(bday)?.y ?? ''}`, what: 'next birthday', from: 'leads.birthday, next occurrence on or after today', row: c.id, source: null });
  } else {
    dates.push(fact('Birthday', ''));
  }

  // The reason, stated by code.
  const r = input.reason;
  const addr = (pid: string) => input.propertyText[pid] ?? '';
  if (r) {
    for (const t of reasonTrace(r, c.id)) trace.push(t);
  }
  // One line per number: the reason restates a few the Home card already traced.
  const seen = new Set<string>();
  const traced = trace.filter((t) => {
    const k = `${t.shown}|${t.row}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return {
    relationship,
    touches,
    recording,
    home,
    dates,
    reason: r,
    reasonLabel: r ? REASON_LABELS[r.kind] : null,
    reasonLine: r ? reasonSentence(r, addr) : 'Nothing on file says to call today.',
    pitch: input.pitch ?? null,
    trace: traced,
  };
}

/** The trace lines for the numbers a reason sentence prints. */
export function reasonTrace(r: Reason, leadId: string): TraceLine[] {
  switch (r.kind) {
    case 'follow_up':
      return [{ shown: dayText(r.due), what: 'follow-up date', from: 'leads.next_follow_up_at', row: leadId, source: null }];
    case 'anniversary':
      return [
        { shown: dateText(r.close_date), what: 'close date', from: 'transactions.close_date', row: r.tx_id, source: null },
        ...(r.deed_price_cents ? [{ shown: priceText(r.deed_price_cents), what: 'deed price', from: 'transactions.deed_price_cents', row: r.tx_id, source: r.deed_price_source }] : []),
        { shown: yearsText(r.years), what: 'anniversary years', from: 'next anniversary year minus transactions.close_date year', row: r.tx_id, source: null },
        { shown: dayText(r.date), what: 'anniversary date', from: 'transactions.close_date, next occurrence', row: r.tx_id, source: null },
      ];
    case 'birthday':
      return [{ shown: dayText(r.date), what: 'birthday', from: 'leads.birthday', row: leadId, source: null }];
    case 'inquiry':
      return [{ shown: dateText(denverDate(r.received) ?? r.due), what: 'inquiry received', from: 'leads.created_at', row: leadId, source: 'website' }];
    case 'recording':
      return [{ shown: dateText(denverDate(r.attached_at) ?? r.due), what: 'recording attached', from: 'lead_touches.created_at', row: r.touch_id, source: 'Plaud' }];
    case 'quiet':
      return [
        { shown: dateText(r.last_contact), what: 'last contact on file', from: r.last_contact_from === 'closing' ? 'transactions.close_date' : 'leads.last_touch_at', row: leadId, source: null },
        { shown: String(r.days), what: 'days since', from: `today minus ${dateText(r.last_contact)}`, row: leadId, source: null },
      ];
    case 'likely_mover':
      return [
        { shown: String(r.score), what: 'likelihood score', from: 'propensity_scores.score (src/lib/realtor/propensity/rubric.ts)', row: leadId, source: null },
        ...r.top.map((t) => ({ shown: dateText(t.date), what: t.label.toLowerCase(), from: 'propensity_signals.event_date', row: leadId, source: null })),
        ...(r.last_contact ? [{ shown: dateText(r.last_contact), what: 'last contact', from: 'leads.last_touch_at', row: leadId, source: null }] : []),
      ];
  }
}

// ── The opener: evidence, prompt, validation ─────────────────────────────────

export interface OpenerEvidence {
  /** The user message for the model. */
  user: string;
  /** The JSON the model's numbers are checked against. */
  evidenceText: string;
  /** sha256 of evidenceText: the cache key in contact_briefs. */
  hash: string;
  /** True when a pitch angle of the listing class reached the bundle: only
   * then may the opener ask for a listing (validateBriefOpener). */
  listingOffered: boolean;
}

/** Bump when OPENER_SYSTEM or validateOpener changes, so cached openers are rewritten. */
export const OPENER_VERSION = 4;

export const OPENER_SYSTEM = [
  'You write the first two sentences a real estate agent says when she calls someone in her book.',
  'Write in her voice: warm, plain, first person, no sales language, no exclamation marks, no dashes of any kind.',
  'Use ONLY the facts in the evidence. Do not mention money, prices, home values, equity, rates or the market.',
  'Never write a number, a date or a count that is not in the evidence. Say dates the way the evidence says them.',
  'Address the contact by the first name given. Do not invent family members, events, weather or anything else.',
  'Say only what the evidence says happened: a closing is the day they bought the home, not the day they moved in.',
  'When the evidence has what_she_can_offer, the second sentence may offer the first angle in her own words, from its facts only. Obey every "rule" line there exactly.',
  'Return only JSON: {"opener": "<exactly one or two sentences>"}. If the evidence gives you nothing to say, return {"error": "<why>"}.',
].join('\n');

/** The small bundle the model sees: the reason and its facts, nothing else. */
export function openerEvidence(args: {
  agentFirstName: string;
  contactFirstName: string;
  reason: Reason;
  address: (propertyId: string) => string;
  lastTouch: BriefTouchLine | null;
  today: string;
  /** The pitch engine's top angles (pitch/contexts/contact.ts), when the
   * caller ran it: their facts lines join the bundle, so the opener can offer
   * what the record says this person needs. Their "rule" lines are obeyed. */
  pitchAngles?: ReadonlyArray<{ label: string; facts: readonly string[]; rule: string | null; class?: string | null }> | null;
}): OpenerEvidence {
  const r = args.reason;
  let facts: Record<string, string | number | null>;
  switch (r.kind) {
    case 'follow_up':
      facts = { planned_for: spokenDate(r.due), what_she_wrote: r.note };
      break;
    case 'anniversary': {
      const street = (args.address(r.property_id) || '').split(',')[0] || null;
      facts = { street, anniversary_on: spokenDate(r.date), years: r.years, bought_on: `${spokenDate(r.close_date)}, ${parts(r.close_date)?.y ?? ''}` };
      break;
    }
    case 'birthday':
      facts = { birthday_on: spokenDate(r.date) };
      break;
    case 'inquiry':
      facts = { came_in_on: spokenDate(denverDate(r.received) ?? r.due), how: 'an inquiry through her website' };
      break;
    case 'recording':
      facts = { recording_name: r.name, recorded_on: spokenDate(denverDate(r.attached_at) ?? r.due) };
      break;
    case 'quiet': {
      const months = Math.floor(r.days / 30);
      facts = { last_contact_on: `${spokenDate(r.last_contact)}, ${parts(r.last_contact)?.y ?? ''}`, last_contact_was: r.last_contact_from === 'closing' ? 'their closing' : 'her last call or note', months_since: months };
      break;
    }
    case 'likely_mover':
      // The score itself is not given to the model: she does not read a number to a client.
      facts = {
        what_the_record_shows: r.top.map((t) => `${t.label}, ${spokenDate(t.date)}, ${parts(t.date)?.y ?? ''}`).join('; ') || null,
        last_contact_on: r.last_contact ? `${spokenDate(r.last_contact)}, ${parts(r.last_contact)?.y ?? ''}` : null,
      };
      break;
  }
  const bundle = {
    agent_first_name: args.agentFirstName || null,
    contact_first_name: args.contactFirstName || null,
    reason: REASON_LABELS[r.kind],
    facts,
    last_touch: args.lastTouch ? `${spokenDate(args.lastTouch.date)}: ${args.lastTouch.line}` : null,
    today: spokenDate(args.today),
    // The shared pitch engine's angles (Session 22): code picked them, and
    // the words the opener may offer come only from their facts lines.
    ...(args.pitchAngles && args.pitchAngles.length
      ? { what_she_can_offer: args.pitchAngles.map((a) => ({ angle: a.label, facts: [...a.facts], ...(a.rule ? { rule: a.rule } : {}) })) }
      : {}),
  };
  const evidenceText = JSON.stringify(bundle);
  // The prompt and the checks are part of the key: change either and every
  // cached opener is written again under the new rules.
  const hash = createHash('sha256').update(`${OPENER_VERSION}\n${r.kind}\n${evidenceText}`).digest('hex');
  const user = 'EVIDENCE (return only the JSON object described in your instructions):\n\n' + JSON.stringify(bundle, null, 2);
  return { user, evidenceText, hash, listingOffered: !!args.pitchAngles?.some((a) => a.class === 'listing') };
}

const NUMBER_WORDS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000,
  million: 1_000_000, dozen: 12,
  third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12,
};

/** "one", "a", "first" and "second" count only when they count something:
 *  "a year ago" claims 1, "your second anniversary" claims 2. */
const COUNTING = /\b(one|a|an|first|second)\s+(years?|months?|anniversary|birthday)\b/gi;

/** Every whole number written in digits in the text, as numbers. */
function numbersIn(text: string): number[] {
  return (text.replace(/(\d),(\d{3})/g, '$1$2').match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
}

/** Digits in the opener that are not a number the evidence holds. */
export function inventedDigits(text: string, evidenceText: string): string[] {
  const have = new Set(numbersIn(evidenceText));
  const out: string[] = [];
  for (const m of text.match(/\$?\d[\d,]*(?:\.\d+)?%?/g) ?? []) {
    if (m.startsWith('$') || m.endsWith('%')) {
      out.push(m);
      continue;
    }
    const n = Number(m.replace(/,/g, ''));
    if (!have.has(n)) out.push(m);
  }
  return out;
}

/** Number words the model wrote that stand for a number the evidence does not hold. */
export function inventedNumberWords(text: string, evidenceText: string): string[] {
  const nums = new Set(numbersIn(evidenceText));
  const out: string[] = [];
  for (const m of text.toLowerCase().match(/\b[a-z]+\b/g) ?? []) {
    const v = NUMBER_WORDS[m];
    if (v !== undefined && !nums.has(v)) out.push(m);
  }
  for (const m of text.matchAll(COUNTING)) {
    const w = m[1].toLowerCase();
    const unit = m[2].toLowerCase();
    // "an anniversary" or "a birthday" names the occasion, not a count.
    if ((w === 'a' || w === 'an' || w === 'one') && (unit === 'anniversary' || unit === 'birthday')) continue;
    const v = w === 'second' ? 2 : 1;
    if (!nums.has(v)) out.push(`${m[1]} ${m[2]}`);
  }
  return out;
}

const MONEY_WORDS = /\b(worth|value|values|valuation|valued|equity|apprais\w*|appreciat\w*|comps?|comparables?|price|prices|priced|pricing|rates?|mortgage|market)\b|\$/i;
const PROMISE_WORDS = /\b(guarantee\w*|promise\w*)\b/i;

export type OpenerValidation = { ok: true; opener: string } | { ok: false; error: string; declined?: boolean };

function stripFences(text: string): string {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  return s === -1 || e <= s ? t : t.slice(s, e + 1);
}

/** Accept the model's opener only if every number in it is in the evidence. */
export function validateOpener(raw: string, evidenceText: string): OpenerValidation {
  let o: unknown;
  try {
    o = JSON.parse(stripFences(raw));
  } catch {
    return { ok: false, error: 'The model did not return JSON.' };
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { ok: false, error: 'The model returned something other than an object.' };
  const rec = o as Record<string, unknown>;
  if (typeof rec.error === 'string' && rec.error.trim()) return { ok: false, error: rec.error.trim().slice(0, 300), declined: true };
  const opener = typeof rec.opener === 'string' ? rec.opener.trim().replace(/\s+/g, ' ') : '';
  if (!opener) return { ok: false, error: 'The model returned no opener.' };
  if (opener.length > 420) return { ok: false, error: 'The opener ran past two sentences.' };
  const sentences = opener.split(/(?<=[.!?])\s+(?=\S)/).filter((s) => s.trim() !== '');
  if (sentences.length > 2) return { ok: false, error: `The opener is ${sentences.length} sentences; two at most.` };
  const invented = [...inventedDigits(opener, evidenceText), ...inventedNumberWords(opener, evidenceText)];
  if (invented.length > 0) return { ok: false, error: `Numbers not in the evidence: ${invented.join(', ')}` };
  if (MONEY_WORDS.test(opener)) return { ok: false, error: 'The opener talks money or value, which the brief never does.' };
  if (PROMISE_WORDS.test(opener)) return { ok: false, error: 'The opener makes a promise.' };
  if (/[\u2012-\u2015]|\s-\s/.test(opener)) return { ok: false, error: 'The opener uses a dash; write it as plain sentences.' };
  return { ok: true, opener };
}

/** The one copy of the "asks for a listing" test, shared by this gate and the
 * pitch engine's wording gate (pitch/word.ts imports it). */
export const LISTING_ASK = /\b(list(ing)? (your|their|the|it|them)\b|to list\b|listing agent|your listings?|list with me)\b/i;

/** The brief's gate: validateOpener plus the one rule of its own. The opener
 * may not ask for a listing unless the evidence bundle offers a listing
 * angle (a pitch angle of the listing class reached what_she_can_offer). */
export function validateBriefOpener(raw: string, evidenceText: string, listingOffered: boolean): OpenerValidation {
  const v = validateOpener(raw, evidenceText);
  if (!v.ok) return v;
  if (!listingOffered && LISTING_ASK.test(v.opener)) {
    return { ok: false, error: 'The opener asks for a listing, and no angle here is a listing angle.' };
  }
  return v;
}

/** Whole days until a date, for "in 2 days" on the Today row. */
export function daysUntil(today: string, date: string): number {
  return daysBetweenDates(today, date);
}
