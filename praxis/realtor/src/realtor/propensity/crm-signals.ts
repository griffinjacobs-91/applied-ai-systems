// realtor/propensity/crm-signals — what her own CRM says, as dated signals. Pure.
//
// Read from the rows the profile already reads: the contact's stage, where
// they came from, her closings with them, the touches she logged, and the
// notes on the contact. Every signal names the row it stands on.
//
//   active_file     stage is active or under contract. Dated the day it was
//                   read (the stage has no date of its own), and says so.
//   repeat_client   two or more closings with her. Dated by the newest.
//   referral_source came to her by referral (soft: alone it is "not enough").
//   recent_contact  she logged a contact in the last 12 months (soft).
//   stated_intent   one of HER notes says they plan to buy, sell or move,
//                   and the note carries a date (a logged touch's own date,
//                   or a date written in the note). An undated sentence is
//                   not a signal. A sentence that names anything in
//                   fair-housing.ts's list is never a signal either, even
//                   when it states a plan: it is counted, not scored, and
//                   its words are never copied anywhere.
//
// The signal's detail line is written here, by code ("Your note of 12 Mar
// 2026 records a plan to sell"); the note's own words are never copied into
// a signal, a score, a model prompt or a report.

import { denverDate } from '../../lead-states.ts';
import { protectedTermIn } from './fair-housing.ts';
import type { Signal } from './types.ts';

export interface CrmContact {
  id: string;
  stage: string;
  source: string | null;
  created_at: string;
  last_touch_at: string | null;
  notes: string | null;
}

export interface CrmTouch {
  id: string;
  channel: string;
  status: string;
  subject: string | null;
  body: string | null;
  created_at: string;
  sent_at?: string | null;
}

export interface CrmDeal {
  id: string;
  ours: boolean;
  close_date: string | null;
  fell_through_date: string | null;
}

