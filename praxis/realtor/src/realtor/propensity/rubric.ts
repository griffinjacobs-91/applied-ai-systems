// realtor/propensity/rubric — the published rubric. Likelihood to buy or sell,
// 1 to 5, computed by CODE from a contact's weighted, dated signals. Pure.
//
// THE RUBRIC, in words (RUBRIC_LINES is this, as the card prints it):
//
//   Each signal has a weight (WEIGHTS). A signal older than 24 months counts
//   half; older than 36 months it does not count, except the states
//   recomputed from the rows every time (mover_band, long_tenure,
//   recent_purchase, repeat_client, referral_source). The points are the sum.
//
//   5  at least 6 points AND at least two independent dated signals in the
//      last 12 months, at least one of them a property or business signal.
//      Six points without that pair is a 4, never a 5.
//   4  at least 4 points.
//   3  at least 2.5 points.
//   2  more than 0 points.
//   1  0 points or fewer: typically a past client who bought in the last two
//      years and nothing else (recent_purchase counts down).
//   —  not enough data: no signal at all beyond the soft ones (came by
//      referral, talked this year). A dash, never a 1.
//
// Independent means a different kind of fact standing on a different row: a
// home sale and a new company are two; one deed read twice is one.
//
// Nothing here reads a person's traits. The kinds are the whole vocabulary
// (types.ts), and fair-housing.ts says what can never become one.

import { SIGNAL_FAMILY, SIGNAL_LABELS, type Signal, type SignalKind } from './types.ts';

/** Bump when WEIGHTS or the bands change: every stored score is recomputed on the next sweep. */
export const RUBRIC_VERSION = 2; // 2 (24 Sep): signals sharing a row are not an independent pair

export const WEIGHTS: Record<SignalKind, number> = {
  mover_band: 2,
  home_sold: 3,
  second_property: 2,
  lot_bought: 3,
  recent_purchase: -2,
  long_tenure: 0.5,
  entity_formed: 1.5,
  entity_dissolved: 2,
  trade_name_new_address: 1.5,
  business_opened: 1.5,
  business_moved: 2,
  business_closed: 2,
  job_change: 1,
  employer_change: 1.5,
  location_change: 3,
  relocation_public: 3,
  fsbo_own_page: 4,
  stated_intent: 4,
  active_file: 3,
  repeat_client: 1.5,
  referral_source: 0.5,
  recent_contact: 0.5,
};

/** Signals that alone say nothing about a move: a contact with only these reads "not enough data". */
export const SOFT_KINDS: ReadonlySet<SignalKind> = new Set<SignalKind>(['referral_source', 'recent_contact']);

/** States recomputed from the rows every time (ownership bands, a repeat client, how they came to her): never aged out. */
const STATE_KINDS: ReadonlySet<SignalKind> = new Set<SignalKind>(['mover_band', 'long_tenure', 'recent_purchase', 'repeat_client', 'referral_source']);

export const HALF_AFTER_MONTHS = 24;
export const DROP_AFTER_MONTHS = 36;
export const RECENT_MONTHS = 12;

export const BANDS = { five: 6, four: 4, three: 2.5, two: 0 } as const;

export const RUBRIC_LINES: readonly string[] = [
  '5: at least 6 points and two independent signals in the last 12 months, one of them property or business.',
  '4: at least 4 points. 3: at least 2.5 points. 2: more than 0 points.',
  '1: no points or fewer, such as a home bought in the last 2 years and nothing else.',
  'A dash: not enough data to say. It is never shown as a 1.',
  'Signals older than 24 months count half and drop after 36; only dated public and CRM facts count.',
];

function monthsBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  let m = (ty - fy) * 12 + (tm - fm);
  if (td < fd) m -= 1;
  return m;
}

/** The weight a signal carries today, after ageing. 0 means it does not count. */
export function effectiveWeight(s: Pick<Signal, 'kind' | 'date'>, today: string): number {
  const w = WEIGHTS[s.kind];
  if (STATE_KINDS.has(s.kind)) return w;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.date) || s.date > today) return 0;
  const monthsOld = monthsBetween(s.date, today);
  if (monthsOld >= DROP_AFTER_MONTHS) return 0;
  if (monthsOld >= HALF_AFTER_MONTHS) return w / 2;
  return w;
}

