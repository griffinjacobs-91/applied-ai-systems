// The book simulation. Loads the cached bars, builds the universe, walks the
// calendar one day at a time and applies the owner's rules exactly as written.
//
// Book rules simulated (rules doc sections 1 and 2, backtest shape from the
// session brief):
//   $10,000 start, $1,000 per pick, up to 10 open names.
//   Enter at the next open after the signal, whole shares only.
//   Stop at -12% from entry.
//   At +20%, sell half and trail the rest with an 8% trailing stop.
//   Exit on the reverse cross (a signal, so always a close test, next open).
//   No re-entry into a name sold at a loss for 30 days.
//   No margin. Commission zero. Slippage 0.1%, always against the book.
//
// Two fill models are run and reported side by side (SimOptions.fills):
//   'stated'  the rule as the owner said it: every exit is tested on the close and
//             filled at the next open.
//   'broker'  what a Schwab order actually does: the -12% stop and the +20%
//             trim are resting orders that trigger intraday, the 8% trail
//             likewise. The reverse cross stays a close test in both modes
//             because it is a signal, not an order.
//
// Fixes carried by this file, over the 7 September first run:
//   B1  a held name is force-closed on its last traded bar, not frozen at cost
//   B3  the broker fill model above
//   B4  the price and volume floors read UNADJUSTED bars
//   B5  the pre-filter is a memory bound only, not an eligibility test
//   B6  carried-flat bars are marked synthetic: no signal, no fill on them
//   B7  a symbol is broken into segments on a gap over 10 trading days
//   B16 whole shares, remainder stays in cash
//   B2  the candidate selection rule is an option, not a hard-coded sort
//   B12 slippage is an option and a participation cap can skip thin bars

import { grouped, groupedRaw, cachedTradingDays, tickerRef, weekdays } from './data.ts';
import {
  indicators, sma, stochastic, signalOn, reverseCrossOn,
  FAST, SLOW, STOCH, type Series, type Indicators,
} from './signal.ts';
import {
  MIN_AVG_VOLUME_20D, MIN_PRICE, ALLOWED_TYPES, isCryptoProxy,
} from './universe.ts';

export const START_CASH = 10_000;
export const PER_PICK = 1_000;
export const MAX_OPEN = 10;
export const STOP_PCT = 0.12;
export const TRIM_TRIGGER = 0.20;
export const TRAIL_PCT = 0.08;
export const SLIPPAGE = 0.001;
export const NO_REENTRY_DAYS = 30;
export const MARGIN_MULT = 1.5;
export const MARGIN_RATE = 0.11;

/** B7: a break longer than this many trading days ends a segment. */
export const SEGMENT_GAP_DAYS = 10;
/** B5: the pre-filter is a memory bound. A segment shorter than this cannot
 *  form a 30-day average plus a cross, so it can never fire. */
export const MIN_SEGMENT_BARS = 31;

// ------------------------------------------------------------------ loading

/**
 * One segment of one ticker's history. `synthetic[j]` marks a bar that did not
 * print: it is carried flat so the moving averages stay on the calendar, but
 * no signal is evaluated on it and no order fills on it (B6).
 *
 * `rawClose` and `rawVol` are the UNADJUSTED close and volume as they printed
 * that day, which is what the $2 and 500k floors have to read (B4). Every
 * return, indicator and fill uses the adjusted columns.
 */
export type PanelSeries = Series & {
  open: number[];
  synthetic: boolean[];
  rawClose: number[];
  rawVol: number[];
  avgVolRaw20: (number | null)[];
  dollarVol20: (number | null)[];
};

export type Entry = {
  /** TICKER#n. A recycled symbol is two different keys (B7). */
  key: string;
  ticker: string;
  seg: number;
  /** Global panel index of the segment's first real bar. */
  first: number;
  /** Global panel index of the segment's last real bar. */
  last: number;
  /** True when the segment ends before the panel does: the name stopped
   *  trading and the book must settle it on that last bar (B1). */
  delisted: boolean;
  s: PanelSeries;
  ind: Indicators;
};

export type Panel = {
  dates: string[];
  idx: Map<string, number>;
  keys: string[];
  series: Map<string, Entry>;
  meta: Map<string, { type: string | null; name: string }>;
  /** Carried-flat bars across the whole panel. */
  syntheticBars: number;
  /** Segments created by the gap rule beyond the first for each ticker. */
  extraSegments: number;
  segments: number;
  tickersWithSegments: number;
  /** B4: ticker-days where the unadjusted gate and the adjusted gate disagree. */
  eligibilityChanges: number;
  eligibilityGained: number;
  eligibilityLost: number;
  /** Unadjusted day files actually read. */
  rawDaysUsed: number;
  delistedSegments: number;
};

