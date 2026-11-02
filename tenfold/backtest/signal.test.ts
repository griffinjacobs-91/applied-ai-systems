// Fixture tests for the signal math. Every expected number below is computed
// by hand from the fixture definition and written out in the comment beside it,
// so the test proves the code, not a second copy of the code.
//
//   node --experimental-strip-types --test backtest/signal.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sma, stochastic, crossUp, crossDown, signalOn, reverseCrossOn, indicators,
  type Series,
} from './signal.ts';

const near = (a: number | null, b: number, eps = 1e-9) => {
  assert.notEqual(a, null);
  assert.ok(Math.abs((a as number) - b) < eps, `expected ${b}, got ${a}`);
};

// ---------------------------------------------------------------- fixture A
// 60 bars, strictly rising by 1: close[i] = 100 + i.
// Hand math: the mean of the 10 values ending at i is 100 + i - 4.5, and the
// mean of the 30 values ending at i is 100 + i - 14.5. So the 10-day is always
// exactly 10.0 above the 30-day and there is never a cross.
const A: Series = {
  close: Array.from({ length: 60 }, (_, i) => 100 + i),
  high: Array.from({ length: 60 }, (_, i) => 100 + i),
  low: Array.from({ length: 60 }, (_, i) => 100 + i),
  volume: new Array(60).fill(1_000_000),
};

test('sma is null before the window fills, then exact', () => {
  const s10 = sma(A.close, 10);
  assert.equal(s10[8], null);            // only 9 values seen
  near(s10[9], 104.5);                   // mean(100..109) = 104.5
  near(s10[59], 154.5);                  // mean(150..159) = 154.5
  const s30 = sma(A.close, 30);
  assert.equal(s30[28], null);
  near(s30[29], 114.5);                  // mean(100..129) = 114.5
  near(s30[59], 144.5);                  // mean(130..159) = 144.5
});

test('a monotone rise never crosses, so the buy signal never fires', () => {
  const ind = indicators(A);
  for (let i = 0; i < 60; i++) {
    assert.equal(crossUp(ind.fast, ind.slow, i), false, `crossUp at ${i}`);
    assert.equal(crossDown(ind.fast, ind.slow, i), false, `crossDown at ${i}`);
    assert.equal(signalOn(i, A, ind), null, `signal at ${i}`);
  }
});

test('stochastic on a monotone rise pins at 100', () => {
  const { k, d } = stochastic(A.high, A.low, A.close, 14);
  assert.equal(k[12], null);             // needs 14 bars
  near(k[13], 100);                      // close is the highest high
  near(k[59], 100);
  near(d[59], 100);                      // mean of three 100s
});

// ---------------------------------------------------------------- fixture B
// 60 bars: flat at 100 for indices 0..39, then rising by 1 from index 40.
//   close[i] = 100            for i <= 39
//   close[i] = 100 + (i - 39) for i >= 40
// Hand math at i = 40: the last 10 closes are nine 100s and one 101, so the
// 10-day is (900 + 101)/10 = 100.1. The last 30 are twenty-nine 100s and one
// 101, so the 30-day is (2900 + 101)/30 = 100.0333... At i = 39 both are
// exactly 100, so the 10 crosses up through the 30 on bar 40.
const B: Series = (() => {
  const close = Array.from({ length: 60 }, (_, i) => (i <= 39 ? 100 : 100 + (i - 39)));
  return { close, high: [...close], low: [...close], volume: new Array(60).fill(1_000_000) };
})();

test('the flat-then-rise fixture crosses up exactly on bar 40', () => {
  const ind = indicators(B);
  near(ind.fast[39], 100);
  near(ind.slow[39], 100);
  near(ind.fast[40], 100.1);             // (900 + 101) / 10
  near(ind.slow[40], 3001 / 30);         // (2900 + 101) / 30 = 100.03333...
  assert.equal(crossUp(ind.fast, ind.slow, 40), true);
  // and nowhere else in the series
  for (let i = 0; i < 60; i++) {
    if (i !== 40) assert.equal(crossUp(ind.fast, ind.slow, i), false, `unexpected crossUp at ${i}`);
  }
});