export function isRecent(s: Pick<Signal, 'date'>, today: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s.date) && s.date <= today && monthsBetween(s.date, today) < RECENT_MONTHS;
}

export interface ScoredSignal<S extends Signal = Signal> {
  signal: S;
  weight: number;
}

export interface PropensityScore<S extends Signal = Signal> {
  /** 1 to 5, or null for "not enough data" (shown as a dash). */
  score: 1 | 2 | 3 | 4 | 5 | null;
  points: number;
  /** Every signal that counts today, heaviest first. */
  counted: ScoredSignal<S>[];
  /** The top three by weight (then newest), for the card and the wording. */
  top: ScoredSignal<S>[];
  /** Why a 5 was held at 4, when it was. */
  heldAtFour: string | null;
  rubricVersion: number;
}

function ref(s: Signal): string {
  return `${s.source}|${s.ref ?? ''}|${s.url ?? ''}`;
}

/** The rows a signal stands on. A ref written `table:id1,id2` names each row
 *  (repeat_client stands on every closing it counts); anything else is one row. */
export function rowsOf(s: Signal): Set<string> {
  const m = /^([a-z_]+):(.+)$/.exec(s.ref ?? '');
  if (!m) return new Set([ref(s)]);
  return new Set(m[2].split(',').map((id) => `${s.source}|${m[1]}:${id.trim()}`).filter((x) => !x.endsWith(':')));
}

function shareARow(a: Signal, b: Signal): boolean {
  const ra = rowsOf(a);
  for (const r of rowsOf(b)) if (ra.has(r)) return true;
  return false;
}

/** Two recent signals of different kinds on different rows, one of them property or business. */
export function hasIndependentRecentPair(signals: readonly Signal[], today: string): boolean {
  const recent = signals.filter((s) => isRecent(s, today) && WEIGHTS[s.kind] > 0 && !SOFT_KINDS.has(s.kind));
  for (let i = 0; i < recent.length; i++) {
    for (let j = i + 1; j < recent.length; j++) {
      const a = recent[i];
      const b = recent[j];
      if (a.kind === b.kind || shareARow(a, b)) continue; // one closing read twice is one fact
      const fa = SIGNAL_FAMILY[a.kind];
      const fb = SIGNAL_FAMILY[b.kind];
      if (fa === 'property' || fa === 'business' || fb === 'property' || fb === 'business') return true;
    }
  }
  return false;
}

/** The score, from the signals. `today` is YYYY-MM-DD. */
export function scorePropensity<S extends Signal>(signals: readonly S[], today: string): PropensityScore<S> {
  // One signal per (kind, row): the same fact found twice counts once.
  const seen = new Set<string>();
  const uniq: S[] = [];
  for (const s of signals) {
    const k = `${s.kind}|${ref(s)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(s);
  }
  const counted = uniq
    .map((signal) => ({ signal, weight: effectiveWeight(signal, today) }))
    .filter((x) => x.weight !== 0)
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight) || (a.signal.date < b.signal.date ? 1 : a.signal.date > b.signal.date ? -1 : 0));
  const points = Math.round(counted.reduce((n, x) => n + x.weight, 0) * 100) / 100;
  const top = counted.slice(0, 3);
  const base = { points, counted, top, heldAtFour: null as string | null, rubricVersion: RUBRIC_VERSION };

  const substantive = counted.filter((x) => !SOFT_KINDS.has(x.signal.kind));
  if (substantive.length === 0) return { ...base, score: null };

  if (points <= BANDS.two) return { ...base, score: 1 };
  if (points >= BANDS.five) {
    if (hasIndependentRecentPair(counted.map((x) => x.signal), today)) return { ...base, score: 5 };
    return { ...base, score: 4, heldAtFour: 'Held at 4: a 5 needs two independent signals in the last 12 months, one of them property or business.' };
  }
  if (points >= BANDS.four) return { ...base, score: 4 };
  if (points >= BANDS.three) return { ...base, score: 3 };
  return { ...base, score: 2 };
}

/** "—" for not enough data, else the digit. */
export function scoreText(score: number | null | undefined): string {
  return score === null || score === undefined ? '—' : String(score);
}

export function signalLabel(kind: SignalKind): string {
  return SIGNAL_LABELS[kind];
}
