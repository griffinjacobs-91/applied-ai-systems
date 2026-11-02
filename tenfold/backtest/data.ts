// Data layer: pull daily bars for the whole US stock universe from the Massive
// (formerly Polygon) feed and cache them on disk so reruns are free.
//
// One call per trading day to the grouped-daily endpoint returns every ticker
// that traded that day, which means the cache is inherently survivorship-free:
// a company that delisted in 2023 is still in the 2022 and 2023 files.
//
// The key is read from ~/Projects/tenfold/.env. It is never printed.

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CACHE = join(HERE, 'cache');
const GROUPED = join(CACHE, 'grouped');
const GROUPED_RAW = join(CACHE, 'grouped-raw');
const TICKERS = join(CACHE, 'tickers');

// ---------------------------------------------------------------- key / env

function loadEnv(): Record<string, string> {
  const path = join(HERE, '..', '.env');
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

let KEY: string | null = null;
function apiKey(): string {
  if (KEY) return KEY;
  KEY = process.env.MASSIVE_API_KEY || loadEnv().MASSIVE_API_KEY || '';
  if (!KEY) throw new Error('MASSIVE_API_KEY not found in env or .env');
  return KEY;
}

const BASE = 'https://api.polygon.io';

/** Count of live HTTP calls made in this process. Reported in the run log. */
export let apiCalls = 0;

async function get(url: string, tries = 5): Promise<any> {
  for (let attempt = 1; attempt <= tries; attempt++) {
    apiCalls++;
    let res: Response;
    try {
      res = await fetch(url + (url.includes('?') ? '&' : '?') + 'apiKey=' + apiKey());
    } catch (e) {
      if (attempt === tries) throw e;
      await sleep(1000 * attempt);
      continue;
    }
    if (res.status === 429) { await sleep(3000 * attempt); continue; }
    if (res.status === 403) {
      const body = await res.text();
      const err: any = new Error('NOT_AUTHORIZED: ' + body.slice(0, 200));
      err.status = 403;
      throw err;
    }
    if (!res.ok) {
      if (attempt === tries) throw new Error(`HTTP ${res.status} for ${redact(url)}`);
      await sleep(1000 * attempt);
      continue;
    }
    return res.json();
  }
  throw new Error('unreachable');
}

const redact = (u: string) => u.replace(/apiKey=[^&]*/, 'apiKey=***');
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------- types

/** One daily bar. Prices are split/dividend adjusted by the feed. */
export type Bar = { o: number; h: number; l: number; c: number; v: number };
/** A whole trading day: ticker -> bar. */
export type DayBars = Map<string, Bar>;

export type TickerMeta = { type: string | null; name: string };

// ------------------------------------------------------- grouped daily bars

const gpath = (date: string) => join(GROUPED, date + '.json.gz');

/** True if this date has already been pulled (holiday files are cached too). */
export const haveGrouped = (date: string) => existsSync(gpath(date));

/**
 * Pull one trading day's bars for every US stock. Cached. Returns null for a
 * market holiday (the feed answers 200 with zero results).
 */
export async function grouped(date: string, allowFetch = true): Promise<DayBars | null> {
  if (!existsSync(gpath(date))) {
    if (!allowFetch) return null;
    const j = await get(`${BASE}/v2/aggs/grouped/locale/us/market/stocks/${date}?adjusted=true`);
    // Store a slimmed copy: ticker + OHLCV only. That is every field the
    // backtest uses, and it keeps the cache to a few hundred MB.
    const slim = (j.results || []).map((r: any) => [r.T, r.o, r.h, r.l, r.c, r.v]);
    mkdirSync(GROUPED, { recursive: true });
    writeFileSync(gpath(date), gzipSync(Buffer.from(JSON.stringify(slim))));
  }
  const rows: [string, number, number, number, number, number][] = JSON.parse(
    gunzipSync(readFileSync(gpath(date))).toString('utf8'),
  );
  if (rows.length === 0) return null; // holiday / weekend
  const m: DayBars = new Map();
  for (const [t, o, h, l, c, v] of rows) m.set(t, { o, h, l, c, v });
  return m;
}

/** Every date already in the grouped cache that actually has bars, sorted. */
export function cachedTradingDays(from: string, to: string): string[] {
  if (!existsSync(GROUPED)) return [];
  const out: string[] = [];
  for (const f of readdirSync(GROUPED)) {
    if (!f.endsWith('.json.gz')) continue;
    const d = f.slice(0, 10);
    if (d < from || d > to) continue;
    // A holiday file is the two-byte gzip of "[]"; check cheaply by size first.
    const raw = gunzipSync(readFileSync(join(GROUPED, f))).toString('utf8');
    if (raw.length > 2) out.push(d);
  }
  return out.sort();
}

// ------------------------------------------------- unadjusted (raw) bars
//
// B4: the $2 price floor and the 500k volume floor are the trader's real-time
// decision, so they must read the price and volume that actually printed. The
// adjusted feed rewrites the past with later splits, which lets a 2023 penny
// stock that reverse-split in 2025 clear a $2 floor it never cleared at the
// time. This second pull stores close and volume only, unadjusted; every
// return, indicator and fill still comes from the adjusted bars above.

/** One unadjusted day: ticker -> { c, v } as printed. */
export type RawDay = Map<string, { c: number; v: number }>;

const rpath = (date: string) => join(GROUPED_RAW, date + '.json.gz');
export const haveGroupedRaw = (date: string) => existsSync(rpath(date));

export async function groupedRaw(date: string, allowFetch = true): Promise<RawDay | null> {
  if (!existsSync(rpath(date))) {
    if (!allowFetch) return null;
    const j = await get(`${BASE}/v2/aggs/grouped/locale/us/market/stocks/${date}?adjusted=false`);
    const slim = (j.results || []).map((r: any) => [r.T, r.c, r.v]);
    mkdirSync(GROUPED_RAW, { recursive: true });
    writeFileSync(rpath(date), gzipSync(Buffer.from(JSON.stringify(slim))));
  }
  const rows: [string, number, number][] = JSON.parse(
    gunzipSync(readFileSync(rpath(date))).toString('utf8'),
  );
  if (rows.length === 0) return null;
  const m: RawDay = new Map();
  for (const [t, c, v] of rows) m.set(t, { c, v });
  return m;
}

/** How many unadjusted day files are on disk in the window. */
export function cachedRawDays(from: string, to: string): string[] {
  if (!existsSync(GROUPED_RAW)) return [];
  const out: string[] = [];
  for (const f of readdirSync(GROUPED_RAW)) {
    if (!f.endsWith('.json.gz')) continue;
    const d = f.slice(0, 10);
    if (d >= from && d <= to) out.push(d);
  }
  return out.sort();
}

// -------------------------------------------------------------- dividends

const DIVS = join(CACHE, 'dividends');

/** Cash dividends for one ticker, ex-date ascending. Cached per ticker. */
export async function dividends(ticker: string): Promise<{ ex: string; amount: number }[]> {
  const path = join(DIVS, ticker + '.json');
  if (!existsSync(path)) {
    const out: { ex: string; amount: number }[] = [];
    let url: string | null = `${BASE}/v3/reference/dividends?ticker=${ticker}&limit=1000`;
    while (url) {
      const j: any = await get(url);
      for (const r of j.results || []) {
        if (r.ex_dividend_date && typeof r.cash_amount === 'number') {
          out.push({ ex: r.ex_dividend_date, amount: r.cash_amount });
        }
      }
      url = j.next_url || null;
      if (url) await sleep(60);
    }
    out.sort((a, b) => a.ex.localeCompare(b.ex));
    mkdirSync(DIVS, { recursive: true });
    writeFileSync(path, JSON.stringify(out));
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

// --------------------------------------------------------- ticker reference

const tpath = (date: string) => join(TICKERS, date + '.json.gz');

/**
 * The feed's ticker list AS OF a past date, so type and name reflect what was
 * listed then rather than what survives today. Paginated 1000 at a time.
 */
export async function tickerRef(date: string): Promise<Map<string, TickerMeta>> {
  if (!existsSync(tpath(date))) {
    const all: [string, string | null, string][] = [];
    let url: string | null =
      `${BASE}/v3/reference/tickers?market=stocks&active=true&date=${date}&limit=1000`;
    while (url) {
      const j: any = await get(url);
      for (const r of j.results || []) all.push([r.ticker, r.type ?? null, r.name || '']);
      url = j.next_url || null;
      if (url) await sleep(60);
    }
    mkdirSync(TICKERS, { recursive: true });
    writeFileSync(tpath(date), gzipSync(Buffer.from(JSON.stringify(all))));
  }
  const rows: [string, string | null, string][] = JSON.parse(
    gunzipSync(readFileSync(tpath(date))).toString('utf8'),
  );
  const m = new Map<string, TickerMeta>();
  for (const [t, type, name] of rows) m.set(t, { type, name });
  return m;
}

// ----------------------------------------------------------- calendar utils

/** Every weekday between two dates inclusive, ISO strings. */
export function weekdays(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (d <= end) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/**
 * Tier probe. One request for a 2022 trading day. Starter and above answer
 * 200; the free tier answers 403 NOT_AUTHORIZED. Returns the window the
 * backtest is entitled to run over.
 */
export async function checkTier(): Promise<{ tier: 'starter+' | 'free'; from: string; to: string }> {
  try {
    await get(`${BASE}/v2/aggs/grouped/locale/us/market/stocks/2022-09-01?adjusted=true`);
    return { tier: 'starter+', from: '2022-09-01', to: '2026-09-05' };
  } catch (e: any) {
    if (e.status === 403) return { tier: 'free', from: '2024-09-09', to: '2026-09-05' };
    throw e;
  }
}
