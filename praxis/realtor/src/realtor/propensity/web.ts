// realtor/propensity/web — public web evidence, read through Firecrawl, and
// the check every model-read event must pass. Pure: the run script makes the
// Firecrawl and model calls; this file decides which pages may be read and
// which extracted events stand.
//
// THE METHOD (the builder-relationships run of 23 Sep, made stricter): code
// writes the search, Firecrawl returns public results, a model reads the
// titles and snippets and proposes dated events, and CODE keeps an event only
// when:
//   - its page is on an allowed site (never a listing portal, never anything
//     behind a login: ALLOWED is checked on every url);
//   - its quote is found, word for word, in that page's own title, snippet
//     or scraped text;
//   - its date is written in that quote or on that page, and falls in the
//     last 36 months (a month and year dates to the 1st);
//   - it is one of WEB_KINDS, and names nothing in fair-housing.ts's list;
//   - a "for sale by owner" or "coming soon" note is on THEIR OWN site (the
//     domain of their business email or website on file), never anyone
//     else's page about them.
// Everything else is dropped and counted. The model never supplies a number
// or a date that is not on the page.

import { PROMPT_PROHIBITION, protectedTermIn } from './fair-housing.ts';
import { dateInText, shortDate } from './crm-signals.ts';
import type { Signal, SignalKind } from './types.ts';

/** Hosts never read: listing portals, brokerage listing search, and login-walled apps. */
export const BLOCKED_HOSTS: readonly string[] = [
  'zillow.com', 'redfin.com', 'realtor.com', 'homes.com', 'trulia.com', 'movoto.com', 'compass.com', 'coldwellbanker.com',
  'coldwellbankerhomes.com', 'kw.com', 'kwrealty.com', 'remax.com', 'century21.com', 'homesnap.com', 'har.com', 'estately.com',
  'homelight.com', 'opendoor.com', 'offerpad.com', 'loopnet.com', 'crexi.com', 'landwatch.com', 'land.com', 'landsofamerica.com',
  'apartments.com', 'rent.com', 'hotpads.com', 'zumper.com', 'craigslist.org', 'nextdoor.com', 'whitepages.com', 'spokeo.com',
  'beenverified.com', 'truepeoplesearch.com', 'fastpeoplesearch.com', 'radaris.com', 'mylife.com', 'intelius.com',
  'peoplefinders.com', 'thatsthem.com', 'clustrmaps.com', 'idcrawl.com', 'ancestry.com', 'legacy.com', 'findagrave.com',
];

/** Social sites: their public search snippets may be read, their pages are never scraped. */
export const SNIPPET_ONLY_HOSTS: readonly string[] = ['facebook.com', 'instagram.com', 'linkedin.com', 'x.com', 'twitter.com', 'tiktok.com'];

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function onHost(host: string, list: readonly string[]): boolean {
  return list.some((h) => host === h || host.endsWith(`.${h}`));
}

/** May this result be used at all? MLS/IDX search pages on any brokerage site are refused too. */
export function isAllowedUrl(url: string): boolean {
  const host = hostOf(url);
  if (!host || !/^https?:/i.test(url)) return false;
  if (onHost(host, BLOCKED_HOSTS)) return false;
  if (/\/(idx|mls|listings?|homes-for-sale|property-search|search\/results)(\/|\?|$)/i.test(url)) return false;
  if (/\b(login|signin|sign-in|account)\b/i.test(new URL(url).pathname)) return false;
  return true;
}

export function mayScrape(url: string): boolean {
  return isAllowedUrl(url) && !onHost(hostOf(url), SNIPPET_ONLY_HOSTS);
}

/** Kinds a web page may support. */
export const WEB_KINDS: readonly SignalKind[] = ['business_opened', 'business_moved', 'business_closed', 'job_change', 'relocation_public', 'fsbo_own_page'];

export interface WebPage {
  url: string;
  title: string;
  /** Snippet, plus scraped text when the page was scraped. */
  text: string;
}

export interface WebEventClaim {
  kind: string;
  url: string;
  quote: string;
  date_text?: string;
}

