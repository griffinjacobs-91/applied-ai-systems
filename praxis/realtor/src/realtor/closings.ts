// A contact's closings, read off `transactions`, with the anniversary each one
// still earns. Pure: the loader in contact-data.ts fetches the rows, this
// decides what they mean, and test/realtor-closings.test.mjs holds it.
//
// WHICH ROWS ARE "THEIR CLOSING". A home anniversary is the day somebody got
// the keys, so only a purchase counts: a deal of ours on the buy side (or
// both sides) that has a close date, has not fallen through, and belongs to
// this contact or to their household. A sale is a closing too, and it is
// listed on the profile, but nobody sends "happy anniversary of selling".
//
// THE VOID RULE is anniversary.ts's, applied per property. The events it
// reads are the other rows on the same property:
//   - the same owner selling it (a sell-side row with a close date) -> sold
//   - the same owner listing it (any row of theirs with a listed date) -> listed
//   - anybody else's purchase of it, or a public-record sale with no owner of
//     ours on it -> resold to someone else
// "The same owner" is the household when the contact has one, so a spouse
// selling the house voids it for both of them.

import { anniversaryMonth, anniversaryVerdict, nextAnniversary, type PropertyEvent, type VoidReason } from './anniversary.ts';

export interface TransactionRow {
  id: string;
  property_id: string;
  lead_id: string | null;
  household_id: string | null;
  ours: boolean;
  side: string | null;
  listed_date: string | null;
  contract_date: string | null;
  close_date: string | null;
  close_date_source?: string | null;
  fell_through_date: string | null;
  deed_price_cents: number | null;
  deed_price_source?: string | null;
  deed_reception_number?: string | null;
  deed_reception_source?: string | null;
}

export interface ClosingContact {
  id: string;
  kind: string | null;
  name: string;
  household_id: string | null;
}

export interface ClosingView {
  tx: TransactionRow;
  /** They bought it (the row an anniversary can hang off). */
  purchase: boolean;
  /** Closed on or before today and never fell through. */
  closed: boolean;
  anniversary: {
    on: boolean;
    reason: VoidReason | null;
    /** Next anniversary on or after today, YYYY-MM-DD. */
    next: string | null;
    years: number | null;
    month: number | null;
  } | null;
}

function day(v: string | null | undefined): string {
  return (v ?? '').slice(0, 10);
}

function ownerOf(tx: Pick<TransactionRow, 'id' | 'household_id' | 'lead_id'>): string {
  if (tx.household_id) return `household:${tx.household_id}`;
  if (tx.lead_id) return `lead:${tx.lead_id}`;
  return `record:${tx.id}`;
}

function contactOwner(c: ClosingContact): string {
  return c.household_id ? `household:${c.household_id}` : `lead:${c.id}`;
}

/** Does this row belong to this contact (directly or through the household)? */
export function belongsTo(tx: Pick<TransactionRow, 'lead_id' | 'household_id'>, c: ClosingContact): boolean {
  if (tx.lead_id && tx.lead_id === c.id) return true;
  return !!(c.household_id && tx.household_id && tx.household_id === c.household_id);
}

/** The property events the void rule reads, from every row on the properties. */
export function propertyEvents(rows: readonly TransactionRow[]): PropertyEvent[] {
  const out: PropertyEvent[] = [];
  for (const tx of rows) {
    if (day(tx.fell_through_date)) continue;
    const owner = ownerOf(tx);
    const close = day(tx.close_date);
    const listed = day(tx.listed_date);
    if (listed) out.push({ property_id: tx.property_id, owner, kind: 'listed', date: listed });
    if (!close) continue;
    if (tx.ours && tx.side === 'sell') out.push({ property_id: tx.property_id, owner, kind: 'sold', date: close });
    else out.push({ property_id: tx.property_id, owner, kind: 'bought', date: close });
  }
  return out;
}

/**
 * Every row that belongs to the contact, newest close first (open deals
 * first of all), each with the anniversary it earns when it is a purchase.
 * `rows` may hold other people's rows on the same properties; they are read
 * as events and never listed.
 */
export function contactClosings(contact: ClosingContact, rows: readonly TransactionRow[], today: string): ClosingView[] {
  const owner = contactOwner(contact);
  // A row's owner key is its household when it has one; the contact's own
  // rows are read under the contact's key, whichever of the two that is.
  const events = propertyEvents(rows).map((e) => (e.owner === `lead:${contact.id}` ? { ...e, owner } : e));
  const mine = rows.filter((tx) => belongsTo(tx, contact));
  const views = mine.map((tx): ClosingView => {
    const close = day(tx.close_date);
    const closed = !!close && close <= today && !day(tx.fell_through_date);
    const purchase = tx.ours && (tx.side === 'buy' || tx.side === 'both');
    let anniversary: ClosingView['anniversary'] = null;
    if (closed && purchase) {
      // Events recorded against this very row are the closing itself.
      const others = events.filter((e) => !(e.owner === owner && e.kind === 'bought' && e.date === close));
      const verdict = anniversaryVerdict(
        { property_id: tx.property_id, owner, owner_name: contact.name, owner_kind: contact.kind, close_date: close },
        others,
      );
      const next = verdict.on ? nextAnniversary(close, today) : null;
      anniversary = {
        on: verdict.on,
        reason: verdict.reason,
        next: next?.date ?? null,
        years: next?.years ?? null,
        month: verdict.on ? anniversaryMonth(close) : null,
      };
    }
    return { tx, purchase, closed, anniversary };
  });
  return views.sort((a, b) => {
    const ac = day(a.tx.close_date) || '9999';
    const bc = day(b.tx.close_date) || '9999';
    return ac < bc ? 1 : ac > bc ? -1 : 0;
  });
}

/** The month the list's "anniversary" column shows: the newest closing that
 *  still earns one. Null when none does. */
export function listAnniversaryMonth(views: readonly ClosingView[]): number | null {
  for (const v of views) if (v.anniversary?.on) return v.anniversary.month;
  return null;
}

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** "$412,500" from cents. Never rounds a deed price to thousands. */
export function priceText(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '';
  const dollars = cents / 100;
  return dollars.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}
