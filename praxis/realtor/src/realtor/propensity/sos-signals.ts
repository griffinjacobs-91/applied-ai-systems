// realtor/propensity/sos-signals — Colorado Secretary of State records as
// dated signals. Pure: the run hands in rows read from data.colorado.gov
// (public, keyless, attribution CDOS); nothing here fetches.
//
//   entity_formed           Business Entities (4ykn-tg5h): a company formed in
//                           the last 36 months whose registered agent is the
//                           contact, with its principal office in one of her
//                           counties' towns. Dated by entityformdate.
//   entity_dissolved        Business Entity Transaction History (casm-dbbj): a
//                           dissolution or withdrawal filed on a company whose
//                           agent is the contact. Dated by its effective date.
//   trade_name_new_address  Trade Names (u7sb-g482): a trade name the contact
//                           registered, in her towns, at an address that is
//                           not any address on file for them. Dated by its
//                           effective date. With no address on file there is
//                           nothing to call "new", and no signal is made.
//
// A match is exact first name AND surname on the record's person fields, in
// her towns. The name is identity, never a signal in itself.

import { addressKey, contactNameKey } from './deed-signals.ts';
import { shortDate } from './crm-signals.ts';
import type { Signal } from './types.ts';

export interface SosEntityRow {
  entityid: string;
  entityname: string;
  entitystatus?: string | null;
  entityformdate?: string | null;
  principalcity?: string | null;
  principalstate?: string | null;
  agentfirstname?: string | null;
  agentlastname?: string | null;
}

export interface SosHistoryRow {
  entityid: string;
  historydes?: string | null;
  effectivedate?: string | null;
  receiveddate?: string | null;
  transactionid?: string | null;
}

export interface TradeNameRow {
  mastertradenameid: string;
  tradenamedescription?: string | null;
  firstname?: string | null;
  lastname?: string | null;
  address1?: string | null;
  city?: string | null;
  state?: string | null;
  effectivedate?: string | null;
}

export const SOS_ENTITY_URL = (id: string) => `https://data.colorado.gov/resource/4ykn-tg5h.json?entityid=${encodeURIComponent(id)}`;
export const SOS_HISTORY_URL = (id: string) => `https://data.colorado.gov/resource/casm-dbbj.json?entityid=${encodeURIComponent(id)}`;
export const TRADE_NAME_URL = (id: string) => `https://data.colorado.gov/resource/u7sb-g482.json?mastertradenameid=${encodeURIComponent(id)}`;

/**
 * The filings that end a company, read off the dataset's own descriptions on
 * 23 Sep 2026: "Dissolve a Limited Liability Company", "Dissolve a Profit
 * Corporation", "Dissolve an Entity", "Dissolution of Delinquent Entity",
 * "Withdraw Foreign Entity Authority" and the like. Anchored at the start, so
 * a trade name renewal "of a Dissolved or Delinquent Reporting Entity" is not
 * read as one.
 */
const DISSOLVED = /^(dissolve\b|dissolution of|intent to dissolve|withdraw foreign entity|withdrawal of a foreign entity)/i;

function day(v: string | null | undefined): string {
  return (v ?? '').slice(0, 10);
}

function threeYearsBefore(today: string): string {
  return `${Number(today.slice(0, 4)) - 3}${today.slice(4)}`;
}

function personKey(first: string | null | undefined, last: string | null | undefined): string {
  return contactNameKey({ first_name: first ?? null, last_name: last ?? null });
}

function inTowns(city: string | null | undefined, state: string | null | undefined, towns: ReadonlySet<string>): boolean {
  return (state ?? '').toUpperCase() === 'CO' && towns.has((city ?? '').trim().toUpperCase());
}

export interface SosSignalInput {
  contact: { first_name: string | null; last_name: string | null };
  /** Every address on file for the contact (street lines). */
  addresses: readonly string[];
  entities: readonly SosEntityRow[];
  history: readonly SosHistoryRow[];
  tradeNames: readonly TradeNameRow[];
  /** Upper-case town names of her counties. */
  towns: ReadonlySet<string>;
  today: string;
}

export function sosSignals(inp: SosSignalInput): Signal[] {
  const key = contactNameKey(inp.contact);
  if (!key) return [];
  const since = threeYearsBefore(inp.today);
  const out: Signal[] = [];
  const mine = inp.entities.filter((e) => personKey(e.agentfirstname, e.agentlastname) === key && inTowns(e.principalcity, e.principalstate, inp.towns));

  for (const e of mine) {
    const formed = day(e.entityformdate);
    if (formed && formed >= since && formed <= inp.today) {
      out.push({
        kind: 'entity_formed', source: 'sos', date: formed, ref: `sos entity ${e.entityid}`, url: SOS_ENTITY_URL(e.entityid),
        detail: `${e.entityname} formed ${shortDate(formed)} with them as registered agent (Colorado SOS).`,
      });
    }
  }
  const byId = new Map(mine.map((e) => [e.entityid, e]));
  for (const h of inp.history) {
    const e = byId.get(h.entityid);
    if (!e || !DISSOLVED.test(h.historydes ?? '')) continue;
    const d = day(h.effectivedate) || day(h.receiveddate);
    if (!d || d < since || d > inp.today) continue;
    out.push({
      kind: 'entity_dissolved', source: 'sos', date: d, ref: `sos entity ${e.entityid}${h.transactionid ? ` txn ${h.transactionid}` : ''}`, url: SOS_HISTORY_URL(e.entityid),
      detail: `${e.entityname}: ${String(h.historydes ?? 'dissolution').trim()} filed ${shortDate(d)} (Colorado SOS).`,
    });
  }
  const onFile = new Set(inp.addresses.map(addressKey).filter(Boolean));
  if (onFile.size > 0) {
    for (const t of inp.tradeNames) {
      if (personKey(t.firstname, t.lastname) !== key || !inTowns(t.city, t.state, inp.towns)) continue;
      const d = day(t.effectivedate);
      const a = addressKey(t.address1);
      if (!d || d < since || d > inp.today || !a || onFile.has(a)) continue;
      out.push({
        kind: 'trade_name_new_address', source: 'sos', date: d, ref: `sos trade name ${t.mastertradenameid}`, url: TRADE_NAME_URL(t.mastertradenameid),
        detail: `Trade name ${t.tradenamedescription ? `"${t.tradenamedescription}" ` : ''}registered ${shortDate(d)} at ${t.address1}, ${t.city} (Colorado SOS).`,
      });
    }
  }
  return out;
}
