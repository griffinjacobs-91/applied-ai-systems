// B14: a block bootstrap of the headline run's own daily returns.
//
// This is NOT a forecast and it is not a test of the signal. It answers one
// narrow question: was this four-year result typical of the return stream this
// book actually produced, or one unlucky ordering of it? Twenty-day blocks are
// used rather than single days so that the autocorrelation and the volatility
// clustering in the real series survive the resampling; shuffling single days
// would quietly manufacture a smoother book than ever existed.

import { maxDrawdown } from './metrics.ts';

function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

export type MonteCarlo = {
  replicates: number;
  blockDays: number;
  observedReturn: number;
  observedMaxDD: number;
  ret: { p5: number; p50: number; p95: number };
  maxDD: { p5: number; p50: number; p95: number };
  /** Share of replicates that ended above the starting capital. */
  pctPositive: number;
  /** Share of replicates that breached his -20% equity stop. */
  pctBreached20: number;
};

export function blockBootstrap(
  equity: number[], replicates = 2000, blockDays = 20, seed = 20260907,
): MonteCarlo {
  const r: number[] = [];
  for (let i = 1; i < equity.length; i++) r.push(equity[i] / equity[i - 1] - 1);
  const n = r.length;
  const observedReturn = equity[equity.length - 1] / equity[0] - 1;
  const observedMaxDD = maxDrawdown(equity).dd;
  if (n < blockDays * 2) {
    return {
      replicates: 0, blockDays, observedReturn, observedMaxDD,
      ret: { p5: 0, p50: 0, p95: 0 }, maxDD: { p5: 0, p50: 0, p95: 0 },
      pctPositive: 0, pctBreached20: 0,
    };
  }

  const rnd = mulberry32(seed);
  const rets: number[] = [], dds: number[] = [];
  let positive = 0, breached = 0;
  const nBlocks = Math.ceil(n / blockDays);

  for (let k = 0; k < replicates; k++) {
    const curve: number[] = [equity[0]];
    let v = equity[0], peak = equity[0];
    let hit20 = false;
    for (let b = 0; b < nBlocks; b++) {
      const start = Math.floor(rnd() * (n - blockDays));
      for (let j = 0; j < blockDays && curve.length <= n; j++) {
        v *= 1 + r[start + j];
        curve.push(v);
        if (v > peak) peak = v;
        if (v <= peak * 0.8) hit20 = true;
      }
    }
    rets.push(curve[curve.length - 1] / curve[0] - 1);
    dds.push(maxDrawdown(curve).dd);
    if (curve[curve.length - 1] > curve[0]) positive++;
    if (hit20) breached++;
  }
  rets.sort((a, b) => a - b);
  dds.sort((a, b) => a - b);
  return {
    replicates, blockDays, observedReturn, observedMaxDD,
    ret: { p5: percentile(rets, 0.05), p50: percentile(rets, 0.50), p95: percentile(rets, 0.95) },
    maxDD: { p5: percentile(dds, 0.05), p50: percentile(dds, 0.50), p95: percentile(dds, 0.95) },
    pctPositive: positive / replicates,
    pctBreached20: breached / replicates,
  };
}
