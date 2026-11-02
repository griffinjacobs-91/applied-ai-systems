// realtor/pitch/contexts/contact — the pitch for anyone already in her book.
//
// Session 22: the shared engine (engine.ts) applied to the rest of the CRM,
// ledger item 63. One adapter, four contexts, one facts record:
//
//   contact   every contact (the profile, the People preview, the brief)
//   pipeline  a contact with an open file from her pipeline (an open,
//             listed, under-contract or ended transaction on the record)
//   partner   a contact who is the trade itself: lender, title, inspector,
//             appraiser, contractor
//   inquiry   a contact who wrote through her website
//
// FACTS (each from a named column; a fact the record does not hold is null,
// and a rule that needs it refuses to fire and says so):
//
//   stage            leads.stage
//   kind             leads.kind ('person' | 'company' ...)
//   source           leads.source ('website' is the inquiry door)
//   roles            contact roles (roles.ts keys)
//   closings_ours    transactions closed with her (ours, closed, not void)
//   last_close       the newest of those close dates, in words (+ row id)
//   pipeline_status  'under_contract' | 'listed' | 'ended' | 'open' | null
//   tx_side          'buy' | 'sell' | null
//   tx_date          the date the status hangs off, in words
//   likelihood       the stored buy-or-sell score (propensity), 1 to 5
//   has_touch        any touch of any kind on file
//
// RULES (id, weight, class):
//
//   answer_fast          95  reach     a website inquiry no one has answered
//   under_contract_care  90  reach     a file under contract
//   partner_loop         85  referral  the trade itself: referrals both ways
//   past_client_reach    80  reach     a past client: the house and referrals
//   relist_ask           75  listing   a file that ended without a closing
//   listing_check_in     70  reach     their home is on the market
//   qualify_prospect     60  question  an open file with no contract yet
//   likely_mover_ask     50  question  a dated likelihood of 4 or 5
//
// BLOCKS: a do-not-contact card gets no angle at all (the engine is handed
// every class to block). A listing angle is never blocked here on facts
// alone: only relist_ask is a listing ask, and it fires only on an ended
// file.
//
// Pure: no I/O, no model. The one wording step stays word.ts, called by the
// brief's own opener flow (the angles join its evidence bundle, brief.ts).

import { dateText } from '../../brief.ts';
import { evaluate, topAngles, type Angle, type AngleClass, type Evaluation } from '../engine.ts';
import { defineRule } from '../engine.ts';

export type PitchContext = 'contact' | 'pipeline' | 'partner' | 'inquiry';

/** The roles that make a contact the trade itself (roles.ts keys). */
export const PARTNER_ROLES: readonly string[] = ['lender', 'title', 'inspector', 'appraiser', 'contractor'];

/** What a transaction row looks like to this adapter. */
export interface PitchTransaction {
  id: string;
  ours: boolean;
  side: string | null;
  listed_date: string | null;
  contract_date: string | null;
  close_date: string | null;
  fell_through_date: string | null;
}

/** What a closing looks like to this adapter (closings.ts ClosingView, or less). */
export interface PitchClosing {
  closed: boolean;
  ours: boolean;
  purchase: boolean;
  close_date: string | null;
}

export interface ContactFacts {
  [k: string]: unknown;
  stage: string;
  kind: string | null;
  source: string | null;
  roles: readonly string[];
  closings_ours: number;
  last_close: string | null;
  last_close_id: string | null;
  pipeline_status: 'under_contract' | 'listed' | 'ended' | 'open' | null;
  tx_side: string | null;
  tx_date: string | null;
  tx_id: string | null;
  likelihood: number | null;
  has_touch: boolean;
}

/** Which pipeline state one transaction row is in, by code from its columns.
 * A close date in the future is a scheduled closing: the file is still open. */
export function pipelineStatusOf(tx: PitchTransaction, today?: string): 'under_contract' | 'listed' | 'ended' | 'open' | null {
  if (!tx.ours) return null;
  const closed = !!tx.close_date && (!today || tx.close_date.slice(0, 10) <= today);
  if (closed || tx.fell_through_date) return null; // a closed or void file is not the pipeline
  if (tx.contract_date) return 'under_contract';
  if (tx.listed_date) return 'listed';
  return 'open';
}

/**
 * The facts record for one contact. `transactions` are the rows on the
 * record (its closings' own tx rows or a fresh read); the pipeline state is
 * the strongest open one, in the order under contract > listed > ended >
 * open, so the card never shows two files at once. `ended` is a row that
 * fell through: it carries a fell_through_date and no close.
 */