export interface CrmSignalResult {
  signals: Signal[];
  /** Plan sentences left unscored because they name a protected trait. */
  refusedProtected: number;
  /** Plan sentences with no date on them. */
  undated: number;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

function iso(y: number, m: number, d: number): string | null {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** The first calendar date written in a piece of text, or null. */
export function dateInText(text: string): string | null {
  const t = text ?? '';
  let m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(t);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /\b(\d{1,2})[/.](\d{1,2})[/.](\d{4}|\d{2})\b/.exec(t);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return iso(y, +m[1], +m[2]);
  }
  m = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i.exec(t);
  if (m) return iso(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  return null;
}

const SELL = /\b(sell|selling)\b|\b(?:will|to|going to|gonna|plan to|want to|wants to) list\b|\blist(?:ing)? (?:the|their|his|her|our|my) (?:house|home|property|place|land|lot)\b/i;
const MOVE = /\b(move|moving|relocate|relocating)\b/i;
const BUY = /\b(buy|buying|purchase|purchasing|looking for|shopping for|house hunting|to build|build on|building a)\b/i;
/** A buy plan must be about a place: "looking for a hunting tag" is not one. */
const PLACE = /\b(home|homes|house|houses|property|properties|land|lots?|acres?|condo|townhome|townhouse|duplex|triplex|multi-?family|cabin|ranch|farm|place|sfh|adu|investment|rental|bed(?:room)?s?|bath(?:room)?s?|sq ?ft|square feet|garage|shop|patio home|modular|new build|commercial)\b/i;
const FUTURE = /\b(want|wants|wanting|plan|plans|planning|thinking|considering|consider|looking|going to|gonna|will|ready to|hope|hoping|may|might|soon|eventually|interested in|next (?:spring|summer|fall|winter|year|month)|this (?:spring|summer|fall|winter)|in (?:the )?(?:spring|summer|fall|winter)|in \d+ (?:months?|years?)|by (?:spring|summer|fall|winter|\d{4}))\b/i;

export type Intent = 'sell' | 'buy' | 'move';

/**
 * The plan a sentence states, or null. Needs a verb of selling, moving or
 * buying AND a word that points ahead; a buy also needs a place ("a home",
 * "land", "3 bed"). Selling is read first: someone selling to buy is a seller
 * before they are a buyer.
 */
export function intentOf(sentence: string): Intent | null {
  if (!FUTURE.test(sentence)) return null;
  if (SELL.test(sentence)) return 'sell';
  if (MOVE.test(sentence)) return 'move';
  if (BUY.test(sentence) && PLACE.test(sentence)) return 'buy';
  return null;
}

function sentences(text: string): string[] {
  return (text ?? '')
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const INTENT_WORDS: Record<Intent, string> = { sell: 'a plan to sell', buy: 'a plan to buy', move: 'a plan to move' };

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function shortDate(isoDay: string): string {
  const [y, m, d] = isoDay.split('-').map(Number);
  return `${d} ${MON[m - 1]} ${y}`;
}

/** Every dated plan in a text. `fallbackDate` is the touch's own date; a leads.notes block has none. */
export function notePlans(
  text: string | null | undefined,
  fallbackDate: string | null,
): { plans: Array<{ intent: Intent; date: string; dateFrom: 'written' | 'touch' }>; refusedProtected: number; undated: number } {
  const out = { plans: [] as Array<{ intent: Intent; date: string; dateFrom: 'written' | 'touch' }>, refusedProtected: 0, undated: 0 };
  // A dated line ("04/14/2022 - ...") dates every sentence on it.
  for (const line of (text ?? '').split(/\n+/)) {
    const lineDate = dateInText(line);
    for (const s of sentences(line)) {
      const intent = intentOf(s);
      if (!intent) continue;
      if (protectedTermIn(s)) {
        out.refusedProtected += 1;
        continue;
      }
      const written = dateInText(s) ?? lineDate;
      const date = written ?? fallbackDate;
      if (!date) {
        out.undated += 1;
        continue;
      }
      out.plans.push({ intent, date, dateFrom: written ? 'written' : 'touch' });
    }
  }
  return out;
}

function day(v: string | null | undefined): string {
  if (!v) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return denverDate(v) ?? v.slice(0, 10);
}

function monthsAgo(today: string, months: number): string {
  const [y, m, d] = today.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 - months, d));
  return t.toISOString().slice(0, 10);
}

/** Every CRM signal for one contact. `today` is the day the rows were read. */
export function crmSignals(args: {
  contact: CrmContact;
  touches: readonly CrmTouch[];
  deals: readonly CrmDeal[];
  today: string;
}): CrmSignalResult {
  const { contact: c, today } = args;
  const signals: Signal[] = [];
  let refusedProtected = 0;
  let undated = 0;

  if (c.stage === 'active' || c.stage === 'under_contract') {
    signals.push({
      kind: 'active_file',
      source: 'crm',
      date: today,
      ref: `leads.stage:${c.id}`,
      url: null,
      detail: `On file as ${c.stage === 'active' ? 'active' : 'under contract'} when read on ${shortDate(today)}.`,
    });
  }

  const closed = args.deals
    .filter((d) => d.ours && d.close_date && !d.fell_through_date && day(d.close_date) <= today)
    .map((d) => ({ id: d.id, date: day(d.close_date) }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  if (closed.length >= 2) {
    signals.push({
      kind: 'repeat_client',
      source: 'crm',
      date: closed[0].date,
      ref: `transactions:${closed.map((x) => x.id).join(',')}`,
      url: null,
      detail: `${closed.length} closings with you, the newest on ${shortDate(closed[0].date)}.`,
    });
  }

  if (c.source === 'referral') {
    signals.push({ kind: 'referral_source', source: 'crm', date: day(c.created_at), ref: `leads.source:${c.id}`, url: null, detail: 'Came to you by referral.' });
  }

  const settled = args.touches.filter((t) => t.status !== 'drafted' && t.status !== 'skipped');
  const lastTouch = [day(c.last_touch_at), ...settled.map((t) => day(t.sent_at ?? t.created_at))].filter(Boolean).sort().pop() ?? '';
  if (lastTouch && lastTouch <= today && lastTouch >= monthsAgo(today, 12)) {
    signals.push({ kind: 'recent_contact', source: 'crm', date: lastTouch, ref: `leads.last_touch_at:${c.id}`, url: null, detail: `Last contact on file ${shortDate(lastTouch)}.` });
  }

  // Plans: her logged touches first (dated by the touch), then the notes block.
  const seenPlan = new Set<string>();
  const addPlans = (text: string | null, fallback: string | null, refRow: string) => {
    const r = notePlans(text, fallback);
    refusedProtected += r.refusedProtected;
    undated += r.undated;
    for (const p of r.plans) {
      if (p.date > today) continue;
      const k = `${p.intent}|${p.date}`;
      if (seenPlan.has(k)) continue;
      seenPlan.add(k);
      signals.push({
        kind: 'stated_intent',
        source: 'crm',
        date: p.date,
        ref: refRow,
        url: null,
        detail: `Your note ${p.dateFrom === 'written' ? 'dated' : 'logged'} ${shortDate(p.date)} records ${INTENT_WORDS[p.intent]}.`,
        payload: { intent: p.intent, date_from: p.dateFrom },
      });
    }
  };
  for (const t of settled) {
    const text = [t.subject ?? '', t.body ?? ''].join('\n');
    // A recording's transcript is the other person talking at length; only
    // what she typed on it (above the Recording: header) is her note.
    const header = text.search(/^Recording:\s/m);
    addPlans(header >= 0 ? text.slice(0, header) : text, day(t.sent_at ?? t.created_at), `lead_touches:${t.id}`);
  }
  addPlans(c.notes, null, `leads.notes:${c.id}`);

  return { signals, refusedProtected, undated };
}