/**
 * B7: split a ticker's list of real bar indices into segments, breaking
 * wherever consecutive real bars are more than `gap` trading days apart. A
 * recycled symbol splices two companies into one series and manufactures
 * crosses across the join; each span returned is treated as its own company.
 */
export function segmentSpans(real: number[], gap: number): [number, number][] {
  const spans: [number, number][] = [];
  if (real.length === 0) return spans;
  let segStart = real[0];
  for (let k = 1; k < real.length; k++) {
    if (real[k] - real[k - 1] - 1 > gap) {
      spans.push([segStart, real[k - 1]]);
      segStart = real[k];
    }
  }
  spans.push([segStart, real[real.length - 1]]);
  return spans;
}

export async function loadPanel(from: string, to: string, log = console.log): Promise<Panel> {
  const dates = cachedTradingDays(from, to);
  if (dates.length === 0) throw new Error(`no cached bars in ${from}..${to}; run backtest/pull.ts`);
  const idx = new Map(dates.map((d, i) => [d, i]));
  const N = dates.length;

  // Listing type and name, from the monthly reference snapshots.
  const meta = new Map<string, { type: string | null; name: string }>();
  const months = [...new Set(dates.map((d) => d.slice(0, 7)))].sort();
  for (const m of months) {
    const refDate = weekdays(m + '-01', m + '-07')[0];
    let ref: Map<string, { type: string | null; name: string }>;
    try { ref = await tickerRef(refDate); } catch { continue; }
    for (const [t, v] of ref) if (!meta.has(t)) meta.set(t, v);
  }
  log(`  reference: ${meta.size} tickers across ${months.length} monthly snapshots`);

  // Pass one (B5): the pre-filter's only job is to bound memory. A ticker is
  // carried if it cleared the per-day floor on ANY single day, read on the
  // UNADJUSTED bars. The real eligibility test is the per-day gate inside
  // simulate, which only ever looks backward.
  const carry = new Set<string>();
  let rawDaysUsed = 0;
  for (const d of dates) {
    const day = await grouped(d, false);
    if (!day) continue;
    const raw = await groupedRaw(d, false);
    if (raw) rawDaysUsed++;
    for (const [t, b] of day) {
      if (carry.has(t)) continue;
      const m = meta.get(t);
      if (!m || !ALLOWED_TYPES.has(m.type ?? '')) continue;
      if (isCryptoProxy(t, m.name)) continue;
      const r = raw?.get(t);
      const c = r ? r.c : b.c;
      const v = r ? r.v : b.v;
      // The per-day floor is close > $2 and a 20-day average volume over 500k;
      // a single day cannot see the average, so the day's own volume stands in.
      if (c > MIN_PRICE && v > MIN_AVG_VOLUME_20D) carry.add(t);
    }
  }
  log(`  universe: ${carry.size} tickers cleared the per-day floor at least once (unadjusted)`);

  // Pass two: dense columns for every carried ticker.
  type Col = {
    o: Float64Array; h: Float64Array; l: Float64Array; c: Float64Array; v: Float64Array;
    rc: Float64Array; rv: Float64Array; seen: Uint8Array; first: number; last: number;
  };
  const cols = new Map<string, Col>();
  for (const t of carry) {
    cols.set(t, {
      o: new Float64Array(N), h: new Float64Array(N), l: new Float64Array(N),
      c: new Float64Array(N), v: new Float64Array(N),
      rc: new Float64Array(N), rv: new Float64Array(N),
      seen: new Uint8Array(N), first: -1, last: -1,
    });
  }
  for (let i = 0; i < N; i++) {
    const day = await grouped(dates[i], false);
    if (!day) continue;
    const raw = await groupedRaw(dates[i], false);
    for (const [t, b] of day) {
      const col = cols.get(t);
      if (!col) continue;
      col.o[i] = b.o; col.h[i] = b.h; col.l[i] = b.l; col.c[i] = b.c; col.v[i] = b.v;
      const r = raw?.get(t);
      // No unadjusted file for this day: fall back to the adjusted bar and say
      // so, rather than silently gating on a zero.
      col.rc[i] = r ? r.c : b.c;
      col.rv[i] = r ? r.v : b.v;
      col.seen[i] = 1;
      if (col.first < 0) col.first = i;
      col.last = i;
    }
  }

  // Pass three: break each ticker into segments on a gap over SEGMENT_GAP_DAYS
  // trading days (B7), carry the short gaps flat and mark them synthetic (B6).
  let syntheticBars = 0, extraSegments = 0, segments = 0, tickersWithSegments = 0;
  let eligibilityChanges = 0, eligibilityGained = 0, eligibilityLost = 0, delistedSegments = 0;
  const series = new Map<string, Entry>();

  for (const [t, col] of cols) {
    if (col.first < 0) continue;
    // The real bars, in order.
    const real: number[] = [];
    for (let i = col.first; i <= col.last; i++) if (col.seen[i]) real.push(i);
    if (real.length === 0) continue;

    // Cut points: a gap of more than SEGMENT_GAP_DAYS trading days.
    const spans = segmentSpans(real, SEGMENT_GAP_DAYS);
    if (spans.length > 1) { extraSegments += spans.length - 1; tickersWithSegments++; }

    let segNo = 0;
    for (const [a, b] of spans) {
      const n = b - a + 1;
      if (n < MIN_SEGMENT_BARS) { segNo++; continue; }
      const s: PanelSeries = {
        open: new Array(n), high: new Array(n), low: new Array(n),
        close: new Array(n), volume: new Array(n), synthetic: new Array(n),
        rawClose: new Array(n), rawVol: new Array(n),
        avgVolRaw20: [], dollarVol20: [],
      };
      let prevC = col.c[a], prevRC = col.rc[a];
      for (let j = 0; j < n; j++) {
        const i = a + j;
        if (col.seen[i]) {
          s.open[j] = col.o[i]; s.high[j] = col.h[i]; s.low[j] = col.l[i];
          s.close[j] = col.c[i]; s.volume[j] = col.v[i];
          s.rawClose[j] = col.rc[i]; s.rawVol[j] = col.rv[i];
          s.synthetic[j] = false;
          prevC = col.c[i]; prevRC = col.rc[i];
        } else {
          // Halted or missing: carried flat so the averages stay on the
          // calendar, zero volume, and marked so nothing trades on it.
          syntheticBars++;
          s.open[j] = prevC; s.high[j] = prevC; s.low[j] = prevC;
          s.close[j] = prevC; s.volume[j] = 0;
          s.rawClose[j] = prevRC; s.rawVol[j] = 0;
          s.synthetic[j] = true;
        }
      }
      s.avgVolRaw20 = sma(s.rawVol, 20);
      const dv = new Array<number>(n);
      for (let j = 0; j < n; j++) dv[j] = s.rawClose[j] * s.rawVol[j];
      s.dollarVol20 = sma(dv, 20);

      const ind = indicators(s);
      const key = `${t}#${segNo}`;
      const delisted = b < N - 1;
      if (delisted) delistedSegments++;

      // B4 bookkeeping: on how many bars does the unadjusted gate disagree
      // with the adjusted gate the first run used?
      for (let j = 0; j < n; j++) {
        if (s.synthetic[j]) continue;
        const adjAv = ind.avgVol20[j];
        const rawAv = s.avgVolRaw20[j];
        if (adjAv === null || rawAv === null) continue;
        const adjPass = s.close[j] > MIN_PRICE && adjAv > MIN_AVG_VOLUME_20D;
        const rawPass = s.rawClose[j] > MIN_PRICE && rawAv > MIN_AVG_VOLUME_20D;
        if (adjPass !== rawPass) {
          eligibilityChanges++;
          if (rawPass) eligibilityGained++; else eligibilityLost++;
        }
      }

      series.set(key, { key, ticker: t, seg: segNo, first: a, last: b, delisted, s, ind });
      segments++;
      segNo++;
    }
  }
  cols.clear();
  log(`  panel: ${series.size} segments over ${new Set([...series.values()].map((e) => e.ticker)).size} tickers, ` +
      `${syntheticBars.toLocaleString('en-US')} carried-flat bars, ${extraSegments} extra segments from symbol gaps`);
  log(`  eligibility: ${eligibilityChanges.toLocaleString('en-US')} ticker-days change when the floors read unadjusted bars ` +
      `(${eligibilityGained.toLocaleString('en-US')} newly eligible, ${eligibilityLost.toLocaleString('en-US')} no longer)`);

  return {
    dates, idx, keys: [...series.keys()], series, meta,
    syntheticBars, extraSegments, segments,
    tickersWithSegments,
    eligibilityChanges, eligibilityGained, eligibilityLost,
    rawDaysUsed, delistedSegments,
  };
}

