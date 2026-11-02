import test from 'node:test';
import assert from 'node:assert/strict';

import { modelOrMarket, workingTest } from '../verdict.ts';
import {
  APPROVED_HOLDOUT,
  JOHN_STATED_TARGET_PCT_PER_MONTH,
  MARKET_TIE_BAND_POINTS,
  NOISE_FLOOR_MONTHS,
  NOISE_FLOOR_TRADES,
  WORKING_TARGET_PCT_PER_MONTH,
} from '../constants.ts';

// Every verdict below is drawn on a book with enough months behind it. The gate
// itself is exercised by its own tests; these are about the sentences.
const base = { benchmarkName: 'SPY', monthsOfEquity: 12 };

test('the thresholds come off the approved holdout, not off the old cross rule', () => {
  // The two that moved. 20 closed trades is most of a year for a rule that
  // rebalances monthly, and 10 percent a month is above anything it produced.
  assert.equal(NOISE_FLOOR_MONTHS, 12);
  assert.equal(WORKING_TARGET_PCT_PER_MONTH, 7);
  assert.equal(JOHN_STATED_TARGET_PCT_PER_MONTH, 10);
  // The bucket floor stays in trades, because that is what a bucket is.
  assert.equal(NOISE_FLOOR_TRADES, 20);
  assert.equal(MARKET_TIE_BAND_POINTS, 1);

  // And the target is the holdout's own compounded monthly rate, not a wish:
  // 1.07 ^ 12 is +125.2%, and the holdout net was +125.81%.
  const implied = (Math.pow(1 + WORKING_TARGET_PCT_PER_MONTH / 100, APPROVED_HOLDOUT.months) - 1) * 100;
  assert.ok(Math.abs(implied - APPROVED_HOLDOUT.netTotalReturnPct) < 1, `${implied} is not the holdout`);

  const v = modelOrMarket({ ...base, netReturnPct: 7.22, benchmarkReturnPct: 2.4, tradeCount: 25 });
  assert.deepEqual(v.thresholds, { noiseFloorMonths: 12, tieBandPoints: 1 });
});

test('the holdout carries the whole shape of its worst fall, not just how deep', () => {
  // strategy-summary-v2.json, candidate xmom-12-1-top200, block holdout: maxDD
  // -0.5097, ddFrom 2025-10-15, ddTo 2025-12-17, ddDurationDays 136.
  //
  // The depth was already here. The two dates were in nobody's code and the
  // recovery was a literal typed into src/pages/score.astro, which made the one
  // number a reader would most want to argue with the one number with no source.
  assert.equal(APPROVED_HOLDOUT.maxDrawdownPct, -50.97);
  assert.equal(APPROVED_HOLDOUT.drawdownFrom, '2025-10-15');
  assert.equal(APPROVED_HOLDOUT.drawdownTo, '2025-12-17');
  assert.equal(APPROVED_HOLDOUT.drawdownRecoveryDays, 136);

  // The three are consistent with each other and with the holdout's own window:
  // the fall starts inside the test year, the trough is after the high, and the
  // recovery is measured from the high rather than from the trough, so it is
  // longer than the gap between the two dates.
  const day = 86_400_000;
  const from = Date.parse(`${APPROVED_HOLDOUT.drawdownFrom}T00:00:00Z`);
  const to = Date.parse(`${APPROVED_HOLDOUT.drawdownTo}T00:00:00Z`);
  const start = Date.parse(`${APPROVED_HOLDOUT.startDate}T00:00:00Z`);
  const end = Date.parse(`${APPROVED_HOLDOUT.endDate}T00:00:00Z`);
  assert.ok(from > start && to < end, 'the fall is not inside the test year');
  assert.ok(to > from, 'the trough is before the high');
  assert.ok(
    APPROVED_HOLDOUT.drawdownRecoveryDays > (to - from) / day,
    'the recovery is shorter than the fall it recovered from',
  );
  assert.ok(from + APPROVED_HOLDOUT.drawdownRecoveryDays * day <= end, 'it recovered after the test year ended');
});

test('under the noise floor nothing is claimed, and the floor is MONTHS not trades', () => {
  // Forty closed trades and a 40 point lead. Three months of equity, so no claim.
  const v = modelOrMarket({
    ...base, monthsOfEquity: 3, netReturnPct: 40, benchmarkReturnPct: 2, tradeCount: 40,
  });
  assert.equal(v.kind, 'within-noise');
  assert.equal(v.withinNoise, true);
  assert.match(v.sentence, /^Within noise: 3 months of equity is too short to say\./);
  assert.match(v.sentence, /12 months is the floor for calling it/);
  // The figures are still carried, they are just not turned into a claim.
  assert.equal(v.excessPoints, 38);
  assert.equal(v.tradeCount, 40);
});

test('a thin trade count no longer withholds a claim once the months are there', () => {
  // Two closed trades, but a full year of equity. The old floor called this
  // noise for eight months at a stretch; a month-end rule closes what it closes.
  const v = modelOrMarket({ ...base, netReturnPct: 40, benchmarkReturnPct: 2, tradeCount: 2 });
  assert.equal(v.kind, 'beat');
  assert.equal(v.withinNoise, false);
});

test('one month short of the floor still withholds it', () => {
  const v = modelOrMarket({
    ...base, monthsOfEquity: 11.9, netReturnPct: 40, benchmarkReturnPct: 2, tradeCount: 30,
  });
  assert.equal(v.kind, 'within-noise');
});