export function contactFacts(input: {
  stage: string;
  kind: string | null;
  source: string | null;
  roles: readonly string[];
  closings: readonly PitchClosing[];
  transactions: readonly PitchTransaction[];
  likelihood: number | null;
  hasTouch: boolean;
  today: string;
}): ContactFacts {
  const closed = input.closings.filter((c) => c.closed && c.ours);
  const last = closed.map((c) => (c.close_date ?? '').slice(0, 10)).sort().pop() ?? null;
  const states = input.transactions.map((tx) => ({ tx, s: pipelineStatusOf(tx, input.today) }));
  const open = states
    .filter((x) => x.s && x.s !== 'ended')
    .sort((a, b) => rank(a.s!) - rank(b.s!))[0];
  const ended = states.find((x) => x.s === null && x.tx.ours && x.tx.fell_through_date && !x.tx.close_date);
  const file = open ?? ended ?? null;
  const fileStatus = open ? open.s : ended ? 'ended' : null;
  const fileDate = !file ? null : fileStatus === 'ended' ? file.tx.fell_through_date : (file.tx.contract_date ?? file.tx.listed_date ?? null);
  return {
    stage: input.stage,
    kind: input.kind,
    source: input.source ?? null,
    roles: [...input.roles],
    closings_ours: closed.length,
    last_close: last ? dateText(last) : null,
    last_close_id: null,
    pipeline_status: fileStatus,
    tx_side: file ? file.tx.side : null,
    tx_date: fileDate ? dateText(fileDate.slice(0, 10)) : null,
    tx_id: file ? file.tx.id : null,
    likelihood: typeof input.likelihood === 'number' && Number.isFinite(input.likelihood) ? input.likelihood : null,
    has_touch: input.hasTouch,
  };
}

const rank = (s: 'under_contract' | 'listed' | 'ended' | 'open') => (s === 'under_contract' ? 0 : s === 'listed' ? 1 : 2);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const roleWord = (r: string) => (r === 'title' ? 'title side' : r);

export const CONTACT_RULES = [
  defineRule<ContactFacts>({
    id: 'answer_fast',
    contexts: ['inquiry'],
    needs: ['source', 'has_touch'],
    weight: 95,
    class: 'reach',
    label: 'Answer today',
    when: (f) => f.source === 'website' && !f.has_touch,
    facts: () => ['They wrote through her website and nothing of hers has reached them yet.', 'Answer today: ask what they are looking for and when they want to move.'],
  }),
  defineRule<ContactFacts>({
    id: 'under_contract_care',
    contexts: ['pipeline'],
    needs: ['pipeline_status', 'tx_date'],
    weight: 90,
    class: 'reach',
    label: 'Keep the contract moving',
    when: (f) => f.pipeline_status === 'under_contract',
    facts: (f) => [`They are under contract, since ${f.tx_date}.`, 'Ask what the title and lender sides still need from them.'],
    evidence: (f) => (f.tx_id ? [f.tx_id] : []),
    rule: 'never ask for a listing',
  }),
  defineRule<ContactFacts>({
    id: 'partner_loop',
    contexts: ['partner'],
    needs: ['roles'],
    weight: 85,
    class: 'referral',
    label: 'Trade referrals',
    when: (f) => f.roles.some((r) => PARTNER_ROLES.includes(r)),
    facts: (f) => {
      const rs = f.roles.filter((r) => PARTNER_ROLES.includes(r)).map(roleWord);
      return [`They are the ${rs.join(' and ')} her deals lean on.`, 'Ask whose buyers they are meeting, and offer hers back.'];
    },
  }),
  defineRule<ContactFacts>({
    id: 'past_client_reach',
    contexts: ['contact'],
    needs: ['stage', 'closings_ours', 'last_close'],
    weight: 80,
    class: 'reach',
    label: 'The house, and who they know',
    when: (f) => f.stage === 'past_client' && f.closings_ours >= 1,
    facts: (f) => [
      `They have closed with her ${plural(f.closings_ours, 'time', 'times')}${f.last_close ? `, the last ${f.last_close}` : ''}.`,
      'Ask how the house is treating them, and who they know who is moving.',
    ],
    evidence: (f) => (f.last_close_id ? [f.last_close_id] : []),
    rule: 'never ask for a listing',
  }),
  defineRule<ContactFacts>({
    id: 'relist_ask',
    contexts: ['pipeline'],
    needs: ['pipeline_status', 'tx_date'],
    weight: 75,
    class: 'listing',
    label: 'Ask to try again',
    when: (f) => f.pipeline_status === 'ended',
    facts: (f) => [`Their file ended without a closing, ${f.tx_date}.`, 'Ask whether to try again, and what would make it work this time.'],
    evidence: (f) => (f.tx_id ? [f.tx_id] : []),
  }),
  defineRule<ContactFacts>({
    id: 'listing_check_in',
    contexts: ['pipeline'],
    needs: ['pipeline_status', 'tx_side', 'tx_date'],
    weight: 70,
    class: 'reach',
    label: 'Check in on the listing',
    when: (f) => f.pipeline_status === 'listed' && (f.tx_side === 'sell' || f.tx_side === 'both'),
    facts: (f) => [`Their home is on the market, listed ${f.tx_date}.`, 'Ask how the showings have felt, and what she can clear for them.'],
    evidence: (f) => (f.tx_id ? [f.tx_id] : []),
    rule: 'never ask for a listing',
  }),
  defineRule<ContactFacts>({
    id: 'qualify_prospect',
    contexts: ['pipeline'],
    needs: ['pipeline_status'],
    weight: 60,
    class: 'question',
    label: 'What they need, and when',
    when: (f) => f.pipeline_status === 'open',
    facts: () => ['An open file with no contract yet.', 'Ask what they need and when they want it.'],
    evidence: (f) => (f.tx_id ? [f.tx_id] : []),
  }),
  defineRule<ContactFacts>({
    id: 'likely_mover_ask',
    contexts: ['contact'],
    needs: ['likelihood'],
    weight: 50,
    class: 'question',
    label: 'Ask what they are planning',
    when: (f) => (f.likelihood ?? 0) >= 4,
    facts: () => ['Dated signals on file put them among the likelier in her book to buy or sell.', 'Ask what they are planning, without reading them a number.'],
    rule: 'never read a score or a number aloud',
  }),
];

