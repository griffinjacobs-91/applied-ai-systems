// realtor/propensity/pdl — People Data Labs person enrichment, business
// contacts only. The request builder and the parser are pure; the call is
// made by the run script, which owns the budget.
//
// WHO IS ASKED. Only a contact with a business email (a domain that is not a
// free mailbox) or a company on file: those are the people PDL is built to
// match, and nobody else is sent. PDL bills per match (a 404 is free), and
// min_likelihood keeps a weak guess from coming back as a match at all.
//
// WHAT IS ASKED FOR. data_include is PDL_FIELDS_USED (fair-housing.ts): the
// current job title, employer and its start date, the date PDL saw the job
// change, and the town, region and date of the location. Nothing else is
// requested, so nothing else is received, and only those fields are stored.
//
// WHAT BECOMES A SIGNAL, each dated by PDL's own date:
//   employer_change  a job started in the last 36 months at a company that is
//                    not the company on file.
//   job_change       a job started in the last 36 months otherwise.
//   location_change  PDL's location, updated in the last 36 months, is a town
//                    outside her counties and not the town on file.

import { PDL_FIELDS_USED } from './fair-housing.ts';
import { shortDate } from './crm-signals.ts';
import type { Signal } from './types.ts';

export const PDL_ENRICH_URL = 'https://api.peopledatalabs.com/v5/person/enrich';
export const PDL_MIN_LIKELIHOOD = 6;

/** Pro plan, read from https://www.peopledatalabs.com/pricing/person on 23 Sep 2026: $98 a month for 350 credits. */
export const PDL_USD_PER_MATCH = 0.28;

const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'comcast.net', 'msn.net', 'protonmail.com', 'proton.me', 'gmx.com',
  'att.net', 'sbcglobal.net', 'bellsouth.net', 'charter.net', 'cox.net', 'verizon.net', 'q.com', 'centurylink.net',
  'bresnan.net', 'earthlink.net', 'juno.com', 'mail.com', 'zoho.com', 'yahoo.co.uk', 'rocketmail.com', 'frontier.com',
  'spectrum.net', 'hughes.net', 'kw.com',
]);

/** A domain PDL can match a person at work by: not a free mailbox, not her brokerage's shared domain. */
export function isBusinessEmail(email: string | null | undefined): boolean {
  const m = /^[^@\s]+@([^@\s]+\.[a-z]{2,})$/i.exec((email ?? '').trim());
  return !!m && !FREE_MAIL.has(m[1].toLowerCase());
}

export interface PdlCandidate {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  company: string | null;
  title: string | null;
  city: string | null;
}

export function pdlEligible(c: PdlCandidate): boolean {
  if (!c.first_name || !c.last_name) return false;
  return isBusinessEmail(c.email) || !!(c.company ?? '').trim();
}

/** The query string for one contact. The key goes in the X-Api-Key header, never the URL. */
export function pdlQuery(c: PdlCandidate): string {
  const q = new URLSearchParams();
  if (isBusinessEmail(c.email)) q.set('email', c.email!.trim().toLowerCase());
  q.set('first_name', c.first_name ?? '');
  q.set('last_name', c.last_name ?? '');
  if ((c.company ?? '').trim()) q.set('company', c.company!.trim());
  q.set('region', 'colorado');
  q.set('min_likelihood', String(PDL_MIN_LIKELIHOOD));
  q.set('data_include', PDL_FIELDS_USED.join(','));
  return `${PDL_ENRICH_URL}?${q}`;
}

/** Only the fields used, from a 200 body. Anything else PDL sent is dropped here. */
export function pdlKept(body: unknown): Record<string, string | null> {
  const data = (body && typeof body === 'object' ? (body as Record<string, unknown>).data : null) as Record<string, unknown> | null;
  const out: Record<string, string | null> = {};
  for (const f of PDL_FIELDS_USED) {
    const v = data?.[f];
    out[f] = typeof v === 'string' && v.trim() ? v.trim() : null;
  }
  return out;
}

/** "2024-05" or "2024" to a day; PDL dates are often month or year precision. */
export function pdlDay(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-01`;
  return null; // a bare year is too coarse to date a change by
}

function norm(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/\b(inc|llc|ltd|co|corp|corporation|company|the)\b/g, '').replace(/[^a-z0-9]+/g, '');
}

export function pdlSignals(args: {
  contact: PdlCandidate;
  kept: Record<string, string | null>;
  likelihood: number | null;
  towns: ReadonlySet<string>;
  today: string;
}): Signal[] {
  const { contact: c, kept: k, today } = args;
  const since = `${Number(today.slice(0, 4)) - 3}${today.slice(4)}`;
  const out: Signal[] = [];
  const ref = `pdl enrich likelihood ${args.likelihood ?? '?'}`;

  const started = pdlDay(k.job_start_date) ?? pdlDay(k.job_last_changed);
  if (started && started >= since && started <= today && (k.job_company_name || k.job_title)) {
    const differs = !!(c.company && k.job_company_name && norm(c.company) !== norm(k.job_company_name));
    out.push({
      kind: differs ? 'employer_change' : 'job_change',
      source: 'pdl',
      date: started,
      ref,
      url: null,
      detail: differs
        ? `Started at ${k.job_company_name} around ${shortDate(started)}; on file: ${c.company} (People Data Labs).`
        : `Started ${k.job_title ? `as ${k.job_title}` : 'a new role'}${k.job_company_name ? ` at ${k.job_company_name}` : ''} around ${shortDate(started)} (People Data Labs).`,
      payload: { job_title: k.job_title, job_company_name: k.job_company_name, job_start_date: k.job_start_date, job_last_changed: k.job_last_changed },
    });
  }

  const moved = pdlDay(k.location_last_updated);
  const town = (k.location_locality ?? '').trim();
  if (moved && moved >= since && moved <= today && town) {
    const up = town.toUpperCase();
    if (!args.towns.has(up) && up !== (c.city ?? '').trim().toUpperCase()) {
      out.push({
        kind: 'location_change',
        source: 'pdl',
        date: moved,
        ref,
        url: null,
        detail: `People Data Labs places them in ${town}${k.location_region ? `, ${k.location_region}` : ''} as of ${shortDate(moved)}.`,
        payload: { location_locality: k.location_locality, location_region: k.location_region, location_last_updated: k.location_last_updated },
      });
    }
  }
  return out;
}
