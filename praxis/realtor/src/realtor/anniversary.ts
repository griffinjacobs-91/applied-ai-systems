// Home anniversaries: which closings still earn one, and when it falls.
// Pure: no Supabase, no fetch. Tested off disk by test/realtor-anniversary.test.mjs.
//
// THE VOID RULE. A closing is the fact an anniversary hangs off, and it stops
// being one the moment it stops being true that they live there:
//
//   1. Entities never get one. "Happy home anniversary, Ridgeline Builders
//      LLC" is a card nobody should send. An owner is an entity when the row
//      says kind = 'entity' OR the name reads as one (isEntityName).
//   2. The same owner sold that property, or listed it, after the closing.
//      They are leaving or gone; the card would land on the new owner.
//   3. Somebody else bought that property after the closing. The public deed
//      says the owner is gone even when their own sale never reached the book.
//
// Rules 2 and 3 are per PROPERTY. A move-up buyer sells the old house and
// buys the new one the same month; the sale of the old house voids the old
// house's anniversary and must never touch the new one's.
//
// "After" means on or after the close date, compared as calendar dates. A
// sale recorded the same day as the purchase is a double closing (a flip, a
// relocation buyout), and nobody is living in that house to congratulate.

export type VoidReason = 'entity' | 'sold_after' | 'listed_after' | 'resold_to_other';

export interface AnniversaryVerdict {
  on: boolean;
  reason: VoidReason | null;
}

/**
 * Words that mark a name as a company, trust or institution rather than a
 * household. Matched case-insensitively and on word boundaries only, after
 * dots are dropped (so "L.L.C." reads as LLC and "Inc." as INC), which is
 * what keeps CO from firing on "Cole" and HOMES on "Holmes".
 */
const ENTITY_WORDS = [
  'llc',
  'pllc',
  'llp',
  'lp',
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'co',
  'company',
  'ltd',
  'limited',
  'trust',
  'trustee',
  'trustees',
  'estate',
  'homes',
  'builders',
  'building',
  'construction',
  'contractors',
  'development',
  'developments',
  'properties',
  'property',
  'investments',
  'investors',
  'holdings',
  'partners',
  'partnership',
  'ventures',
  'enterprises',
  'group',
  'capital',
  'realty',
  'bank',
  'association',
  'church',
  'ministries',
  'foundation',
  'authority',
  'county',
  'city',
  'town',
  'district',
  'hoa',
];

const ENTITY_RE = new RegExp(`\\b(?:${ENTITY_WORDS.join('|')})\\b`, 'i');

/** Does this name read as an entity rather than a person or household? */
export function isEntityName(name: string | null | undefined): boolean {
  const v = (name ?? '').replace(/\./g, '').trim();
  if (!v) return false;
  return ENTITY_RE.test(v);
}

/** One thing that happened to one property, as the book or the deed records it. */
export interface PropertyEvent {
  property_id: string;
  /** Whose event it is: a lead id, a household id, or a normalised deed name.
   *  The caller decides what "the same owner" means and passes the same key
   *  for the closing below. */
  owner: string;
  kind: 'bought' | 'sold' | 'listed';
  /** YYYY-MM-DD. */
  date: string;
}

export interface Closing {
  property_id: string;
  owner: string;
  /** The owner's display name, read for rule 1. */
  owner_name?: string | null;
  /** leads.kind, when the owner is a row in the book. */
  owner_kind?: string | null;
  /** YYYY-MM-DD: the close date the anniversary counts from. */
  close_date: string;
}

/** Whether this closing still earns an anniversary, and if not, why. */
export function anniversaryVerdict(closing: Closing, events: readonly PropertyEvent[]): AnniversaryVerdict {
  if (closing.owner_kind === 'entity' || isEntityName(closing.owner_name)) {
    return { on: false, reason: 'entity' };
  }
  const closed = closing.close_date.slice(0, 10);
  // Sold outranks listed outranks resold, so the reason printed is the most
  // direct one on file.
  let reason: VoidReason | null = null;
  const rank: Record<VoidReason, number> = { entity: 0, sold_after: 1, listed_after: 2, resold_to_other: 3 };
  for (const e of events) {
    if (e.property_id !== closing.property_id) continue;
    if (e.date.slice(0, 10) < closed) continue;
    let r: VoidReason | null = null;
    if (e.owner === closing.owner) {
      if (e.kind === 'sold') r = 'sold_after';
      else if (e.kind === 'listed') r = 'listed_after';
      // The owner's own 'bought' on or after the close is the closing itself
      // (or a duplicate of it) and says nothing new.
    } else if (e.kind === 'bought') {
      r = 'resold_to_other';
    }
    if (r && (reason === null || rank[r] < rank[reason])) reason = r;
  }
  return reason ? { on: false, reason } : { on: true, reason: null };
}

export const VOID_REASON_LABELS: Record<VoidReason, string> = {
  entity: 'Owner is a company or trust',
  sold_after: 'They sold it',
  listed_after: 'They listed it',
  resold_to_other: 'Someone else bought it since',
};

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * The next anniversary of a close date on or after today, as YYYY-MM-DD, with
 * the number of years it marks. A Feb 29 closing is celebrated Feb 28 in a
 * common year rather than skipped for three years. Null for an unparseable
 * date or a close that has not happened yet.
 */
export function nextAnniversary(closeDate: string, today: string): { date: string; years: number } | null {
  const m = ISO.exec(closeDate);
  const t = ISO.exec(today);
  if (!m || !t) return null;
  const [cy, cm, cd] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ty = Number(t[1]);
  if (closeDate.slice(0, 10) > today.slice(0, 10)) return null;
  for (let y = Math.max(ty, cy + 1); y <= ty + 1; y += 1) {
    const d = cm === 2 && cd === 29 && !isLeap(y) ? 28 : cd;
    const date = `${y}-${String(cm).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (date >= today.slice(0, 10)) return { date, years: y - cy };
  }
  return null;
}

/** The month (1-12) a close date's anniversary falls in, for the list's
 *  "anniversary month" column. Null when the date does not parse. */
export function anniversaryMonth(closeDate: string | null | undefined): number | null {
  const m = ISO.exec(closeDate ?? '');
  if (!m) return null;
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? month : null;
}