// -------------------------------------------- alternate indicator parameters

/**
 * Indicators for one (fast, slow, lookback) triple, for the sensitivity grid.
 * The moving-average pair and the stochastic are cached separately so nine
 * SMA passes and three stochastic passes cover all 27 combinations, rather
 * than 27 full recomputations.
 */
export type SmaPair = Map<string, { fast: (number | null)[]; slow: (number | null)[] }>;
export type StochSet = Map<string, { k: (number | null)[]; d: (number | null)[] }>;

export function buildSmaPair(p: Panel, fast: number, slow: number): SmaPair {
  const m: SmaPair = new Map();
  for (const [key, e] of p.series) {
    m.set(key, { fast: sma(e.s.close, fast), slow: sma(e.s.close, slow) });
  }
  return m;
}

export function buildStochSet(p: Panel, lookback: number): StochSet {
  const m: StochSet = new Map();
  for (const [key, e] of p.series) {
    m.set(key, stochastic(e.s.high, e.s.low, e.s.close, lookback));
  }
  return m;
}

export function composeIndicators(p: Panel, smaP: SmaPair, st: StochSet): Map<string, Indicators> {
  const m = new Map<string, Indicators>();
  for (const [key, e] of p.series) {
    const a = smaP.get(key)!, b = st.get(key)!;
    m.set(key, { fast: a.fast, slow: a.slow, k: b.k, d: b.d, avgVol20: e.ind.avgVol20 });
  }
  return m;
}

