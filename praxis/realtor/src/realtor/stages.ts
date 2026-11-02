// The realtor edition's stage machine. Pure: no Supabase, no fetch, no clock
// beyond an injectable "today". Shaped like src/lib/lead-states.ts on purpose,
// so phase B can pick one table or the other by edition and every caller
// keeps asking the same questions (labels, which stages a button may set,
// what the record says the stage is).
//
// THE STAGES.
//
//   new            — in the book, nothing has happened with them yet.
//   nurture        — a relationship being kept warm; no deal in motion.
//   active         — showing, or getting a listing ready. A deal is moving
//                    but nothing is signed.
//   under_contract — a contract is signed and has not closed or fallen through.
//   closed         — it closed, within the last CLOSED_WINDOW_DAYS: the
//                    move-in stretch where the follow-up is about the closing.
//   past_client    — it closed longer ago than that. This is where the
//                    anniversary and the referral ask live.
//
// parked and dnc sit off to the side, as they do in the GJC edition.
//
// The one rule, carried over from lead-states.ts: a stage that has a FACT
// behind it is stamped by the fact, never by a button. under_contract,
// closed and past_client all have a row in `transactions` behind them (a
// contract date, a close date). A button that could say "under contract"
// with no contract on file would let the list disagree with the closings,
// and then neither can be read out loud. So those three are system stages,
// and `closed` becomes `past_client` by the passage of the close date, the
// same way Praxis stamps `prospect` from the intake and not from a click.

import { addDays, todayDenver } from '../lead-states.ts';

export type RealtorStage =
  | 'new'
  | 'nurture'
  | 'active'
  | 'under_contract'
  | 'closed'
  | 'past_client'
  | 'parked'
  | 'dnc';

/** Every stage, in the order the list's tabs show them. */
export const REALTOR_STAGES: readonly RealtorStage[] = [
  'new',
  'nurture',
  'active',
  'under_contract',
  'closed',
  'past_client',
  'parked',
  'dnc',
];

export const REALTOR_STAGE_LABELS: Record<RealtorStage, string> = {
  new: 'New',
  nurture: 'Nurture',
  active: 'Active',
  under_contract: 'Under contract',
  closed: 'Closed',
  past_client: 'Past client',
  parked: 'Parked',
  dnc: 'Do not contact',
};

/** What a row is stamped with when nobody said otherwise. The column default
 *  on her database is the same word (migrations-realtor/..._stages.sql). */
export const DEFAULT_REALTOR_STAGE: RealtorStage = 'new';

/** The stages a person may set by hand. The three with a transaction behind
 *  them are left out on purpose: see the header. */
export const MANUAL_REALTOR_STAGES: readonly RealtorStage[] = ['new', 'nurture', 'active', 'parked', 'dnc'];

/** Setting either of these needs a reason, as in the GJC edition. */
export const REASON_REQUIRED_STAGES: readonly RealtorStage[] = ['parked', 'dnc'];

const SYSTEM = new Set<string>(['under_contract', 'closed', 'past_client']);
const STAGE_SET = new Set<string>(REALTOR_STAGES);

export function isRealtorStage(v: unknown): v is RealtorStage {
  return typeof v === 'string' && STAGE_SET.has(v);
}

/** Stamped by a transaction, never by a button. */
export function isRealtorSystemStage(stage: string): boolean {
  return SYSTEM.has(stage);
}

/** Still hers to work. A past client is worked for years; only parked and
 *  do-not-contact are off the list. */
export function isRealtorOpen(stage: string): boolean {
  return STAGE_SET.has(stage) && stage !== 'parked' && stage !== 'dnc';
}

/**
 * How long `closed` lasts before the row reads as `past_client`. Thirty days
 * covers the move-in follow-ups (keys, utilities, the first-week call). A
 * policy number, not a fact: change it here and nowhere else.
 */
export const CLOSED_WINDOW_DAYS = 30;

/** The slice of a `transactions` row the stage machine reads. Dates are
 *  YYYY-MM-DD calendar dates, as the date columns store them. */
export interface DealFacts {
  contract_date?: string | null;
  close_date?: string | null;
  fell_through_date?: string | null;
}

function day(v: string | null | undefined): string {
  return (v ?? '').slice(0, 10);
}