test('buy fires on the cross bar and for the next four bars, then stops', () => {
  const ind = indicators(B);
  const day = (i: number) => signalOn(i, B, ind);

  const at40 = day(40);
  assert.ok(at40, 'should fire on the cross bar');
  assert.equal(at40!.crossAgo, 0);

  // i = 44: 10-day = (100*5 + 101+102+103+104+105)/10 = 1015/10 = 101.5
  //         30-day = (100*25 + 515)/30 = 3015/30 = 100.5 ; close 105 > both
  const at44 = day(44);
  assert.ok(at44, 'should still fire four bars after the cross');
  assert.equal(at44!.crossAgo, 4);
  near(ind.fast[44], 101.5);
  near(ind.slow[44], 100.5);

  // i = 45 is five bars after the cross: outside the 5-day window.
  assert.equal(day(45), null, 'the 5-day cross window must expire on the sixth bar');
  assert.equal(day(50), null);
});

test('stochastic is reported on the signal, and is a preference not a veto', () => {
  const ind = indicators(B);
  // At i = 44 the 14-bar window is bars 31..44: nine 100s then 101..105.
  // highest high 105, lowest low 100, close 105 -> %K = 100*(105-100)/5 = 100.
  near(ind.k[44], 100);
  const sig = signalOn(44, B, ind);
  assert.ok(sig, 'a %K of 100 is the worst possible reading and must still fire');
  near(sig!.k, 100);
});

test('a flat range yields the neutral 50 rather than a divide by zero', () => {
  const { k } = stochastic(B.high, B.low, B.close, 14);
  near(k[20], 50);                       // bars 7..20 are all exactly 100
  assert.ok(Number.isFinite(k[20] as number));
});

// ---------------------------------------------------------------- fixture C
// The mirror of B: flat at 100 for 0..39, then falling by 1.
//   close[i] = 100 - (i - 39) for i >= 40
// Hand math at i = 40: 10-day = (900 + 99)/10 = 99.9, 30-day = (2900 + 99)/30
// = 99.9666... so the 10 is below the 30, and close 99 is below both.
const C: Series = (() => {
  const close = Array.from({ length: 60 }, (_, i) => (i <= 39 ? 100 : 100 - (i - 39)));
  return { close, high: [...close], low: [...close], volume: new Array(60).fill(1_000_000) };
})();

test('the flat-then-fall fixture triggers the reverse cross on bar 40', () => {
  const ind = indicators(C);
  near(ind.fast[40], 99.9);              // (900 + 99) / 10
  near(ind.slow[40], 2999 / 30);         // (2900 + 99) / 30 = 99.96666...
  assert.equal(crossDown(ind.fast, ind.slow, 40), true);
  assert.equal(reverseCrossOn(40, C, ind), true);
  // The sell needs BOTH the cross and the close below both averages, so it is
  // a one-bar event, not a standing condition.
  assert.equal(reverseCrossOn(41, C, ind), false);
  assert.equal(reverseCrossOn(39, C, ind), false);
});

test('the sell requires the close below both averages, not just the cross', () => {
  // Cross down on bar 40 as in C, but bar 40 closes back above both averages.
  const close = [...C.close];
  close[40] = 101;                       // a gap back up on the cross bar
  const D: Series = { close, high: [...close], low: [...close], volume: new Array(60).fill(1e6) };
  const ind = indicators(D);
  // 10-day = (900 + 101)/10 = 100.1 ; 30-day = (2900 + 101)/30 = 100.0333
  near(ind.fast[40], 100.1);
  assert.equal(crossDown(ind.fast, ind.slow, 40), false, 'the gap up cancels the cross');
  assert.equal(reverseCrossOn(40, D, ind), false);
});

test('20-day average volume comes out of the same sma', () => {
  const v = [...new Array(40).fill(1_000_000), ...new Array(20).fill(400_000)];
  const S: Series = { ...B, volume: v };
  const ind = indicators(S);
  near(ind.avgVol20[39], 1_000_000);
  near(ind.avgVol20[49], 700_000);       // ten 1M and ten 400k
  near(ind.avgVol20[59], 400_000);
});