export const CONTACT_ANGLE_IDS = CONTACT_RULES.map((r) => r.id);

/** A closings.ts ClosingView, as this adapter reads it. */
export function pitchClosing(v: { closed: boolean; purchase: boolean; tx: { ours: boolean; close_date: string | null } }): PitchClosing {
  return { closed: v.closed, ours: v.tx.ours, purchase: v.purchase, close_date: v.tx.close_date };
}

/** The contexts a contact's own record makes applicable, by code. */
export function contextsFor(facts: ContactFacts): PitchContext[] {
  const out: PitchContext[] = ['contact'];
  if (facts.pipeline_status) out.push('pipeline');
  if (facts.roles.some((r) => PARTNER_ROLES.includes(r))) out.push('partner');
  if (facts.source === 'website') out.push('inquiry');
  return out;
}

export interface ContactPitch extends Evaluation {
  contexts: PitchContext[];
  top: Angle[];
  key: string;
  /** One line for a row: "Pitch: keep the contract moving". */
  line: string;
  facts: ContactFacts;
}

/**
 * The pitch for one contact. A do-not-contact card gets no angle at all
 * (every class blocked, so nothing fires through the block list).
 */
export function contactPitch(input: Parameters<typeof contactFacts>[0] & { doNotCross?: boolean }): ContactPitch {
  const facts = contactFacts(input);
  const contexts = contextsFor(facts);
  const block = new Set<AngleClass>(input.doNotCross || input.stage === 'dnc' ? (['listing', 'buyer', 'land', 'referral', 'question', 'reach'] as AngleClass[]) : []);
  const merged: Evaluation = { angles: [], refused: [], blocked: [] };
  for (const c of contexts) {
    const ev = evaluate(CONTACT_RULES, c, facts, { block });
    merged.angles.push(...ev.angles);
    merged.refused.push(...ev.refused);
    merged.blocked.push(...ev.blocked);
  }
  merged.angles.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
  const dedup: Angle[] = [];
  for (const a of merged.angles) if (!dedup.some((d) => d.id === a.id)) dedup.push(a);
  const { top, key } = topAngles(dedup, 2);
  return {
    ...merged,
    angles: dedup,
    contexts,
    top,
    key,
    line: top.length ? `Pitch: ${top.map((a, i) => (i === 0 ? a.label : a.label.charAt(0).toLowerCase() + a.label.slice(1))).join('; ')}` : '',
    facts,
  };
}