// ---------------------------------------------------------- the signal table
//
// Every (segment, day) on which the buy test fires, with the gates already
// applied. Built once per indicator set and reused by every simulation that
// shares those indicators, which is what makes 100-plus runs affordable.

export type Fire = {
  key: string;
  /** Fast %K on the signal bar. */
  k: number | null;
  crossAgo: number;
  /** Close over the 30-day, minus one: how far above the slow average it is. */
  above: number;
  /** 20-day average dollar volume, unadjusted. */
  dv: number;
};

export type SignalTable = {
  /** fires[i] = every segment firing on panel day i. */
  fires: Fire[][];
  /** rev.get(key)[j] = 1 when the reverse cross fires on that segment bar. */
  rev: Map<string, Uint8Array>;
  totalFires: number;
};

export function buildSignalTable(p: Panel, indOverride?: Map<string, Indicators>): SignalTable {
  const fires: Fire[][] = Array.from({ length: p.dates.length }, () => []);
  const rev = new Map<string, Uint8Array>();
  let totalFires = 0;

  for (const [key, e] of p.series) {
    const ind = indOverride?.get(key) ?? e.ind;
    const n = e.last - e.first + 1;
    const rv = new Uint8Array(n);
    for (let j = 0; j < n; j++) {
      if (e.s.synthetic[j]) continue;                       // B6: nothing on an invented bar
      if (reverseCrossOn(j, e.s, ind)) rv[j] = 1;
      // B4: the floors read the unadjusted close and the unadjusted 20-day
      // average volume, which is where the trader's real decision lived.
      if (e.s.rawClose[j] <= MIN_PRICE) continue;
      const av = e.s.avgVolRaw20[j];
      if (av === null || av <= MIN_AVG_VOLUME_20D) continue;
      const sig = signalOn(j, e.s, ind);
      if (!sig) continue;
      const slowV = ind.slow[j];
      fires[e.first + j].push({
        key,
        k: sig.k,
        crossAgo: sig.crossAgo,
        above: slowV && slowV > 0 ? e.s.close[j] / slowV - 1 : 0,
        dv: e.s.dollarVol20[j] ?? 0,
      });
      totalFires++;
    }
    rev.set(key, rv);
  }
  return { fires, rev, totalFires };
}

// -------------------------------------------------------------- simulation

export type Trade = {
  /** Segment key, TICKER#n. */
  key: string;
  ticker: string;
  entryDate: string;
  entryPrice: number;
  exitDate: string | null;
  exitPrice: number | null;
  shares: number;
  /** Dollars originally committed to the position. */
  cost: number;
  pnl: number;
  /** Return on the dollars committed, as a fraction. */
  ret: number;
  holdDays: number;
  /** Trading days held, which is what the exit-reason table averages. */
  barsHeld: number;
  reason: string;
  kAtSignal: number | null;
  crossAgo: number;
  /** Worst excursion during the hold, as a fraction of the entry fill (<= 0). */
  mae: number;
  /** Best excursion during the hold, as a fraction of the entry fill (>= 0). */
  mfe: number;
  /** Panel index of the entry and the exit, for the excursion follow-up. */
  entryIdx: number;
  exitIdx: number | null;
};

type Position = {
  key: string;
  ticker: string;
  entryIdx: number;
  entryDate: string;
  entryPrice: number;
  shares: number;
  cost: number;
  realised: number;
  trimmed: boolean;
  /** Trailing high-water mark, only live after the trim. */
  hwm: number;
  kAtSignal: number | null;
  crossAgo: number;
  lo: number;
  hi: number;
  bars: number;
};

export type SimResult = {
  dates: string[];
  equity: number[];
  /** Number of open names on each day, and the market value held. */
  openCount: number[];
  heldValue: number[];
  trades: Trade[];
  openAtEnd: Trade[];
  signalCount: number;
  skippedNoSlot: number;
  skippedNoCash: number;
  skippedWash: number;
  skippedZeroShares: number;
  skippedParticipation: number;
  /** B6 counters. */
  buysCancelledSynthetic: number;
  sellsDeferredSynthetic: number;
  /** B1 counter. */
  delistedSettled: number;
  /** B16: positions too small to halve at the +20% trim. */
  trimsUnsplittable: number;
  /** How many positions reached +20% and had half taken off. The half-sale is
   *  a leg, not a trade, so it never appears in the trade list on its own. */
  trimsTaken: number;
  cashLeft: number;
};

