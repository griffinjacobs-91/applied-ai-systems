// realtor/propensity/sizing — how many of her contacts fall in each research
// tier, and what researching each tier would cost, BEFORE anything is run.
// Pure. Griffin, 23 Sep: "let's not run the research and scoring for every
// single contact that is added, at least not until I know how many people are
// being added." This is the page he decides the first batch from.
//
// PRICES, each read from its provider on 23 Sep 2026:
//   Firecrawl  search about 2 credits per call of up to 10 results, scrape 1
//              credit (measured on the builder-relationships run: 147 searches
//              and 41 scrapes used 322 credits). Plan: 5,000 credits a month.
//   PDL        $0.28 a match on Pro ($98 for 350 credits, peopledatalabs.com/
//              pricing/person); a no-match (404) is free. Free plan: 100 a month.
//   Model      Haiku 4.5 at $1 / $5 per million tokens in / out (models.ts):
//              about 400 in and 60 out per worded line, twice on a retry;
//              about 1,500 in and 250 out to read one contact's search results.
//   County, SOS  free public feeds, no key, no charge.

import { isBusinessEmail } from './pdl.ts';
import { notePlans } from './crm-signals.ts';
import type { ContactRows } from './recompute.ts';

export const COST = {
  firecrawlCreditsPerSearch: 2,
  firecrawlCreditsPerScrape: 1,
  scrapesPerContact: 1,
  pdlUsdPerMatch: 0.28,
  wordUsdPerContact: 2 * ((400 * 1 + 60 * 5) / 1_000_000),
  webReadUsdPerContact: (1500 * 1 + 250 * 5) / 1_000_000,
} as const;

export interface SizingContact {
  rows: ContactRows;
  kind: string | null;
  email: string | null;
  emails: readonly string[];
  company: string | null;
  scorable: boolean;
}

export interface Tier {
  key: string;
  label: string;
  count: number;
  firecrawlCredits: number;
  pdlUsdIfAllMatch: number;
  modelUsd: number;
  note: string;
}

export interface Sizing {
  contacts: number;
  scorable: number;
  pastClientsWithClosing: number;
  businessEmailOrCompany: number;
  propertyWithPurchaseDate: number;
  ownedAddressNoDate: number;
  homeBought4to10: number;
  datedPlanNotes: number;
  tiers: Tier[];
}

function yearsBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  let y = ty - fy;
  if (tm < fm || (tm === fm && td < fd)) y -= 1;
  return y;
}

function purchaseDate(r: ContactRows, today: string): string | null {
  const mine = r.txs.filter((t) => (t.lead_id === r.crm.id || (!!r.deed.household_id && t.household_id === r.deed.household_id)) && t.ours && (t.side === 'buy' || t.side === 'both') && t.close_date && t.close_date.slice(0, 10) <= today && !t.fell_through_date);
  return mine.map((t) => (t.close_date ?? '').slice(0, 10)).sort().pop() ?? null;
}

function hasClosing(r: ContactRows, today: string): boolean {
  return r.txs.some((t) => (t.lead_id === r.crm.id || (!!r.deed.household_id && t.household_id === r.deed.household_id)) && t.ours && !!t.close_date && t.close_date.slice(0, 10) <= today && !t.fell_through_date);
}

function hasDatedPlan(r: ContactRows): boolean {
  if (notePlans(r.crm.notes, null).plans.length > 0) return true;
  return r.touches.some((t) => t.status !== 'drafted' && t.status !== 'skipped' && notePlans([t.subject ?? '', t.body ?? ''].join('\n'), (t.sent_at ?? t.created_at).slice(0, 10)).plans.length > 0);
}

function tier(key: string, label: string, count: number, parts: { web?: boolean; pdl?: boolean; word?: boolean }, note: string): Tier {
  const web = parts.web ? count : 0;
  return {
    key,
    label,
    count,
    firecrawlCredits: web * (COST.firecrawlCreditsPerSearch + COST.scrapesPerContact * COST.firecrawlCreditsPerScrape),
    pdlUsdIfAllMatch: Math.round((parts.pdl ? count : 0) * COST.pdlUsdPerMatch * 100) / 100,
    modelUsd: Math.round(((parts.word ? count * COST.wordUsdPerContact : 0) + web * COST.webReadUsdPerContact) * 1000) / 1000,
    note,
  };
}

export function sizeBook(contacts: readonly SizingContact[], today: string): Sizing {
  const s = contacts.filter((c) => c.scorable);
  const past = s.filter((c) => hasClosing(c.rows, today));
  const biz = s.filter((c) => isBusinessEmail(c.email) || c.emails.some((e) => isBusinessEmail(e)) || !!(c.company ?? '').trim());
  const dated = s.filter((c) => purchaseDate(c.rows, today));
  const ownedNoDate = s.filter((c) => !purchaseDate(c.rows, today) && c.rows.links.some((l) => l.relation === 'owns'));
  const band = s.filter((c) => {
    const d = purchaseDate(c.rows, today);
    if (!d) return false;
    const y = yearsBetween(d, today);
    return y >= 4 && y <= 10;
  });
  const plans = s.filter((c) => hasDatedPlan(c.rows));
  const firstBatchIds = new Set([...band, ...plans].map((c) => c.rows.crm.id));
  const firstBatch = s.filter((c) => firstBatchIds.has(c.rows.crm.id));
  const firstBiz = firstBatch.filter((c) => biz.includes(c));

  const tiers: Tier[] = [
    tier('free', 'Everyone, free signals only (her CRM and her closings)', s.length, {}, 'No outside call. Already computed and shown.'),
    tier('county', 'County deeds and Colorado SOS for everyone', s.length, {}, 'Free public feeds; no charge, about 30 requests for the whole book.'),
    tier('word_all', 'A worded line for every scored contact', s.length, { word: true }, 'Model only; capped at $2 a run.'),
    tier('first_batch', 'Recommended first batch: home bought 4 to 10 years ago, or a dated plan in her notes', firstBatch.length, { word: true }, 'County, SOS and wording; web and PDL only for the business contacts inside it (next row).'),
    tier('first_batch_business', 'Inside the first batch, business email or company on file', firstBiz.length, { web: true, pdl: true }, 'Web search plus PDL, the only contacts PDL is built to match.'),
    tier('business_all', 'Every business-email or company contact', biz.length, { web: true, pdl: true, word: true }, 'Web search, PDL and wording for all of them.'),
  ];

  return {
    contacts: contacts.length,
    scorable: s.length,
    pastClientsWithClosing: past.length,
    businessEmailOrCompany: biz.length,
    propertyWithPurchaseDate: dated.length,
    ownedAddressNoDate: ownedNoDate.length,
    homeBought4to10: band.length,
    datedPlanNotes: plans.length,
    tiers,
  };
}