/**
 * The stage the RECORD says this contact is on, or null when no transaction
 * says anything (then the stage is whatever a person last chose).
 *
 *   - a contract with no close and no fall-through, or a close date still
 *     in the future, is under_contract;
 *   - otherwise the newest close decides: within CLOSED_WINDOW_DAYS of today
 *     it is closed, after that past_client.
 *
 * A live contract outranks an old closing: a past client who is buying again
 * is under contract, not a past client.
 */
export function realtorNaturalStage(deals: readonly DealFacts[], today: string = todayDenver()): RealtorStage | null {
  let latestClose = '';
  let live = false;
  for (const d of deals) {
    if (day(d.fell_through_date)) continue;
    const close = day(d.close_date);
    if (close) {
      if (close > today) live = true; // a scheduled closing: still under contract
      else if (close > latestClose) latestClose = close;
      continue;
    }
    if (day(d.contract_date)) live = true;
  }
  if (live) return 'under_contract';
  if (!latestClose) return null;
  return addDays(latestClose, CLOSED_WINDOW_DAYS) > today ? 'closed' : 'past_client';
}

/**
 * Where a row should sit after something happened to its transactions (one
 * was added, one fell through, a close date passed). What a nightly sweep or
 * a transaction save calls; it never runs on a button's say-so alone.
 *
 *   - dnc stays dnc. It is somebody's instruction, and no record overrides it.
 *   - a live contract or a recent closing wins over everything else,
 *     including parked: entering a contract is her working the contact.
 *   - an old closing moves new, nurture, closed and under_contract rows to
 *     past_client, and leaves an active or parked row alone (a past client
 *     she is working again, or one she chose to set aside).
 *   - no transaction at all: a system stage has lost its fact (the contract
 *     fell through, or the row was deleted), so it steps back to active if it
 *     was under contract and to nurture otherwise.
 */
export function resolveRealtorStage(
  current: string,
  deals: readonly DealFacts[],
  today: string = todayDenver(),
): RealtorStage {
  const cur: RealtorStage = isRealtorStage(current) ? current : DEFAULT_REALTOR_STAGE;
  if (cur === 'dnc') return 'dnc';
  const natural = realtorNaturalStage(deals, today);
  if (natural === 'under_contract' || natural === 'closed') return natural;
  if (natural === 'past_client') {
    return cur === 'active' || cur === 'parked' ? cur : 'past_client';
  }
  if (cur === 'under_contract') return 'active';
  if (cur === 'closed' || cur === 'past_client') return 'nurture';
  return cur;
}

/**
 * The stage a hand choice actually lands on. A person may pick any manual
 * stage; the record still has the last word on the three with a fact behind
 * them.
 *
 *   - parked and dnc are always honoured (with a reason; the endpoint checks).
 *   - a live contract or a recent closing cannot be talked away by a button:
 *     mark the contract fallen through instead.
 *   - a past client may be moved to active (working with them again), but
 *     "new" or "nurture" on somebody who closed with her reads as past_client,
 *     because that is what they are.
 *
 * Returns null when the choice is not a manual stage at all, so an endpoint
 * can refuse it rather than guess.
 */
export function realtorStageForChoice(
  choice: string,
  deals: readonly DealFacts[],
  today: string = todayDenver(),
): RealtorStage | null {
  if (!MANUAL_REALTOR_STAGES.includes(choice as RealtorStage)) return null;
  if (choice === 'parked' || choice === 'dnc') return choice;
  const natural = realtorNaturalStage(deals, today);
  if (natural === 'under_contract' || natural === 'closed') return natural;
  if (natural === 'past_client' && choice !== 'active') return 'past_client';
  return choice as RealtorStage;
}

export type RealtorStageCounts = Record<RealtorStage, number> & { total: number };

/** One number per tab. A stage the table does not know is counted in the
 *  total and nowhere else, so a stray value shows up as a gap, not a lie. */
export function realtorStageCounts(rows: readonly { stage: string }[]): RealtorStageCounts {
  const counts = { total: rows.length } as RealtorStageCounts;
  for (const s of REALTOR_STAGES) counts[s] = 0;
  for (const r of rows) if (isRealtorStage(r.stage)) counts[r.stage] += 1;
  return counts;
}
