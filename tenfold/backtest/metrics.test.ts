// Metrics tests, on synthetic equity curves whose CAGR, drawdown and monthly
// returns are known exactly by construction.
//
//   node --experimental-strip-types --test backtest/metrics.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  monthlyReturns, maxDrawdown, cagr, stats, sliceYear,
  dailyReturns, sharpe, sortino, calmar, profitFactor, expectancy, exposure,
  longestLosingStreak, drawdownEpisodes, drawdownDuration, exitReasonTable, excursions,
} from './metrics.ts';
import { blockBootstrap } from './montecarlo.ts';
import type { Trade } from './engine.ts';

const near = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} is not within ${eps} of ${b}`);

/** Weekdays from a start date, the shape every equity series here uses. */
function dates(n: number, from = '2022-01-03'): string[] {
  const out: string[] = [];
  const d = new Date(from + 'T00:00:00Z');
  while (out.length < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function trade(over: Partial<Trade>): Trade {
  const merged = {
    key: 'X#0', ticker: 'X', entryDate: '2023-01-03', entryPrice: 10,
    exitDate: '2023-01-10', exitPrice: 11, shares: 100,
    pnl: 100, ret: 0.10, holdDays: 7, barsHeld: 5, reason: 'trim +20%',
    kAtSignal: 20, crossAgo: 1, mae: -0.05, mfe: 0.22,
    entryIdx: 0, exitIdx: 5, ...over,
  };
  // `cost` is the dollars committed. The helper predates the field and omitting it left
  // `astro check` with one error. Derived from the case's own shares and entry price so a
  // case that overrides either stays self-consistent, and `ret` stays `pnl / cost`:
  // the defaults are 100 shares at 10, which is 1,000, and 100 / 1,000 is the 0.10 above.
  return { ...merged, cost: over.cost ?? merged.shares * merged.entryPrice };
}

// ------------------------------------------------------------------- basics

test('a curve that doubles over exactly one year has a CAGR of 100 percent', () => {
  // 2022-01-03 to 2023-01-03 is 365 days exactly.
  const d = ['2022-01-03', '2023-01-03'];
  near(cagr([100, 200], d), Math.pow(2, 365.25 / 365) - 1, 1e-9);
  // A curve that goes nowhere has zero CAGR whatever its path.
  near(cagr([100, 100], d), 0, 1e-12);
});

test('maxDrawdown finds the deepest peak-to-trough and names both days', () => {
  const eq = [100, 120, 60, 90, 200, 150, 210];
  const d = dates(eq.length);
  const dd = maxDrawdown(eq);
  near(dd.dd, 60 / 120 - 1, 1e-12);        // exactly -50%
  assert.equal(d[dd.peakIdx], d[1]);
  assert.equal(d[dd.troughIdx], d[2]);
  // A monotone rise has no drawdown at all.
  near(maxDrawdown([1, 2, 3, 4]).dd, 0, 1e-12);
});

test('monthlyReturns bases each month on the prior month close and counts its days', () => {
  // Three trading days in Jan, two in Feb, hand-built.
  const d = ['2022-01-28', '2022-01-31', '2022-02-01', '2022-02-02'];
  const eq = [100, 110, 121, 132];
  const m = monthlyReturns(d, eq);
  assert.equal(m.length, 2);
  assert.equal(m[0].month, '2022-01');
  near(m[0].ret, 110 / 100 - 1, 1e-12);    // first month bases on equity[0]
  assert.equal(m[0].days, 2);
  assert.equal(m[1].month, '2022-02');
  near(m[1].ret, 132 / 110 - 1, 1e-12);    // bases on the last close of January
  assert.equal(m[1].days, 2);
});

test('sliceYear bases a year on the last close of the year before it', () => {
  const d = ['2022-12-30', '2023-01-03', '2023-12-29'];
  const eq = [100, 105, 150];
  const y = sliceYear(d, eq, '2023')!;
  near(y.ret, 150 / 100 - 1, 1e-12);
  assert.equal(y.baseEquity, 100);
  assert.equal(sliceYear(d, eq, '2029'), null);
});

// ------------------------------------------------------- the new metrics

test('Sharpe and Sortino on a curve with a known mean and deviation', () => {
  // Alternating +2% and -1%: mean 0.005, sample sd of [.02,-.01,...] known.
  const r = [0.02, -0.01, 0.02, -0.01, 0.02, -0.01, 0.02, -0.01];
  const eq = [100];
  for (const x of r) eq.push(eq[eq.length - 1] * (1 + x));
  assert.deepEqual(dailyReturns(eq).map((x) => Math.round(x * 1e10) / 1e10),
    r.map((x) => Math.round(x * 1e10) / 1e10));

  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((s, v) => s + (v - mean) ** 2, 0) / (r.length - 1));
  near(sharpe(eq)!, (mean / sd) * Math.sqrt(252), 1e-9);

  const down = r.filter((v) => v < 0);
  const dd = Math.sqrt(down.reduce((s, v) => s + v * v, 0) / down.length);
  near(sortino(eq)!, (mean / dd) * Math.sqrt(252), 1e-9);

  // Sortino must be the larger of the two here: the downside deviation of a
  // series whose losses are half the size of its gains is smaller.
  assert.ok(sortino(eq)! > sharpe(eq)!);
  // A flat curve has no deviation and therefore no Sharpe to report.
  assert.equal(sharpe([100, 100, 100]), null);
  assert.equal(sortino([100, 101, 102]), null);
});

test('Calmar is CAGR over the absolute max drawdown, and null without one', () => {
  const d = ['2022-01-03', '2022-07-01', '2023-01-03'];
  const eq = [100, 50, 200];
  near(calmar(eq, d)!, cagr(eq, d) / 0.5, 1e-12);
  assert.equal(calmar([100, 110, 120], ['2022-01-03', '2022-07-01', '2023-01-03']), null);
});

test('profit factor and expectancy count dollars, not trades', () => {
  const ts = [
    trade({ pnl: 300, ret: 0.30 }),
    trade({ pnl: 100, ret: 0.10 }),
    trade({ pnl: -200, ret: -0.20 }),
    trade({ pnl: -200, ret: -0.20 }),
  ];
  near(profitFactor(ts)!, 400 / 400, 1e-12);
  const e = expectancy(ts);
  near(e.dollars, 0, 1e-12);
  near(e.pct, 0, 1e-12);
  assert.equal(e.n, 4);
  // All winners: the ratio is undefined rather than infinite.
  assert.equal(profitFactor([trade({ pnl: 5 })]), null);
  assert.equal(expectancy([]).n, 0);
});

test('exposure separates how much capital was at work from how often anything was', () => {
  const eq = [1000, 1000, 1000, 1000];
  const held = [0, 500, 1000, 0];
  const cnt = [0, 5, 10, 0];
  const x = exposure(eq, held, cnt);
  near(x.avgCapitalHeld, (0 + 0.5 + 1 + 0) / 4, 1e-12);
  near(x.pctDaysWithPosition, 0.5, 1e-12);
  near(x.avgNames, 15 / 4, 1e-12);
});

test('the longest losing streak is counted in exit order, not entry order', () => {
  const ts = [
    trade({ exitDate: '2023-05-01', pnl: -1 }),
    trade({ exitDate: '2023-01-01', pnl: -1 }),
    trade({ exitDate: '2023-02-01', pnl: -1 }),
    trade({ exitDate: '2023-03-01', pnl: 5 }),
    trade({ exitDate: '2023-04-01', pnl: -1 }),
  ];
  // Sorted by exit: -1, -1, +5, -1, -1  ->  longest run is 2.
  assert.equal(longestLosingStreak(ts), 2);
  assert.equal(longestLosingStreak([]), 0);
  assert.equal(longestLosingStreak([trade({ pnl: 1 })]), 0);
});

test('drawdown episodes name the peak, the trough and the recovery, and say when there was none', () => {
  const eq = [100, 80, 100, 120, 60, 70];
  const d = dates(eq.length);
  const eps = drawdownEpisodes(d, eq);
  // Two episodes: -20% recovered, and -50% never recovered.
  assert.equal(eps.length, 2);
  near(eps[0].depth, 60 / 120 - 1, 1e-12);
  assert.equal(eps[0].recovered, false);
  assert.equal(eps[0].peakDate, d[3]);
  assert.equal(eps[0].troughDate, d[4]);
  assert.equal(eps[0].recoveryDate, null);
  near(eps[1].depth, 80 / 100 - 1, 1e-12);
  assert.equal(eps[1].recovered, true);
  assert.equal(eps[1].recoveryDate, d[2]);
  assert.equal(eps[1].recoveryDays, 1);

  const dur = drawdownDuration(d, eq);
  assert.equal(dur.recovered, false);
  assert.equal(dur.from, d[3]);
  assert.equal(dur.to, d[eq.length - 1]);
  assert.equal(dur.days, eq.length - 1 - 3);
});

test('the exit-reason table groups every stop width under one heading and sorts by damage', () => {
  const ts = [
    trade({ reason: 'stop -12%', pnl: -100, ret: -0.13, barsHeld: 4 }),
    trade({ reason: 'stop -15%', pnl: -200, ret: -0.16, barsHeld: 6 }),
    trade({ reason: 'trim +20%', pnl: 150, ret: 0.15, barsHeld: 20 }),
    trade({ reason: 'delisted', pnl: -10, ret: -0.01, barsHeld: 100 }),
  ];
  const rows = exitReasonTable(ts);
  const stop = rows.find((r) => r.reason === 'stop')!;
  assert.equal(stop.count, 2);
  near(stop.totalPnl, -300, 1e-12);
  near(stop.meanRet, (-0.13 + -0.16) / 2, 1e-12);
  near(stop.meanHoldBars, 5, 1e-12);
  assert.equal(rows[0].reason, 'stop', 'the worst reason leads the table');
  assert.equal(rows[rows.length - 1].reason, 'trim +20%');
});

test('excursions split winners from losers and report both directions', () => {
  const ts = [
    trade({ pnl: 100, mae: -0.10, mfe: 0.30 }),
    trade({ pnl: 50, mae: -0.02, mfe: 0.20 }),
    trade({ pnl: -100, mae: -0.20, mfe: 0.05 }),
    trade({ pnl: -50, mae: -0.14, mfe: 0.15 }),
  ];
  const x = excursions(ts);
  assert.equal(x.winners.n, 2);
  assert.equal(x.losers.n, 2);
  near(x.winners.meanMae, -0.06, 1e-12);
  near(x.losers.meanMfe, 0.10, 1e-12);
  // A loser whose best excursion was +15% got past a +20% trim by less than
  // five points; that is exactly the number this table exists to show.
  assert.ok(x.losers.meanMfe > 0);
});

test('stats ties every headline figure back to the curve it came from', () => {
  const d = dates(60);
  const eq = d.map((_, i) => 10000 * Math.pow(1.001, i));
  const s = stats(d, eq, [trade({ pnl: 10, ret: 0.01 }), trade({ pnl: -20, ret: -0.02 })]);
  assert.equal(s.n, 60);
  near(s.startEquity, 10000, 1e-9);
  near(s.totalReturn, eq[59] / eq[0] - 1, 1e-12);
  near(s.maxDD, 0, 1e-12);
  assert.equal(s.trades, 2);
  assert.equal(s.wins, 1);
  assert.equal(s.losses, 1);
  near(s.winRate!, 0.5, 1e-12);
});

test('the block bootstrap preserves the return stream and reports an honest spread', () => {
  const eq = [10000];
  // A deterministic sawtooth, so every replicate is drawn from the same pool.
  for (let i = 0; i < 500; i++) eq.push(eq[i] * (1 + (i % 5 === 0 ? -0.03 : 0.008)));
  const mc = blockBootstrap(eq, 300, 20, 42);
  assert.equal(mc.replicates, 300);
  assert.equal(mc.blockDays, 20);
  near(mc.observedReturn, eq[eq.length - 1] / eq[0] - 1, 1e-12);
  assert.ok(mc.ret.p5 <= mc.ret.p50 && mc.ret.p50 <= mc.ret.p95, 'percentiles are ordered');
  assert.ok(mc.maxDD.p5 <= mc.maxDD.p50 && mc.maxDD.p50 <= mc.maxDD.p95);
  assert.ok(mc.maxDD.p95 <= 0, 'a drawdown is never positive');
  assert.ok(mc.pctPositive >= 0 && mc.pctPositive <= 1);
  // The same seed gives the same answer twice.
  assert.deepEqual(blockBootstrap(eq, 300, 20, 42), mc);
  // Too short a series returns zero replicates rather than a fabricated one.
  assert.equal(blockBootstrap([100, 101, 102], 100, 20).replicates, 0);
});
