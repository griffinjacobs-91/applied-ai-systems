// the owner's signal, as he specified it on 7 September 2026. Pure functions only:
// no I/O, no dates, no globals. Everything here is testable on a fixture.
//
// Buy  : within the last 5 trading days the 10-day SMA crossed above the
//        30-day SMA, and today's close is above both.
// Range: 14-day stochastic, fast %K and slow %D. Preference, never a veto.
// Sell : the 10-day crosses below the 30-day and the close is below both.
//
// The parameters are his: 10, 30, 14.

export const FAST = 10;
export const SLOW = 30;
export const STOCH = 14;
export const CROSS_LOOKBACK = 5; // "within the last week" = 5 trading days

/**
 * Simple moving average. Element i is the mean of the n values ending at i;
 * null until there are n values.
 */
export function sma(values: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/**
 * 14-day stochastic oscillator.
 *   fast %K = 100 * (close - lowest low n) / (highest high n - lowest low n)
 *   slow %D = 3-period SMA of %K
 * A flat range (high == low over the window) yields 50, the neutral midpoint.
 */
export function stochastic(
  highs: number[],
  lows: number[],
  closes: number[],
  n: number = STOCH,
  dPeriod = 3,
): { k: (number | null)[]; d: (number | null)[] } {
  const k: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = n - 1; i < closes.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - n + 1; j <= i; j++) {
      if (highs[j] > hh) hh = highs[j];
      if (lows[j] < ll) ll = lows[j];
    }
    k[i] = hh === ll ? 50 : (100 * (closes[i] - ll)) / (hh - ll);
  }
  // %D is a 3-period SMA of %K over the bars where %K exists.
  const d: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    if (i < n - 1 + dPeriod - 1) continue;
    let s = 0;
    let ok = true;
    for (let j = i - dPeriod + 1; j <= i; j++) {
      const v = k[j];
      if (v === null) { ok = false; break; }
      s += v;
    }
    if (ok) d[i] = s / dPeriod;
  }
  return { k, d };
}

/** True when `fast` moved from at-or-below `slow` to strictly above it on bar i. */
export function crossUp(fast: (number | null)[], slow: (number | null)[], i: number): boolean {
  if (i < 1) return false;
  const f0 = fast[i - 1], s0 = slow[i - 1], f1 = fast[i], s1 = slow[i];
  if (f0 === null || s0 === null || f1 === null || s1 === null) return false;
  return f0 <= s0 && f1 > s1;
}

/** True when `fast` moved from at-or-above `slow` to strictly below it on bar i. */
export function crossDown(fast: (number | null)[], slow: (number | null)[], i: number): boolean {
  if (i < 1) return false;
  const f0 = fast[i - 1], s0 = slow[i - 1], f1 = fast[i], s1 = slow[i];
  if (f0 === null || s0 === null || f1 === null || s1 === null) return false;
  return f0 >= s0 && f1 < s1;
}

export type Series = {
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
};

/** Everything the signal computes for one ticker, once, over its whole series. */
export type Indicators = {
  fast: (number | null)[];
  slow: (number | null)[];
  k: (number | null)[];
  d: (number | null)[];
  avgVol20: (number | null)[];
};

export function indicators(s: Series): Indicators {
  const { k, d } = stochastic(s.high, s.low, s.close, STOCH);
  return {
    fast: sma(s.close, FAST),
    slow: sma(s.close, SLOW),
    k,
    d,
    avgVol20: sma(s.volume, 20),
  };
}

export type BuySignal = {
  fired: true;
  /** How many bars ago the cross happened; 0 means today. */
  crossAgo: number;
  /** Fast %K on the signal bar, 0-100. Lower is what the owner prefers. */
  k: number | null;
  /** Slow %D on the signal bar. */
  d: number | null;
};

/**
 * The buy test on bar `i` of a ticker's series. Returns null when it does not
 * fire. The stochastic is reported, never used to veto: the owner was explicit that
 * a high reading "doesn't kill the deal".
 */
export function signalOn(i: number, s: Series, ind: Indicators): BuySignal | null {
  const f = ind.fast[i];
  const sl = ind.slow[i];
  if (f === null || sl === null) return null;
  const c = s.close[i];
  if (!(c > f && c > sl)) return null; // must be above both

  let crossAgo = -1;
  for (let back = 0; back < CROSS_LOOKBACK; back++) {
    const j = i - back;
    if (j < 1) break;
    if (crossUp(ind.fast, ind.slow, j)) { crossAgo = back; break; }
  }
  if (crossAgo < 0) return null;

  return { fired: true, crossAgo, k: ind.k[i], d: ind.d[i] };
}

/**
 * The sell test on bar `i`: the 10 crossed below the 30 and the close is
 * below both. His mirror rule.
 */
export function reverseCrossOn(i: number, s: Series, ind: Indicators): boolean {
  const f = ind.fast[i];
  const sl = ind.slow[i];
  if (f === null || sl === null) return false;
  if (!crossDown(ind.fast, ind.slow, i)) return false;
  const c = s.close[i];
  return c < f && c < sl;
}
