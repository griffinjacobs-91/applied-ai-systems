import test from 'node:test';
import assert from 'node:assert/strict';

import {
  basketReturn,
  benchmarkReturn,
  excessOverBenchmark,
  findBenchmark,
  mainAccountReturn,
} from '../benchmarks.ts';
import { buildSeries, set25Trades, setCrash } from './fixtures.ts';

const W = { start: '2026-06-08', end: '2026-09-06' };

test('SPY over the same window as the book', () => {
  const spy = buildSeries('SPY', '2026-06-08', 90, 500, 512);
  const r = benchmarkReturn(spy, W)!;
  assert.equal(r.startClose, 500);
  assert.equal(r.endClose, 512);
  assert.equal(r.returnPct, 2.4);
  assert.equal(r.points, 91);
});

test('a benchmark that starts inside the window prices from its first close', () => {
  const late = { name: 'SPY', series: [{ date: '2026-07-01', close: 400 }, { date: '2026-08-01', close: 440 }] };
  const r = benchmarkReturn(late, W)!;
  assert.equal(r.startDate, '2026-07-01');
  assert.equal(r.returnPct, 10);
});

test('an empty benchmark series returns null rather than a zero', () => {
  assert.equal(benchmarkReturn({ name: 'SPY', series: [] }, W), null);
  // A zero would render as "SPY flat", which is a lie about missing data.
});

test('benchmarks are found by name, case and space insensitive', () => {
  const list = [buildSeries('spy ', '2026-06-08', 90, 500, 512)];
  assert.ok(findBenchmark(list, 'SPY'));
  assert.equal(findBenchmark(list, 'QQQ'), null);
  assert.equal(findBenchmark(undefined, 'SPY'), null);
});

test('excess is NET over the benchmark, in points', () => {
  assert.equal(excessOverBenchmark(7.2179, 2.4), 4.8179);
  assert.equal(excessOverBenchmark(-9.64, -15), 5.36);
  assert.equal(excessOverBenchmark(-7.44, 4), -11.44);
});

test('the Strong Buy basket is an equal weight buy and hold', () => {
  const b = basketReturn(set25Trades().input.basket!);
  // +8, -5, +8, +3, +6 over five names.
  assert.equal(b.returnPct, 4);
  assert.equal(b.namesScored, 5);
  assert.deepEqual(b.namesMissing, []);
  // Five names is a thin read and the basket says so.
  assert.equal(b.sample.n, 5);
  assert.equal(b.sample.withinNoise, true);
});

test('equal weight, not dollar weight: a big name does not dominate', () => {
  const b = basketReturn({
    name: 'basket',
    takenAt: '2026-06-08',
    holdings: [{ symbol: 'BIG', close: 1000 }, { symbol: 'SMALL', close: 1 }],
    current: [{ symbol: 'BIG', close: 1100 }, { symbol: 'SMALL', close: 1.3 }],
  });
  // +10 and +30 average to +20, whatever the share prices are.
  assert.equal(b.returnPct, 20);
});

test('a basket name with no closing price is excluded and named, not zeroed', () => {
  const b = basketReturn({
    name: 'basket',
    takenAt: '2026-06-08',
    holdings: [{ symbol: 'AAA', close: 50 }, { symbol: 'GONE', close: 10 }],
    current: [{ symbol: 'AAA', close: 55 }],
  });
  assert.equal(b.returnPct, 10);
  assert.deepEqual(b.namesMissing, ['GONE']);
  assert.equal(b.namesScored, 1);
});

test('the crash basket falls with the market', () => {
  assert.equal(basketReturn(setCrash().input.basket!).returnPct, -15);
});

test("the owner's main account line comes from two percent figures and composes", () => {
  // 20% up at the first upload, 24.8% up at the second: the window is +4%.
  assert.equal(mainAccountReturn({ startGainPct: 20, endGainPct: 24.8 }).returnPct, 4);
  // Not 4.8 points. Subtracting cumulative gains would overstate the window.
  assert.notEqual(mainAccountReturn({ startGainPct: 20, endGainPct: 24.8 }).returnPct, 4.8);
  assert.equal(mainAccountReturn({ startGainPct: 20, endGainPct: 4.4 }).returnPct, -13);
  assert.equal(mainAccountReturn({ startGainPct: 0, endGainPct: 7 }).returnPct, 7);
});

test('a main account down 100% at the start cannot be a base', () => {
  assert.throws(() => mainAccountReturn({ startGainPct: -100, endGainPct: 0 }));
});

// ---------------------------------------------------------------------------
// Total return, which is what the approved sheet measured SPY on
// ---------------------------------------------------------------------------

test('a benchmark with no distributions is price return, and says so', () => {
  const spy = buildSeries('SPY', '2026-06-08', 90, 500, 512);
  const r = benchmarkReturn(spy, W)!;
  assert.equal(r.basis, 'price-return');
  assert.equal(r.distributionsCounted, 0);
  assert.equal(r.returnPct, r.priceReturnPct);
});

test('a distribution is reinvested at the ex-date close, exactly as buyHold does it', () => {
  // Flat at $100 for the whole window so the arithmetic is checkable by hand.
  const flat = {
    name: 'SPY',
    series: Array.from({ length: 91 }, (_, d) => ({
      date: new Date(Date.parse('2026-06-08T00:00:00.000Z') + d * 86_400_000).toISOString().slice(0, 10),
      close: 100,
    })),
    distributions: [{ exDate: '2026-07-08', amountPerShare: 1 }],
  };
  const r = benchmarkReturn(flat, W)!;
  // One share, $1 of cash on the ex-date, bought back at $100: 1.01 shares at
  // $100 is $101 against a $100 base.
  assert.equal(r.basis, 'total-return');
  assert.equal(r.distributionsCounted, 1);
  assert.equal(r.distributionsPerShare, 1);
  assert.equal(r.returnPct, 1);
  // The price line is still carried, and it is flat.
  assert.equal(r.priceReturnPct, 0);
});

test('total return is the bigger of the two on a rising series, and the gap is the dividend', () => {
  const spy = buildSeries('SPY', '2026-06-08', 90, 500, 512);
  const withDivs = {
    ...spy,
    distributions: [
      { exDate: '2026-06-20', amountPerShare: 1.75 },
      { exDate: '2026-08-20', amountPerShare: 1.8 },
    ],
  };
  const r = benchmarkReturn(withDivs, W)!;
  assert.equal(r.basis, 'total-return');
  assert.equal(r.distributionsCounted, 2);
  assert.ok(r.returnPct > r.priceReturnPct, `${r.returnPct} is not above ${r.priceReturnPct}`);
  // $3.55 of cash on a ~505 average close, put back into shares that then rise
  // with the series: about 0.7 points, and never wildly more than the cash paid
  // measured against the opening close.
  const gap = r.returnPct - r.priceReturnPct;
  assert.ok(gap > 0.6 && gap < 0.8, `${gap} is not the dividend`);
});

test('a distribution outside the window is not counted', () => {
  const spy = buildSeries('SPY', '2026-06-08', 90, 500, 512);
  const outside = { ...spy, distributions: [{ exDate: '2026-05-01', amountPerShare: 5 }] };
  const r = benchmarkReturn(outside, W)!;
  assert.equal(r.distributionsCounted, 0);
  assert.equal(r.basis, 'price-return');
  assert.equal(r.returnPct, 2.4);
});

test('a zero opening close is null, not a division by zero', () => {
  const broken = { name: 'SPY', series: [{ date: '2026-06-08', close: 0 }, { date: '2026-07-08', close: 400 }] };
  assert.equal(benchmarkReturn(broken, W), null);
});