export type SelectRule = 'lowK' | 'freshestCross' | 'dollarVolume' | 'random';
export type FillMode = 'stated' | 'broker';

export type SimOptions = {
  restrictTo?: Set<string> | null;
  /**
   * A POINT-IN-TIME universe test, for the strategy-discovery session: given a
   * panel day and a ticker, may the book buy it today? A static `restrictTo`
   * set built from the whole window would let a name that only became liquid
   * in 2025 be bought in 2022; this asks the question on the day.
   */
  restrictAt?: ((i: number, ticker: string) => boolean) | null;
  startDate: string;
  /** Labelled variation only: veto a buy whose fast %K is above this. */
  maxK?: number | null;
  /** B3: 'stated' is the rule as he said it, 'broker' is what the order does. */
  fills?: FillMode;
  /** B2: which candidates fill the ten slots. */
  select?: SelectRule;
  /** Seed for select:'random'. */
  seed?: number;
  /** B13: his numbers are the defaults; the grid varies them. */
  fast?: number;
  slow?: number;
  lookback?: number;
  stopPct?: number;
  /** B12: slippage, and a cap on how much of a bar's dollar volume one pick may be. */
  slippage?: number;
  participationCap?: number | null;
  /** Precomputed signals for these indicator settings. Built once, reused. */
  table?: SignalTable;
  /** Alternate indicators to match `table`. */
  ind?: Map<string, Indicators>;
  /** Last date the simulation runs to, for the walk-forward split. */
  endDate?: string;
  /**
   * Dollars committed to one pick. Defaults to PER_PICK ($1,000), which is the
   * number the owner gave. The strategy-discovery session varies it so his cross can
   * be run as an entry rule inside a 5-to-8 name book rather than a 10-slot one.
   */
  perPick?: number;
  /** Open positions allowed at once. Defaults to MAX_OPEN (10). */
  maxOpen?: number;
};

