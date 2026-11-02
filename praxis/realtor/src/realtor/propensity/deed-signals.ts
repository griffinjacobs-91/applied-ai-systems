// realtor/propensity/deed-signals — what the county record says about a
// contact's home, as dated signals. Pure: the run script and the sweep hand
// in the rows; nothing here fetches.
//
// THE HOME. Their newest purchase with her (a closing on file, buy side);
// failing that, a property on file as theirs ('owns') whose county deed names
// a buyer with their surname, which dates the purchase from the deed. With
// neither, the county is not asked to guess which house is theirs from a
// name alone, and no ownership signal is made.
//
// FROM THE HOME:
//   home_sold        a later deed on the same parcel or street address sells
//                    it to someone else (or her own sell-side closing does):
//                    a past client with no home is a buyer. The anniversary
//                    is void already (closings.ts reads the same facts).
//   mover_band       owned 5 to 9 years, not sold. Dated the day year 5 began.
//   recent_purchase  bought in the last 2 years (counts DOWN).
//   long_tenure      owned 10 years or more.
// BY NAME (exact surname AND first name against the deed's first party):
//   second_property  bought another improved property after the home.
//   lot_bought       bought vacant land (the parcel layer's last sale, or a
//                    vacant deed) in the last 36 months.
// Every by-name signal says "matched by name" in its detail, so she can see
// it is weaker than a parcel match.
//
// NOT HERE, on purpose: a listing filed somewhere else. It is not in any
// public feed this CRM may read, and it is never guessed.

import { shortDate } from './crm-signals.ts';
import type { Signal } from './types.ts';

export interface CountySale {
  source: 'deed' | 'parcel' | 'eagleweb';
  county: string;
  parcel: string | null;
  reception: string | null;
  /** YYYY-MM-DD */
  date: string;
  /** Situs address as the county writes it. */
  address: string | null;
  /** First party names as the county writes them ("LAST FIRST M & LAST2 FIRST2"). */
  buyer: string | null;
  seller: string | null;
  vacant: boolean;
}

export interface DeedContact {
  id: string;
  household_id: string | null;
  first_name: string | null;
  last_name: string | null;
}

export interface DeedProperty {
  id: string;
  address_line1: string;
  city: string | null;
  county: string | null;
  parcel_id: string | null;
}

export interface DeedTx {
  id: string;
  property_id: string;
  lead_id: string | null;
  household_id: string | null;
  ours: boolean;
  side: string | null;
  close_date: string | null;
  fell_through_date: string | null;
  deed_reception_number?: string | null;
}

export interface DeedLink {
  property_id: string;
  relation: string;
}

// ── Keys ─────────────────────────────────────────────────────────────────────

const SUFFIX: Record<string, string> = {
  STREET: 'ST', AVENUE: 'AVE', AV: 'AVE', ROAD: 'RD', DRIVE: 'DR', LANE: 'LN', COURT: 'CT', CIRCLE: 'CIR',
  PLACE: 'PL', BOULEVARD: 'BLVD', PARKWAY: 'PKWY', TERRACE: 'TER', TRAIL: 'TRL', HIGHWAY: 'HWY', WAY: 'WAY',
  NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W', LOOP: 'LOOP', POINT: 'PT',
};

