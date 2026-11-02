/**
 * The three things the book is scored against, per the owner, 7 Sept 2026:
 * SPY, his main account, and a Strong Buy basket.
 *
 * All three are outcome series. None of them touches the engine's own prior.
 */

import type {
  Benchmark,
  BasketSnapshot,
  Distribution,
  MainAccountPercents,
  PricePoint,
  ReturnBasis,
  ScoreWindow,
} from './types.ts';
import { parseDate, pctChange, round, sampled, withinWindow } from './math.ts';
import type { Sampled } from './types.ts';

export interface BenchmarkReturn {
  name: string;
  startDate: string;
  endDate: string;
  startClose: number;
  endClose: number;
  /** The headline figure, on whichever basis `basis` names. */
  returnPct: number;
  /** Price only, always, so the two can be shown side by side and argued with. */
  priceReturnPct: number;
  /**
   * Which of the two `returnPct` is. TOTAL RETURN IS THE COMPARABLE ONE: the
   * backtest the owner approved measured SPY with its dividends put back in
   * (backtest/engine.ts buyHold, `divs` reinvested on the ex-date), and a live
   * page that quoted price return against that sheet would be flattering the
   * book by roughly a point and a half a year for free.
   *
   * A series that arrives with no distributions is reported as `price-return`
   * and the card raises a warning. It is never silently called total return.
   */
  basis: ReturnBasis;
  /** How many distributions were reinvested inside the window. */
  distributionsCounted: number;
  /** Cash per share paid inside the window, before reinvestment. */
  distributionsPerShare: number;
  /** Closes found inside the window. */
  points: number;
}

function sortSeries(series: PricePoint[]): PricePoint[] {
  return [...series].sort((a, b) => parseDate(a.date) - parseDate(b.date));
}

/**
 * One share held from `open` to `close`, with every distribution whose ex-date
 * falls after the open and on or before the close put straight back into shares
 * at that day's close.
 *
 * This is the same arithmetic as backtest/engine.ts buyHold, deliberately: the
 * live line and the approved sheet's line have to be the same measurement or
 * they cannot be laid beside each other. A distribution whose ex-date is not
 * itself a printed close is credited on the first close on or after it, which
 * is what a broker does with a holiday.
 */
function totalReturnFactor(
  s: PricePoint[],
  open: PricePoint,
  close: PricePoint,
  distributions: Distribution[],
): { factor: number; counted: number; perShare: number } {
  const openT = parseDate(open.date);
  const closeT = parseDate(close.date);
  const inWindow = s.filter((p) => parseDate(p.date) > openT && parseDate(p.date) <= closeT);

  const byDate = new Map<string, number>();
  let counted = 0;
  let perShare = 0;
  for (const d of distributions) {
    if (!Number.isFinite(d.amountPerShare) || d.amountPerShare <= 0) continue;
    const t = parseDate(d.exDate);
    if (t <= openT || t > closeT) continue;
    const landing = inWindow.find((p) => parseDate(p.date) >= t);
    if (!landing) continue;
    byDate.set(landing.date, (byDate.get(landing.date) ?? 0) + d.amountPerShare);
    counted += 1;
    perShare += d.amountPerShare;
  }

  let shares = 1;
  let cash = 0;
  for (const p of inWindow) {
    const amount = byDate.get(p.date);
    if (amount) {
      cash += shares * amount;
      if (p.close > 0) {
        shares += cash / p.close;
        cash = 0;
      }
    }
  }
  return { factor: (shares * close.close + cash) / open.close, counted, perShare };
}

/**
 * The benchmark's return over the same days as the book window. Opening close
 * is the last one on or before window.start, which is how a broker statement
 * would mark it.
 *
 * Total return when the series carries distributions, price return when it does
 * not, and the answer always says which.
 */