/** Deterministic small PRNG, so a seeded random run is reproducible. */
function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function simulate(p: Panel, opt: SimOptions): SimResult {
  const startI = p.dates.findIndex((d) => d >= opt.startDate);
  if (startI < 0) throw new Error('start date is past the end of the panel');
  const endI = opt.endDate
    ? Math.min(p.dates.length - 1, (() => { const k = p.dates.findIndex((d) => d > opt.endDate!); return k < 0 ? p.dates.length - 1 : k - 1; })())
    : p.dates.length - 1;

  const fills: FillMode = opt.fills ?? 'stated';
  const select: SelectRule = opt.select ?? 'lowK';
  const stopPct = opt.stopPct ?? STOP_PCT;
  const slip = opt.slippage ?? SLIPPAGE;
  const cap = opt.participationCap ?? null;
  const table = opt.table ?? buildSignalTable(p, opt.ind);
  const perPick = opt.perPick ?? PER_PICK;
  const maxOpen = opt.maxOpen ?? MAX_OPEN;
  const rnd = select === 'random' ? mulberry32((opt.seed ?? 1) * 2654435761) : null;

  let cash = START_CASH;
  const open = new Map<string, Position>();
  const trades: Trade[] = [];
  const equity: number[] = [];
  const openCount: number[] = [];
  const heldValue: number[] = [];
  const lossBlockUntil = new Map<string, number>();
  let signalCount = 0, skippedNoSlot = 0, skippedNoCash = 0, skippedWash = 0;
  let skippedZeroShares = 0, skippedParticipation = 0;
  let buysCancelledSynthetic = 0, sellsDeferredSynthetic = 0;
  let delistedSettled = 0, trimsUnsplittable = 0, trimsTaken = 0;

  let pendingSells: { key: string; portion: number; reason: string }[] = [];
  let pendingBuys: Fire[] = [];

  const bar = (key: string, i: number) => {
    const e = p.series.get(key);
    if (!e) return null;
    const j = i - e.first;
    if (j < 0 || i > e.last) return null;
    return { e, j };
  };

  /** Book a closed leg. */
  const closeOut = (pos: Position, date: string, i: number, fill: number, reason: string, sh: number) => {
    const proceeds = sh * fill;
    cash += proceeds;
    pos.shares -= sh;
    pos.realised += proceeds;
    const pnl = pos.realised - pos.cost;
    trades.push({
      key: pos.key, ticker: pos.ticker,
      entryDate: pos.entryDate, entryPrice: pos.entryPrice,
      exitDate: date, exitPrice: fill, shares: sh, cost: pos.cost,
      pnl, ret: pnl / pos.cost,
      holdDays: dayDiff(pos.entryDate, date),
      barsHeld: pos.bars,
      reason,
      kAtSignal: pos.kAtSignal, crossAgo: pos.crossAgo,
      mae: pos.lo / pos.entryPrice - 1,
      mfe: pos.hi / pos.entryPrice - 1,
      entryIdx: pos.entryIdx, exitIdx: i,
    });
    // The wash block keys on the segment, not the bare symbol (B7).
    if (pnl < 0) lossBlockUntil.set(pos.key, Date.parse(date) + NO_REENTRY_DAYS * 86_400_000);
    open.delete(pos.key);
  };

  for (let i = startI; i <= endI; i++) {
    const date = p.dates[i];

    // ---- 1. fill yesterday's orders at today's open --------------------
    const deferred: typeof pendingSells = [];
    for (const sell of pendingSells) {
      const pos = open.get(sell.key);
      if (!pos) continue;
      const b = bar(sell.key, i);
      // B6: a pending sell that lands on a carried-flat bar is deferred to the
      // next real bar rather than filled at a price that never printed.
      if (!b) { deferred.push(sell); continue; }
      if (b.e.s.synthetic[b.j]) { sellsDeferredSynthetic++; deferred.push(sell); continue; }
      const px = b.e.s.open[b.j];
      if (!(px > 0)) { deferred.push(sell); continue; }
      const fill = px * (1 - slip);
      const sh = sell.portion >= 1 ? pos.shares : Math.floor(pos.shares / 2);
      if (sh <= 0) {
        // A one-share position cannot be halved. The +20% was still reached,
        // so the 8% trail takes over the whole position.
        trimsUnsplittable++;
        pos.trimmed = true;
        pos.hwm = b.e.s.close[b.j];
        continue;
      }
      if (sell.portion >= 1 || sh >= pos.shares) {
        closeOut(pos, date, i, fill, sell.reason, sh);
      } else {
        cash += sh * fill;
        pos.shares -= sh;
        pos.realised += sh * fill;
        pos.trimmed = true;
        trimsTaken++;
        pos.hwm = b.e.s.close[b.j];
      }
    }
    pendingSells = deferred;

    for (const buy of pendingBuys) {
      if (open.size >= maxOpen) { skippedNoSlot++; continue; }
      if (open.has(buy.key)) continue;
      if (cash < perPick) { skippedNoCash++; continue; }
      const b = bar(buy.key, i);
      if (!b) continue;
      // B6: a pending buy on a carried-flat open is cancelled outright.
      if (b.e.s.synthetic[b.j]) { buysCancelledSynthetic++; continue; }
      const px = b.e.s.open[b.j];
      if (!(px > 0)) continue;
      // B12: do not buy $1,000 of a name that did not trade that much.
      if (cap !== null) {
        const dollarVol = b.e.s.rawClose[b.j] * b.e.s.rawVol[b.j];
        if (dollarVol > 0 && perPick > cap * dollarVol) { skippedParticipation++; continue; }
      }
      const fill = px * (1 + slip);
      // B16: whole shares. Schwab sells fractions only on S&P 500 names.
      const shares = Math.floor(perPick / fill);
      if (shares <= 0) { skippedZeroShares++; continue; }
      const cost = shares * fill;
      cash -= cost;
      open.set(buy.key, {
        key: buy.key, ticker: b.e.ticker, entryIdx: i, entryDate: date, entryPrice: fill,
        shares, cost, realised: 0, trimmed: false, hwm: fill,
        kAtSignal: buy.k, crossAgo: buy.crossAgo,
        lo: Math.min(fill, b.e.s.low[b.j]), hi: Math.max(fill, b.e.s.high[b.j]), bars: 1,
      });
    }
    pendingBuys = [];

    // ---- 2. broker-style resting orders, intraday ----------------------
    //
    // A Schwab stop is live from the moment the position is entered. Where a
    // bar could have hit both the stop and the +20% target, the stop is taken
    // first: intraday order is unknowable from a daily bar, so the reading
    // that costs the book money is the one used.
    if (fills === 'broker') {
      for (const pos of [...open.values()]) {
        const b = bar(pos.key, i);
        if (!b || b.e.s.synthetic[b.j]) continue;
        if (pos.entryIdx === i) continue;         // entered at this open; orders rest from tomorrow
        const { s, } = b.e;
        const j = b.j;
        const stopPx = pos.entryPrice * (1 - stopPct);
        if (s.low[j] <= stopPx) {
          // A gap through the stop fills at the open, not at the stop.
          const px = s.open[j] <= stopPx ? s.open[j] : stopPx;
          pos.lo = Math.min(pos.lo, s.low[j]); pos.hi = Math.max(pos.hi, s.high[j]);
          closeOut(pos, date, i, px * (1 - slip), `stop -${(stopPct * 100).toFixed(0)}%`, pos.shares);
          continue;
        }
        if (!pos.trimmed) {
          const target = pos.entryPrice * (1 + TRIM_TRIGGER);
          if (s.high[j] >= target) {
            // A limit fills at the target, or better if the bar opened above it.
            const px = s.open[j] > target ? s.open[j] : target;
            const sh = Math.floor(pos.shares / 2);
            pos.lo = Math.min(pos.lo, s.low[j]); pos.hi = Math.max(pos.hi, s.high[j]);
            if (sh <= 0) {
              trimsUnsplittable++;
              pos.trimmed = true;
              pos.hwm = s.high[j];
            } else {
              const fill = px * (1 - slip);
              cash += sh * fill;
              pos.shares -= sh;
              pos.realised += sh * fill;
              pos.trimmed = true;
              trimsTaken++;
              pos.hwm = s.high[j];
            }
            continue;
          }
        } else {
          // The trail tracks the intraday high and fills the day the low reaches it.
          const trail = pos.hwm * (1 - TRAIL_PCT);
          if (s.low[j] <= trail) {
            const px = s.open[j] <= trail ? s.open[j] : trail;
            pos.lo = Math.min(pos.lo, s.low[j]); pos.hi = Math.max(pos.hi, s.high[j]);
            closeOut(pos, date, i, px * (1 - slip), 'trail -8%', pos.shares);
            continue;
          }
          if (s.high[j] > pos.hwm) pos.hwm = s.high[j];
        }
      }
    }

    // ---- 3. excursions, and B1: settle anything that stops trading -----
    for (const pos of [...open.values()]) {
      const b = bar(pos.key, i);
      if (!b) continue;
      if (!b.e.s.synthetic[b.j]) {
        pos.lo = Math.min(pos.lo, b.e.s.low[b.j]);
        pos.hi = Math.max(pos.hi, b.e.s.high[b.j]);
        if (i > pos.entryIdx) pos.bars++;
      }
      // The last bar this name ever printed. It cannot be marked, exited or
      // freed after today, so the book settles it here at that close with the
      // usual slippage. No merger-consideration feed exists, so a cash buyout
      // at a premium is recorded at the last traded price, not the deal price.
      if (b.e.delisted && i === b.e.last) {
        delistedSettled++;
        closeOut(pos, date, i, b.e.s.close[b.j] * (1 - slip), 'delisted', pos.shares);
      }
    }

    // ---- 4. mark the book on today's closes ----------------------------
    let mkt = 0;
    for (const pos of open.values()) {
      const b = bar(pos.key, i);
      // After B1 every open position has a bar today; the fallback is the
      // entry price only for the impossible case.
      mkt += pos.shares * (b ? b.e.s.close[b.j] : pos.entryPrice);
    }
    equity.push(cash + mkt);
    openCount.push(open.size);
    heldValue.push(mkt);

    if (i === endI) break;

    // ---- 5. exit tests on today's closes -------------------------------
    for (const pos of open.values()) {
      const b = bar(pos.key, i);
      if (!b || b.e.s.synthetic[b.j]) continue;
      const ind = opt.ind?.get(pos.key) ?? b.e.ind;
      const c = b.e.s.close[b.j];

      // The reverse cross is a signal, not an order: a close test filled at
      // the next open, in BOTH fill models.
      const rev = table.rev.get(pos.key);
      const reversed = rev ? rev[b.j] === 1 : reverseCrossOn(b.j, b.e.s, ind);

      if (fills === 'stated') {
        let reason: string | null = null;
        if (c <= pos.entryPrice * (1 - stopPct)) reason = `stop -${(stopPct * 100).toFixed(0)}%`;
        else if (reversed) reason = 'reverse cross';
        if (reason) { pendingSells.push({ key: pos.key, portion: 1, reason }); continue; }
        if (!pos.trimmed && c >= pos.entryPrice * (1 + TRIM_TRIGGER)) {
          pendingSells.push({ key: pos.key, portion: 0.5, reason: 'trim +20%' });
          continue;
        }
        if (pos.trimmed) {
          if (c > pos.hwm) pos.hwm = c;
          if (c <= pos.hwm * (1 - TRAIL_PCT)) {
            pendingSells.push({ key: pos.key, portion: 1, reason: 'trail -8%' });
          }
        }
      } else {
        if (reversed) pendingSells.push({ key: pos.key, portion: 1, reason: 'reverse cross' });
      }
    }

    // ---- 6. buy tests on today's closes --------------------------------
    const slotsFree = maxOpen - open.size + pendingSells.filter((s) => s.portion >= 1).length;
    if (slotsFree > 0) {
      const pool = opt.restrictTo ?? null;
      const cands: Fire[] = [];
      for (const f of table.fires[i]) {
        if (open.has(f.key)) continue;
        const e = p.series.get(f.key)!;
        if (pool && !pool.has(e.ticker)) continue;
        if (opt.restrictAt && !opt.restrictAt(i, e.ticker)) continue;
        const blocked = lossBlockUntil.get(f.key);
        if (blocked !== undefined && Date.parse(date) < blocked) { skippedWash++; continue; }
        if (opt.maxK != null && f.k != null && f.k > opt.maxK) continue;
        cands.push(f);
      }
      signalCount += cands.length;

      // B2: WHICH ten of a hundred-plus candidates get bought is a choice, not
      // a rule. His stated preference is the lowest stochastic; the others are
      // labelled variations and the spread between them is the error bar.
      switch (select) {
        case 'lowK':
          cands.sort((a, b) => (a.k ?? 50) - (b.k ?? 50) || a.key.localeCompare(b.key));
          break;
        case 'freshestCross':
          cands.sort((a, b) => a.crossAgo - b.crossAgo || a.above - b.above || a.key.localeCompare(b.key));
          break;
        case 'dollarVolume':
          cands.sort((a, b) => b.dv - a.dv || a.key.localeCompare(b.key));
          break;
        case 'random': {
          cands.sort((a, b) => a.key.localeCompare(b.key));
          for (let z = cands.length - 1; z > 0; z--) {
            const w = Math.floor(rnd!() * (z + 1));
            [cands[z], cands[w]] = [cands[w], cands[z]];
          }
          break;
        }
      }
      pendingBuys = cands.slice(0, Math.max(0, slotsFree));
    }
  }

  const openAtEnd: Trade[] = [...open.values()].map((pos) => {
    const b = bar(pos.key, endI);
    const c = b ? b.e.s.close[b.j] : pos.entryPrice;
    const value = pos.realised + pos.shares * c;
    return {
      key: pos.key, ticker: pos.ticker, entryDate: pos.entryDate, entryPrice: pos.entryPrice,
      exitDate: null, exitPrice: null, shares: pos.shares, cost: pos.cost,
      pnl: value - pos.cost, ret: (value - pos.cost) / pos.cost,
      holdDays: dayDiff(pos.entryDate, p.dates[endI]), barsHeld: pos.bars,
      reason: 'open at end', kAtSignal: pos.kAtSignal, crossAgo: pos.crossAgo,
      mae: pos.lo / pos.entryPrice - 1, mfe: pos.hi / pos.entryPrice - 1,
      entryIdx: pos.entryIdx, exitIdx: null,
    };
  });

  return {
    dates: p.dates.slice(startI, endI + 1), equity, openCount, heldValue,
    trades, openAtEnd, signalCount,
    skippedNoSlot, skippedNoCash, skippedWash, skippedZeroShares, skippedParticipation,
    buysCancelledSynthetic, sellsDeferredSynthetic, delistedSettled, trimsUnsplittable, trimsTaken,
    cashLeft: cash,
  };
}

