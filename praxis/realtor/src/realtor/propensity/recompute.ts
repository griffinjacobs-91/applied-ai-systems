// realtor/propensity/recompute — one contact's signals and score, from what
// is on file. Pure. The weekly sweep, the profile's Recompute button and the
// research run all come through here, so the three can never disagree.
//
// Two kinds of signal meet here:
//   - FREE signals, derived fresh every time from her own rows: crm-signals
//     (stage, source, closings count, last contact, dated plans in her notes)
//     and the ownership bands and sales her own closings show (deed-signals
//     with no county rows). These cost nothing and call nobody.
//   - RESEARCH signals, found once by a research run (county deeds, SOS,
//     the web through Firecrawl, People Data Labs) and stored. They are
//     carried as stored; the ownership bands among them are re-banded from
//     the purchase date they carry, so a 9-year owner becomes a 10-year one
//     on the day it happens without anybody asking the county again.
//
// When any signal says the home has sold, the ownership bands for it drop:
// someone without that home is not "in the mover band" in it.

import { crmSignals, type CrmContact, type CrmDeal, type CrmTouch } from './crm-signals.ts';
import { deedSignals, indexSales, wholeYearsBetween, type DeedContact, type DeedLink, type DeedProperty, type DeedTx } from './deed-signals.ts';
import { scorePropensity, type PropensityScore } from './rubric.ts';
import type { Signal, SignalSource } from './types.ts';

/** Sources a research run fills. Everything else is derived fresh. */
export const RESEARCH_SOURCES: readonly SignalSource[] = ['deed', 'parcel', 'eagleweb', 'sos', 'web', 'pdl'];

const BAND_KINDS = new Set(['mover_band', 'long_tenure', 'recent_purchase']);

function plusYears(d: string, n: number): string {
  const [y, m, dd] = d.split('-').map(Number);
  return `${y + n}-${String(m).padStart(2, '0')}-${m === 2 && dd === 29 ? '28' : String(dd).padStart(2, '0')}`;
}

/** A stored ownership band, moved to the band its purchase date puts it in today (or null: in none). */
export function reband<S extends Signal>(s: S, today: string): S | null {
  if (!BAND_KINDS.has(s.kind)) return s;
  const on = typeof s.payload?.bought_on === 'string' ? (s.payload.bought_on as string) : null;
  if (!on) return s;
  const years = wholeYearsBetween(on, today);
  const lead = s.detail.split(';')[0];
  if (years >= 5 && years <= 9) return { ...s, kind: 'mover_band', date: plusYears(on, 5), detail: `${lead}; ${years} years owned, in the 5 to 9 year band.` };
  if (years >= 10) return { ...s, kind: 'long_tenure', date: plusYears(on, 10), detail: `${lead}; ${years} years owned.` };
  if (on > plusYears(today, -2)) return { ...s, kind: 'recent_purchase', date: on, detail: `${lead}; bought within the last 2 years.` };
  return null;
}

export interface ContactRows {
  crm: CrmContact;
  deed: DeedContact;
  touches: readonly CrmTouch[];
  txs: readonly DeedTx[];
  properties: ReadonlyMap<string, DeedProperty>;
  links: readonly DeedLink[];
}

/** The free signals: her CRM, and what her own closings say about the home. */
export function freeSignals(rows: ContactRows, today: string): { signals: Signal[]; refusedProtected: number; undated: number } {
  const deals: CrmDeal[] = rows.txs
    .filter((t) => t.lead_id === rows.crm.id || (!!rows.deed.household_id && t.household_id === rows.deed.household_id))
    .map((t) => ({ id: t.id, ours: t.ours, close_date: t.close_date, fell_through_date: t.fell_through_date }));
  const crm = crmSignals({ contact: rows.crm, touches: rows.touches, deals, today });
  const home = deedSignals({ contact: rows.deed, txs: rows.txs, properties: rows.properties, links: rows.links, sales: indexSales([]), today });
  return { signals: [...crm.signals, ...home], refusedProtected: crm.refusedProtected, undated: crm.undated };
}

/** The final list: fresh free signals plus stored research ones, re-banded, the bands dropped when the home sold. */
export function mergeSignals<S extends Signal>(free: readonly Signal[], stored: readonly S[], today: string): Signal[] {
  const research = stored.filter((s) => RESEARCH_SOURCES.includes(s.source)).map((s) => reband(s, today)).filter((s): s is S => !!s);
  let all: Signal[] = [...free, ...research];
  if (all.some((s) => s.kind === 'home_sold')) all = all.filter((s) => !BAND_KINDS.has(s.kind));
  // One ownership band at most: a research band (a deed) yields to her own closing's.
  const bands = all.filter((s) => BAND_KINDS.has(s.kind));
  if (bands.length > 1) {
    const keep = bands.find((s) => s.source === 'crm') ?? bands[0];
    all = all.filter((s) => !BAND_KINDS.has(s.kind) || s === keep);
  }
  const seen = new Set<string>();
  return all.filter((s) => {
    const k = `${s.kind}|${s.source}|${s.ref ?? ''}|${s.url ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export interface Recomputed {
  signals: Signal[];
  score: PropensityScore;
  refusedProtected: number;
  undated: number;
}

export function recomputeContact(rows: ContactRows, stored: readonly Signal[], today: string): Recomputed {
  const free = freeSignals(rows, today);
  const signals = mergeSignals(free.signals, stored, today);
  return { signals, score: scorePropensity(signals, today), refusedProtected: free.refusedProtected, undated: free.undated };
}

/** The throwaway rows other sessions make, never scored: a name starting ZZ, or "delete me" anywhere. */
export function isThrowaway(name: string | null | undefined): boolean {
  const n = (name ?? '').trim();
  return /^zz/i.test(n) || /delete\s*me/i.test(n);
}

/** Who is scored at all: a person or a household card, not a throwaway. Entities are companies, not movers. */
export function isScorable(c: { kind: string | null; name: string }): boolean {
  return (c.kind ?? 'person') !== 'entity' && !isThrowaway(c.name);
}