export function benchmarkReturn(b: Benchmark, window: ScoreWindow): BenchmarkReturn | null {
  if (b.series.length === 0) return null;
  const s = sortSeries(b.series);
  const startT = parseDate(window.start);
  const endT = parseDate(window.end);
  let open = s.filter((p) => parseDate(p.date) <= startT).at(-1);
  if (!open) open = s.find((p) => parseDate(p.date) <= endT);
  const close = s.filter((p) => parseDate(p.date) <= endT).at(-1);
  if (!open || !close) return null;

  const price = pctChange(open.close, close.close);
  if (price === null) return null;

  const dists = b.distributions ?? [];
  const total = dists.length > 0 ? totalReturnFactor(s, open, close, dists) : null;
  const basis: ReturnBasis = total && total.counted > 0 ? 'total-return' : 'price-return';

  return {
    name: b.name,
    startDate: open.date,
    endDate: close.date,
    startClose: open.close,
    endClose: close.close,
    returnPct: round(basis === 'total-return' ? (total!.factor - 1) * 100 : price, 4),
    priceReturnPct: round(price, 4),
    basis,
    distributionsCounted: total?.counted ?? 0,
    distributionsPerShare: round(total?.perShare ?? 0, 6),
    points: s.filter((p) => withinWindow(p.date, window.start, window.end)).length,
  };
}

/** Find a benchmark by name, case insensitive. */
export function findBenchmark(benchmarks: Benchmark[] | undefined, name: string): Benchmark | null {
  if (!benchmarks) return null;
  const want = name.trim().toLowerCase();
  return benchmarks.find((b) => b.name.trim().toLowerCase() === want) ?? null;
}

/**
 * Excess of the book's NET return over a benchmark, in percentage points.
 * Net, never gross: the subscriptions come out before the comparison, because
 * the owner could hold SPY without paying them.
 */
export function excessOverBenchmark(netReturnPct: number, benchmarkReturnPct: number): number {
  return round(netReturnPct - benchmarkReturnPct, 4);
}

export interface BasketReturn {
  name: string;
  takenAt: string;
  returnPct: number | null;
  /** Names priced at both ends. Equal weight over exactly these. */
  namesScored: number;
  /** Snapshot names with no closing price, excluded from the average. */
  namesMissing: string[];
  perName: { symbol: string; startClose: number; endClose: number; returnPct: number }[];
  sample: Sampled;
}

/**
 * Equal weight buy and hold: snapshot every name once, mark each to its close
 * at the window end, average the per name returns. No rebalancing, no
 * weighting by size, because that is the basket the owner described.
 */
export function basketReturn(snapshot: BasketSnapshot): BasketReturn {
  const current = new Map(snapshot.current.map((p) => [p.symbol, p.close]));
  const perName: BasketReturn['perName'] = [];
  const missing: string[] = [];
  for (const h of snapshot.holdings) {
    const end = current.get(h.symbol);
    const change = end === undefined ? null : pctChange(h.close, end);
    if (end === undefined || change === null) {
      missing.push(h.symbol);
      continue;
    }
    perName.push({
      symbol: h.symbol,
      startClose: h.close,
      endClose: end,
      returnPct: round(change, 4),
    });
  }
  const avg =
    perName.length === 0
      ? null
      : round(perName.reduce((a, p) => a + p.returnPct, 0) / perName.length, 4);
  return {
    name: snapshot.name,
    takenAt: snapshot.takenAt,
    returnPct: avg,
    namesScored: perName.length,
    namesMissing: missing,
    perName,
    // A basket of five names is a thin read. Same floor, counted in names.
    sample: sampled(perName.length),
  };
}

export interface MainAccountReturn {
  name: string;
  startGainPct: number;
  endGainPct: number;
  /** The account's return across the window, derived from the two figures. */
  returnPct: number;
}

/**
 * the owner's main account over the window, from two cumulative gain percents.
 * Dollar values are never stored: the admin uploads the positions export, the
 * page computes total gain against cost basis, and only that percent is kept.
 *
 * Two cumulative gains against the same cost basis compose, they do not
 * subtract: 20 percent up then 32 percent up is (1.32 / 1.20) - 1 = 10 percent
 * over the window, not 12 points.
 */
export function mainAccountReturn(
  m: MainAccountPercents,
): MainAccountReturn {
  const startFactor = 1 + m.startGainPct / 100;
  if (startFactor === 0) throw new Error('main account start gain of -100% cannot be a base');
  const endFactor = 1 + m.endGainPct / 100;
  return {
    name: m.name ?? "the owner's main account",
    startGainPct: m.startGainPct,
    endGainPct: m.endGainPct,
    returnPct: round((endFactor / startFactor - 1) * 100, 4),
  };
}