export const dayDiff = (a: string, b: string) =>
  Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

// ------------------------------------------------------------- benchmark

/**
 * Buy and hold one ticker with the same entry slippage and whole shares, based
 * on the ENTRY FILL rather than the first close (B11), so the benchmark starts
 * at $10,000 like the book does. `divs` reinvests cash dividends on the ex-date
 * at that day's close, which is the total-return line.
 */
export function buyHold(
  p: Panel, ticker: string, startDate: string,
  divs?: { ex: string; amount: number }[] | null,
): { equity: number[]; entry: number; shares: number } | null {
  const key = [...p.series.keys()].find((k) => k.startsWith(ticker + '#'));
  if (!key) return null;
  const e = p.series.get(key)!;
  const startI = p.dates.findIndex((d) => d >= startDate);
  const j0 = startI - e.first;
  if (j0 < 0 || j0 > e.last - e.first) return null;
  const entry = e.s.open[j0] * (1 + SLIPPAGE);
  let shares = START_CASH / entry;
  let cash = 0;
  const byEx = new Map<string, number>();
  for (const d of divs ?? []) byEx.set(d.ex, (byEx.get(d.ex) ?? 0) + d.amount);

  const out: number[] = [];
  for (let i = startI; i < p.dates.length; i++) {
    const j = Math.min(i - e.first, e.last - e.first);
    const c = e.s.close[j];
    const amt = byEx.get(p.dates[i]);
    if (amt && i > startI) {
      // Paid on the ex-date and put straight back into shares at that close.
      cash += shares * amt;
      if (c > 0) { shares += cash / c; cash = 0; }
    }
    out.push(shares * c + cash);
  }
  return { equity: out, entry, shares: START_CASH / entry };
}