/** "2461 Elm Avenue, Grand Junction" and "2461 ELM AVE" to the same key. Unit and city dropped. */
export function addressKey(a: string | null | undefined): string {
  const street = (a ?? '').split(',')[0].toUpperCase().replace(/#.*$/, '').replace(/\b(UNIT|APT|STE|SUITE)\b.*$/, '');
  const toks = street.replace(/[^A-Z0-9/ ]+/g, ' ').split(/\s+/).filter(Boolean).map((t) => SUFFIX[t] ?? t);
  return toks.length >= 2 && /\d/.test(toks[0]) ? toks.join(' ') : '';
}

export function parcelKey(p: string | null | undefined): string {
  return (p ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

function letters(s: string | null | undefined): string {
  return (s ?? '').toUpperCase().replace(/[^A-Z\- ]+/g, '').trim();
}

/** The contact as the deeds write a person: "LAST|FIRST". Empty when either is missing. */
export function contactNameKey(c: Pick<DeedContact, 'first_name' | 'last_name'>): string {
  const last = letters(c.last_name).split(/\s+/).pop() ?? '';
  const first = letters(c.first_name).split(/\s+/)[0] ?? '';
  return last && first ? `${last}|${first}` : '';
}

/** Every person-name key in a county party string: "SMITH JOHN A & SMITH JANE" to SMITH|JOHN and SMITH|JANE. */
export function partyNameKeys(party: string | null | undefined): string[] {
  const out: string[] = [];
  for (const part of (party ?? '').toUpperCase().split(/&|\bAND\b|;/)) {
    const toks = part.replace(/[^A-Z\- ]+/g, ' ').split(/\s+/).filter(Boolean);
    if (toks.length >= 2) out.push(`${toks[0]}|${toks[1]}`);
  }
  return out;
}

export function partySurnames(party: string | null | undefined): Set<string> {
  return new Set(partyNameKeys(party).map((k) => k.split('|')[0]));
}

// ── The index the run builds once ────────────────────────────────────────────

export interface SaleIndex {
  byParcel: Map<string, CountySale[]>;
  byAddress: Map<string, CountySale[]>;
  byBuyer: Map<string, CountySale[]>;
}

export function indexSales(sales: readonly CountySale[]): SaleIndex {
  const idx: SaleIndex = { byParcel: new Map(), byAddress: new Map(), byBuyer: new Map() };
  const put = (m: Map<string, CountySale[]>, k: string, s: CountySale) => {
    if (!k) return;
    const l = m.get(k) ?? [];
    l.push(s);
    m.set(k, l);
  };
  for (const s of sales) {
    put(idx.byParcel, parcelKey(s.parcel), s);
    put(idx.byAddress, addressKey(s.address), s);
    for (const k of new Set(partyNameKeys(s.buyer))) put(idx.byBuyer, k, s);
  }
  return idx;
}

// ── Dates ────────────────────────────────────────────────────────────────────

function day(v: string | null | undefined): string {
  return (v ?? '').slice(0, 10);
}

function plusYears(d: string, n: number): string {
  const [y, m, dd] = d.split('-').map(Number);
  const mm = String(m).padStart(2, '0');
  const ddd = m === 2 && dd === 29 ? '28' : String(dd).padStart(2, '0');
  return `${y + n}-${mm}-${ddd}`;
}

export function wholeYearsBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  let y = ty - fy;
  if (tm < fm || (tm === fm && td < fd)) y -= 1;
  return y;
}

function saleRef(s: CountySale): string {
  return `${s.county} ${s.source === 'parcel' ? 'parcel' : 'rec.'} ${s.source === 'parcel' ? s.parcel ?? '' : s.reception ?? s.parcel ?? ''}`.trim();
}

function saleWhere(s: CountySale): string {
  return s.address ? titleCase(s.address) : `parcel ${s.parcel ?? ''}`.trim();
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

// ── The signals ──────────────────────────────────────────────────────────────

export interface DeedSignalInput {
  contact: DeedContact;
  /** Every transaction row on the contact's properties and every row of theirs. */
  txs: readonly DeedTx[];
  properties: ReadonlyMap<string, DeedProperty>;
  links: readonly DeedLink[];
  sales: SaleIndex;
  today: string;
}

function belongs(t: DeedTx, c: DeedContact): boolean {
  return t.lead_id === c.id || (!!c.household_id && t.household_id === c.household_id);
}

interface Home {
  property: DeedProperty;
  date: string;
  from: 'closing' | 'deed';
  ref: string;
  txId: string | null;
}

function findHome(inp: DeedSignalInput): Home | null {
  const { contact: c, today } = inp;
  const purchases = inp.txs
    .filter((t) => belongs(t, c) && t.ours && (t.side === 'buy' || t.side === 'both') && day(t.close_date) && day(t.close_date) <= today && !day(t.fell_through_date))
    .sort((a, b) => (day(a.close_date) < day(b.close_date) ? 1 : -1));
  for (const t of purchases) {
    const p = inp.properties.get(t.property_id);
    if (p) return { property: p, date: day(t.close_date), from: 'closing', ref: `transactions:${t.id}`, txId: t.id };
  }
  const surname = contactNameKey(c).split('|')[0];
  if (!surname) return null;
  let best: Home | null = null;
  for (const l of inp.links) {
    if (l.relation !== 'owns') continue;
    const p = inp.properties.get(l.property_id);
    if (!p) continue;
    const cands = [...(inp.sales.byParcel.get(parcelKey(p.parcel_id)) ?? []), ...(inp.sales.byAddress.get(addressKey(p.address_line1)) ?? [])]
      .filter((s) => !s.vacant && s.date <= today && partySurnames(s.buyer).has(surname));
    for (const s of cands) {
      if (!best || s.date > best.date) best = { property: p, date: s.date, from: 'deed', ref: saleRef(s), txId: null };
    }
  }
  return best;
}

export function deedSignals(inp: DeedSignalInput): Signal[] {
  const { contact: c, today } = inp;
  const out: Signal[] = [];
  const home = findHome(inp);
  const myProps = new Set<string>([...inp.links.map((l) => l.property_id), ...inp.txs.filter((t) => belongs(t, c)).map((t) => t.property_id)]);
  const myParcels = new Set([...myProps].map((id) => parcelKey(inp.properties.get(id)?.parcel_id)).filter(Boolean));
  const myAddrs = new Set([...myProps].map((id) => addressKey(inp.properties.get(id)?.address_line1)).filter(Boolean));
  const surname = contactNameKey(c).split('|')[0];

  if (home) {
    const where = home.property.address_line1;
    const bought = `Bought ${where} on ${shortDate(home.date)} (${home.from === 'closing' ? 'your closing' : `deed, ${home.ref}`})`;

    // Sold since: her own records first, then the county.
    let sold: Signal | null = null;
    const later = inp.txs
      .filter((t) => t.property_id === home.property.id && t.id !== home.txId && day(t.close_date) > home.date && day(t.close_date) <= today && !day(t.fell_through_date))
      .filter((t) => (belongs(t, c) && t.ours && t.side === 'sell') || (!belongs(t, c) && t.side !== 'sell'))
      .sort((a, b) => (day(a.close_date) < day(b.close_date) ? -1 : 1))[0];
    if (later) {
      sold = {
        kind: 'home_sold', source: 'crm', date: day(later.close_date), ref: `transactions:${later.id}`, url: null,
        detail: `${bought}; it sold on ${shortDate(day(later.close_date))} per your records. They may be buying.`,
      };
    } else {
      const sale = [...(inp.sales.byParcel.get(parcelKey(home.property.parcel_id)) ?? []), ...(inp.sales.byAddress.get(addressKey(home.property.address_line1)) ?? [])]
        .filter((s) => !s.vacant && s.date > home.date && s.date <= today && !(surname && partySurnames(s.buyer).has(surname)))
        .sort((a, b) => (a.date < b.date ? -1 : 1))[0];
      if (sale) {
        sold = {
          kind: 'home_sold', source: sale.source, date: sale.date, ref: saleRef(sale), url: null,
          detail: `${bought}; the county records a sale of it on ${shortDate(sale.date)} (${saleRef(sale)}). They may be buying.`,
        };
      }
    }
    if (sold) out.push(sold);
    else {
      const years = wholeYearsBetween(home.date, today);
      const src = home.from === 'closing' ? 'crm' : 'deed';
      if (years >= 5 && years <= 9) {
        out.push({ kind: 'mover_band', source: src, date: plusYears(home.date, 5), ref: home.ref, url: null, detail: `${bought}; ${years} years owned, in the 5 to 9 year band.`, payload: { bought_on: home.date, bought_from: home.from, address: where } });
      } else if (years >= 10) {
        out.push({ kind: 'long_tenure', source: src, date: plusYears(home.date, 10), ref: home.ref, url: null, detail: `${bought}; ${years} years owned.`, payload: { bought_on: home.date, bought_from: home.from, address: where } });
      } else if (home.date > plusYears(today, -2)) {
        out.push({ kind: 'recent_purchase', source: src, date: home.date, ref: home.ref, url: null, detail: `${bought}; bought within the last 2 years.`, payload: { bought_on: home.date, bought_from: home.from, address: where } });
      }
    }
  }

  // By name: another purchase after the home, or land in the last 36 months.
  const key = contactNameKey(c);
  if (key) {
    const since36 = plusYears(today, -3);
    const seen = new Set<string>();
    for (const s of inp.sales.byBuyer.get(key) ?? []) {
      if (s.date > today) continue;
      if (myParcels.has(parcelKey(s.parcel)) || myAddrs.has(addressKey(s.address))) continue;
      const k = `${parcelKey(s.parcel)}|${s.date}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (s.vacant) {
        if (s.date < since36) continue;
        out.push({
          kind: 'lot_bought', source: s.source, date: s.date, ref: saleRef(s), url: null,
          detail: `Bought land at ${saleWhere(s)} on ${shortDate(s.date)} (${saleRef(s)}), matched by name.`,
        });
      } else if (home && s.date > home.date) {
        out.push({
          kind: 'second_property', source: s.source, date: s.date, ref: saleRef(s), url: null,
          detail: `Bought ${saleWhere(s)} on ${shortDate(s.date)} (${saleRef(s)}), matched by name.`,
        });
      }
    }
  }
  return out;
}