test('beat the market', () => {
  const v = modelOrMarket({ ...base, netReturnPct: 7.2179, benchmarkReturnPct: 2.4, tradeCount: 25 });
  assert.equal(v.kind, 'beat');
  assert.equal(v.sentence, 'Beat the market by 4.8 points over 12 months. The book is +7.22% net against SPY +2.40%.');
});

test('fell with the market, and the market fell more', () => {
  const v = modelOrMarket({ ...base, netReturnPct: -9.64, benchmarkReturnPct: -15, tradeCount: 25 });
  assert.equal(v.kind, 'fell-less-than-market');
  assert.match(v.sentence, /^Fell with the market; the market fell more\./);
  // Never phrased as beating the market on a losing quarter.
  assert.doesNotMatch(v.sentence, /Beat the market/);
});

test('fell with the market and fell further', () => {
  const v = modelOrMarket({ ...base, netReturnPct: -15, benchmarkReturnPct: -9.64, tradeCount: 25 });
  assert.equal(v.kind, 'fell-more-than-market');
  assert.match(v.sentence, /^Fell with the market, and further than it did: 5\.4 points worse over 12 months\./);
});

test('fell while the market rose: the sentence that pulls the plug', () => {
  const v = modelOrMarket({ ...base, netReturnPct: -7.44, benchmarkReturnPct: 4, tradeCount: 22 });
  assert.equal(v.kind, 'model-not-market');
  assert.match(v.sentence, /^Fell while the market rose: this is the model, not the market\./);
});

test('a flat market with a losing book still reads as the model', () => {
  const v = modelOrMarket({ ...base, netReturnPct: -0.5, benchmarkReturnPct: 0, tradeCount: 25 });
  assert.equal(v.kind, 'model-not-market');
});

test('trailing a rising market is trailing, not falling', () => {
  const v = modelOrMarket({ ...base, netReturnPct: 1.5, benchmarkReturnPct: 3, tradeCount: 25 });
  assert.equal(v.kind, 'trailed');
  assert.match(v.sentence, /^Trailed the market by 1\.5 points over 12 months\./);
});

test('the tie band stops a rounding error printing as a win', () => {
  assert.equal(modelOrMarket({ ...base, netReturnPct: 3.5, benchmarkReturnPct: 2.5, tradeCount: 25 }).kind, 'matched');
  assert.equal(modelOrMarket({ ...base, netReturnPct: 2.5, benchmarkReturnPct: 3.5, tradeCount: 25 }).kind, 'matched');
  assert.equal(modelOrMarket({ ...base, netReturnPct: 3.51, benchmarkReturnPct: 2.5, tradeCount: 25 }).kind, 'beat');
  assert.equal(modelOrMarket({ ...base, netReturnPct: 2.49, benchmarkReturnPct: 3.5, tradeCount: 25 }).kind, 'trailed');
});

test('the tie band and the noise floor can be overridden explicitly', () => {
  const v = modelOrMarket({
    ...base, monthsOfEquity: 2, netReturnPct: 3.5, benchmarkReturnPct: 2.5, tradeCount: 10,
    tieBandPoints: 0.5, noiseFloorMonths: 1,
  });
  assert.equal(v.kind, 'beat');
  assert.deepEqual(v.thresholds, { noiseFloorMonths: 1, tieBandPoints: 0.5 });
});

test('working: the monthly rate compounds, it is not divided', () => {
  const v = workingTest({ netReturnPct: 33.1, months: 3, tradeCount: 25, noiseFloorMonths: 1 });
  assert.equal(v.avgMonthlyNetPct, 10);
  assert.equal(v.kind, 'working');
  // Dividing 33.1 by three would print 11.03 and flatter the book.
  assert.notEqual(v.avgMonthlyNetPct, 11.03);
});

test('working: the target is the 7% the approved holdout produced', () => {
  const v = workingTest({ netReturnPct: 7.2179, months: 2.9569, tradeCount: 25, noiseFloorMonths: 1 });
  assert.equal(v.avgMonthlyNetPct, 2.38);
  assert.equal(v.kind, 'not-working');
  assert.match(v.sentence, /against the 7% the approved holdout produced, on 25 closed trades\.$/);
  // A book running at 7.5 a month is working now, and used to be "not at the target".
  const good = workingTest({ netReturnPct: 7.5, months: 1, tradeCount: 2, noiseFloorMonths: 1 });
  assert.equal(good.kind, 'working');
});

test('working: under the months floor is too early, whatever the trade count', () => {
  assert.equal(workingTest({ netReturnPct: 5, months: 0.99, tradeCount: 40 }).kind, 'too-early');
  assert.equal(workingTest({ netReturnPct: 5, months: 6, tradeCount: 400 }).kind, 'too-early');
  const early = workingTest({ netReturnPct: 5, months: 6, tradeCount: 3 });
  assert.match(early.sentence, /6 months of equity, against a floor of 12 months/);
  // Both numbers are said out loud, so the owner can see his own beside the evidence.
  assert.match(early.sentence, /approved holdout ran at 7% a month for 12 months/);
  assert.match(early.sentence, /the owner's own number was 10%/);
});

test('working: a losing book reports a negative monthly rate, and a wipeout reports -100', () => {
  const opts = { noiseFloorMonths: 1 };
  assert.equal(workingTest({ ...opts, netReturnPct: -9.64, months: 2.9569, tradeCount: 25 }).avgMonthlyNetPct, -3.37);
  assert.equal(workingTest({ ...opts, netReturnPct: -100, months: 3, tradeCount: 25 }).avgMonthlyNetPct, -100);
  assert.equal(workingTest({ ...opts, netReturnPct: -9.64, months: 2.9569, tradeCount: 25 }).kind, 'not-working');
});
