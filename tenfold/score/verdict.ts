/**
 * The two sentences the owner asked for.
 *
 * 1. Model or market: is the book beating SPY, falling with it, or falling
 *    while it rises. His plug rule, in his words: if the market tanked, that is
 *    the market; if the market is good and the book is not beating the S&P 500,
 *    "I can just put all the money in SPY and sit."
 * 2. Working: is it running at the rate the approved holdout produced.
 *
 * Both are computed from NET return against SPY's actual closes. Neither reads
 * the engine's confidence, its ranking, or any prior it held. A monitor that
 * scores a model against the model's own expectation reports nothing.
 *
 * WHAT CHANGED, 8 Sept 2026. Both gates used to count CLOSED TRADES, at a floor
 * of 20, and the working target used to be 10 percent a month. Those are the
 * old cross rule's numbers. `xmom-12-1-top200` rebalances once a month and
 * holds six names, so it produces about two to three closed trades a month and
 * one independent decision: the sample that matters is MONTHS OF EQUITY, and
 * the rate worth measuring against is the one the approved holdout actually
 * delivered. See constants.ts for where every figure comes from.
 */

import {
  APPROVED_HOLDOUT,
  JOHN_STATED_TARGET_PCT_PER_MONTH,
  MARKET_TIE_BAND_POINTS,
  MIN_MONTHS_TO_JUDGE,
  NOISE_FLOOR_MONTHS,
  WORKING_TARGET_PCT_PER_MONTH,
} from './constants.ts';
import { round } from './math.ts';

export type MarketVerdictKind =
  | 'within-noise'
  | 'model-not-market'
  | 'beat'
  | 'fell-less-than-market'
  | 'fell-more-than-market'
  | 'trailed'
  | 'matched';

export interface MarketVerdict {
  kind: MarketVerdictKind;
  sentence: string;
  netReturnPct: number;
  benchmarkReturnPct: number;
  benchmarkName: string;
  excessPoints: number;
  /** Months of equity history behind the figure. This is what gates the claim. */
  monthsOfEquity: number;
  /** Reported, never a gate. A month-end rule closes two or three a month. */
  tradeCount: number;
  withinNoise: boolean;
  thresholds: {
    noiseFloorMonths: number;
    tieBandPoints: number;
  };
}

function pts(x: number): string {
  return `${Math.abs(round(x, 1)).toFixed(1)} points`;
}

function pct(x: number): string {
  const r = round(x, 2);
  return `${r > 0 ? '+' : ''}${r.toFixed(2)}%`;
}

function months(x: number): string {
  const r = round(x, 1);
  if (r < 1) {
    const days = Math.max(0, Math.round(r * 30.4375));
    return `${days} ${days === 1 ? 'day' : 'days'}`;
  }
  return `${r} ${r === 1 ? 'month' : 'months'}`;
}

/**
 * Model or market, in one plain sentence.
 *
 * Order of the tests, and why:
 * 1. Too few months of equity to say anything, whatever the numbers look like.
 * 2. Book down while the market is up. This is the sentence that pulls the
 *    plug, so it is checked before any tie band can soften it.
 * 3. Ahead of the market by more than the tie band. Phrased as a fall when both
 *    fell, because "beat the market" reads wrong on a losing month.
 * 4. Behind the market by more than the tie band.
 * 5. Inside the tie band: matched.
 */
export function modelOrMarket(args: {
  netReturnPct: number;
  benchmarkReturnPct: number;
  benchmarkName?: string;
  /** Months of equity history in the window. The gate. */
  monthsOfEquity: number;
  /** Closed trades in the window. Carried in the prose, never a gate. */
  tradeCount: number;
  tieBandPoints?: number;
  noiseFloorMonths?: number;
}): MarketVerdict {
  const name = args.benchmarkName ?? 'SPY';
  const net = args.netReturnPct;
  const bm = args.benchmarkReturnPct;
  const n = args.tradeCount;
  const m = round(args.monthsOfEquity, 2);
  const tie = args.tieBandPoints ?? MARKET_TIE_BAND_POINTS;
  const floor = args.noiseFloorMonths ?? NOISE_FLOOR_MONTHS;
  const excess = round(net - bm, 4);
  const base = {
    netReturnPct: round(net, 2),
    benchmarkReturnPct: round(bm, 2),
    benchmarkName: name,
    excessPoints: excess,
    monthsOfEquity: m,
    tradeCount: n,
    withinNoise: m < floor,
    thresholds: { noiseFloorMonths: floor, tieBandPoints: tie },
  };

  if (m < floor) {
    return {
      ...base,
      kind: 'within-noise',
      sentence:
        `Within noise: ${months(m)} of equity is too short to say. ` +
        `The book is ${pct(net)} net against ${name} ${pct(bm)}, which is ${pts(excess)} ` +
        `${excess >= 0 ? 'ahead' : 'behind'} on ${n} closed ${n === 1 ? 'trade' : 'trades'}, ` +
        `but ${floor} months is the floor for calling it: this rule rebalances once a month, ` +
        `so a month is one decision and ${floor} of them is the holdout it was approved on.`,
    };
  }

  if (net < 0 && bm >= 0) {
    return {
      ...base,
      kind: 'model-not-market',
      sentence:
        `Fell while the market rose: this is the model, not the market. ` +
        `The book is ${pct(net)} net while ${name} is ${pct(bm)}, ${pts(excess)} behind over ${months(m)}.`,
    };
  }

  if (excess > tie) {
    if (net < 0 && bm < 0) {
      return {
        ...base,
        kind: 'fell-less-than-market',
        sentence:
          `Fell with the market; the market fell more. ` +
          `The book is ${pct(net)} net against ${name} ${pct(bm)}, ${pts(excess)} better over ${months(m)}.`,
      };
    }
    return {
      ...base,
      kind: 'beat',
      sentence:
        `Beat the market by ${pts(excess)} over ${months(m)}. ` +
        `The book is ${pct(net)} net against ${name} ${pct(bm)}.`,
    };
  }

  if (excess < -tie) {
    if (net < 0 && bm < 0) {
      return {
        ...base,
        kind: 'fell-more-than-market',
        sentence:
          `Fell with the market, and further than it did: ${pts(excess)} worse over ${months(m)}. ` +
          `The book is ${pct(net)} net against ${name} ${pct(bm)}.`,
      };
    }
    return {
      ...base,
      kind: 'trailed',
      sentence:
        `Trailed the market by ${pts(excess)} over ${months(m)}. ` +
        `The book is ${pct(net)} net against ${name} ${pct(bm)}.`,
    };
  }

  return {
    ...base,
    kind: 'matched',
    sentence:
      `Matched the market, inside the ${tie.toFixed(1)} point tie band, over ${months(m)}. ` +
      `The book is ${pct(net)} net against ${name} ${pct(bm)}.`,
  };
}