export const WEB_EXTRACT_SYSTEM = [
  'You read public web search results about one person and their business, for a real estate agent who knows them.',
  'Find only these events, and only when a result states them: business_opened, business_moved (the business moved to a new address or town),',
  'business_closed, job_change (they took a new job or role), relocation_public (they are moving or moved to another town),',
  'fsbo_own_page (their own site says their home is for sale by owner or coming soon).',
  'Each event needs the url of the result it is in, a quote copied WORD FOR WORD from that result, and the date as written in that result.',
  'Skip any event with no date written in the result. Skip anything about a different person with the same name.',
  PROMPT_PROHIBITION,
  'Return only JSON: {"events": [{"kind": "...", "url": "...", "quote": "...", "date_text": "..."}]}. No events: {"events": []}.',
].join('\n');

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** A day from written text: a full date, or a month and year (the 1st). */
export function webDate(text: string): string | null {
  const full = dateInText(text);
  if (full) return full;
  const m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})\b/i.exec(text);
  if (m) return `${m[2]}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, '0')}-01`;
  return null;
}

function squash(s: string): string {
  return s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
}

const DETAIL: Record<string, string> = {
  business_opened: 'Public page: business opened',
  business_moved: 'Public page: business moved',
  business_closed: 'Public page: business closed',
  job_change: 'Public page: new job or role',
  relocation_public: 'Public page: relocation',
  fsbo_own_page: 'Their own site: home for sale or coming soon',
};

export interface WebCheck {
  signals: Signal[];
  refused: Array<{ why: string; url: string }>;
}

/** Keep only the model's events that the pages themselves prove. */
export function checkWebEvents(args: {
  claims: readonly WebEventClaim[];
  pages: readonly WebPage[];
  ownDomains: readonly string[];
  today: string;
}): WebCheck {
  const out: WebCheck = { signals: [], refused: [] };
  const since = `${Number(args.today.slice(0, 4)) - 3}${args.today.slice(4)}`;
  const byUrl = new Map(args.pages.map((p) => [p.url, p]));
  const own = new Set(args.ownDomains.map((d) => d.toLowerCase().replace(/^www\./, '')));
  const seen = new Set<string>();
  for (const c of args.claims) {
    const url = String(c.url ?? '');
    const page = byUrl.get(url);
    const quote = String(c.quote ?? '').trim();
    if (!WEB_KINDS.includes(c.kind as SignalKind)) { out.refused.push({ why: 'kind', url }); continue; }
    if (!page) { out.refused.push({ why: 'url not in results', url }); continue; }
    if (!isAllowedUrl(url)) { out.refused.push({ why: 'site not allowed', url }); continue; }
    if (quote.length < 12 || !squash(`${page.title}\n${page.text}`).includes(squash(quote))) { out.refused.push({ why: 'quote not on page', url }); continue; }
    if (protectedTermIn(quote)) { out.refused.push({ why: 'protected term', url }); continue; }
    const d = webDate(quote) ?? (c.date_text && squash(`${page.title}\n${page.text}`).includes(squash(c.date_text)) ? webDate(c.date_text) : null);
    if (!d || d < since || d > args.today) { out.refused.push({ why: 'no date on page in the last 36 months', url }); continue; }
    if (c.kind === 'fsbo_own_page' && !own.has(hostOf(url))) { out.refused.push({ why: 'sale note not on their own site', url }); continue; }
    const k = `${c.kind}|${url}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.signals.push({
      kind: c.kind as SignalKind,
      source: 'web',
      date: d,
      ref: hostOf(url),
      url,
      detail: `${DETAIL[c.kind]}, dated ${shortDate(d)} (${hostOf(url)}).`,
      payload: { quote: quote.slice(0, 300) },
    });
  }
  return out;
}

/** The one search per contact: name and company, near her towns. */
export function webQuery(c: { first_name: string | null; last_name: string | null; company: string | null; city: string | null }): string {
  const name = `"${[c.first_name, c.last_name].filter(Boolean).join(' ')}"`;
  const co = (c.company ?? '').trim() ? ` "${c.company!.trim()}"` : '';
  const where = (c.city ?? '').trim() || 'Grand Junction';
  return `${name}${co} ${where} Colorado`;
}