export type WorkingKind = 'working' | 'not-working' | 'too-early';

export interface WorkingTest {
  kind: WorkingKind;
  sentence: string;
  /** Compounded, not divided: the rate that turns the window into its net return. */
  avgMonthlyNetPct: number | null;
  targetPctPerMonth: number;
  months: number;
  netReturnPct: number;
  tradeCount: number;
  withinNoise: boolean;
  thresholds: {
    targetPctPerMonth: number;
    minMonthsToJudge: number;
    noiseFloorMonths: number;
  };
}

/**
 * Working, measured against what the approved holdout produced: +125.81 percent
 * net over 12 months, which is 7.02 percent a month compounded. the owner's own wish
 * was 10 percent a month and is carried in the sentence, because a target no
 * version of this rule has ever hit is a description of the wish, not a test.
 *
 * The monthly figure compounds. A 90 day window at +33.1 percent net is 10
 * percent a month, not 11. Dividing would flatter the book.
 */
export function workingTest(args: {
  netReturnPct: number;
  months: number;
  tradeCount: number;
  targetPctPerMonth?: number;
  minMonthsToJudge?: number;
  noiseFloorMonths?: number;
}): WorkingTest {
  const target = args.targetPctPerMonth ?? WORKING_TARGET_PCT_PER_MONTH;
  const minMonths = args.minMonthsToJudge ?? MIN_MONTHS_TO_JUDGE;
  const floor = args.noiseFloorMonths ?? NOISE_FLOOR_MONTHS;
  const m = round(args.months, 2);
  const net = args.netReturnPct;
  const factor = 1 + net / 100;

  let avgMonthly: number | null = null;
  if (m > 0 && factor > 0) {
    avgMonthly = round((Math.pow(factor, 1 / m) - 1) * 100, 2);
  } else if (m > 0 && factor <= 0) {
    // A total wipeout has no real monthly root. Report the floor honestly.
    avgMonthly = -100;
  }

  const base = {
    avgMonthlyNetPct: avgMonthly,
    targetPctPerMonth: target,
    months: m,
    netReturnPct: round(net, 2),
    tradeCount: args.tradeCount,
    withinNoise: m < floor,
    thresholds: { targetPctPerMonth: target, minMonthsToJudge: minMonths, noiseFloorMonths: floor },
  };

  if (m < minMonths || m < floor) {
    return {
      ...base,
      kind: 'too-early',
      sentence:
        `Too early to call working: ${months(m)} of equity, against a floor of ${floor} months. ` +
        `Running at ${avgMonthly === null ? 'n/a' : pct(avgMonthly)} a month net. ` +
        `The approved holdout ran at ${target}% a month for ${APPROVED_HOLDOUT.months} months; ` +
        `the owner's own number was ${JOHN_STATED_TARGET_PCT_PER_MONTH}%.`,
    };
  }

  const hit = avgMonthly !== null && avgMonthly >= target;
  return {
    ...base,
    kind: hit ? 'working' : 'not-working',
    sentence: hit
      ? `Working: ${pct(avgMonthly as number)} a month net over ${months(m)}, at or above the ` +
        `${target}% the approved holdout produced, on ${args.tradeCount} closed trades.`
      : `Not at the target: ${avgMonthly === null ? 'n/a' : pct(avgMonthly)} a month net over ` +
        `${months(m)} against the ${target}% the approved holdout produced, on ` +
        `${args.tradeCount} closed trades.`,
  };
}
