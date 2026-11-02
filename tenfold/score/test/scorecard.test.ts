import test from 'node:test';
import assert from 'node:assert/strict';

import { renderScorecardText, scorecard } from '../index.ts';
import type { ScoreInput } from '../types.ts';
import {
  FROZEN_NOW,
  set25Trades,
  set3Trades,
  setCrash,
  setModelNotMarket,
} from './fixtures.ts';

// The fixture windows are 90 days, and the standing floor for a VERDICT is 12
// months of equity. Every test below that is about the SENTENCE therefore lifts
// the floor to one month explicitly; the floor itself is proved by its own test
// at the bottom of this file, on the same fixture, with the default in place.
const PROSE = { now: FROZEN_NOW, noiseFloorMonths: 1 };

function card(set: { input: ScoreInput; window: { start: string; end: string; label?: string } }) {
  return scorecard(set.input, set.window, PROSE);
}

test('25 trades, quiet market: the assembled card', () => {
  const c = card(set25Trades());
  assert.equal(c.returns!.grossReturnPct, 9.8);
  assert.equal(c.returns!.netReturnPct, 7.2179);
  assert.equal(c.costs.totalUsd, 258.21);
  assert.equal(c.costs.dragPctPerMonth, 0.8733);
  assert.equal(c.benchmarks.spy!.returnPct, 2.4);
  assert.equal(c.benchmarks.excessNetOverSpyPoints, 4.8179);
  assert.equal(c.benchmarks.basket!.returnPct, 4);
  assert.equal(c.benchmarks.mainAccount!.returnPct, 4);
  assert.equal(c.trades.closed.n, 25);
  assert.equal(c.verdict!.kind, 'beat');
  assert.equal(c.working!.kind, 'not-working');
  assert.equal(c.working!.avgMonthlyNetPct, 2.38);
  // One warning, and it is the honest one: the fixture SPY series carries no
  // distributions, so the benchmark is price return and says so.
  assert.equal(c.warnings.length, 1);
  assert.match(c.warnings[0]!, /price return/);
  assert.equal(c.benchmarks.spy!.basis, 'price-return');
});

test('the verdict is drawn on NET, not gross: costs decide the sentence', () => {
  const s = set25Trades();
  // Gross beats SPY by 7.4 points. Net beats it by 4.82. With a fatter bill the
  // book can be ahead gross and behind net, and the card must say behind.
  const heavy: ScoreInput = {
    ...s.input,
    expenses: [
      ...s.input.expenses,
      { kind: 'model', vendor: 'Anthropic', amountUsd: 600, periodStart: '2026-06-08', periodEnd: '2026-07-07' },
    ],
  };
  const c = scorecard(heavy, s.window, PROSE);
  assert.equal(c.returns!.grossReturnPct, 9.8);
  assert.ok(c.returns!.netReturnPct < c.benchmarks.spy!.returnPct);
  assert.equal(c.verdict!.kind, 'trailed');
});

test('crash: fell with the market, and the market fell more', () => {
  const c = card(setCrash());
  assert.equal(c.returns!.netReturnPct, -9.64);
  assert.equal(c.benchmarks.spy!.returnPct, -15);
  assert.equal(c.verdict!.kind, 'fell-less-than-market');
  assert.equal(c.benchmarks.excessNetOverSpyPoints, 5.36);
  assert.equal(c.costs.margin.interestUsd, 0);
});

test('book down while the market is up: the model, not the market', () => {
  const c = card(setModelNotMarket());
  assert.equal(c.returns!.netReturnPct, -7.44);
  assert.equal(c.benchmarks.spy!.returnPct, 4);
  assert.equal(c.verdict!.kind, 'model-not-market');
  assert.equal(c.trades.closed.n, 22);
  assert.equal(c.trades.closed.withinNoise, false);
});

test('3 trades: the card refuses to draw a conclusion', () => {
  const c = card(set3Trades());
  assert.equal(c.trades.closed.n, 3);
  assert.equal(c.verdict!.kind, 'within-noise');
  assert.equal(c.working!.kind, 'too-early');
  // The figures are all still there. Only the claim is withheld.
  assert.equal(c.returns!.grossReturnPct, 0.8);
  assert.equal(c.returns!.netReturnPct, 0.12);
  assert.equal(c.benchmarks.spy!.returnPct, 1);
});

test('the card is a plain JSON tree with no clock of its own', () => {
  const s = set25Trades();
  const a = scorecard(s.input, s.window, PROSE);
  const b = scorecard(s.input, s.window, PROSE);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  assert.equal(a.generatedAt, FROZEN_NOW);
});

test('missing inputs become warnings, never silent zeros', () => {
  const s = set25Trades();
  const c = scorecard({ ...s.input, benchmarks: [], expenses: [] }, s.window, PROSE);
  assert.equal(c.benchmarks.spy, null);
  assert.equal(c.verdict, null);
  assert.equal(c.benchmarks.excessNetOverSpyPoints, null);
  assert.equal(c.warnings.length, 2);
  assert.match(c.warnings.join(' '), /No SPY series/);
  assert.match(c.warnings.join(' '), /No expenses fell in this window/);
});

test('an empty equity series produces no return and says so', () => {
  const s = set25Trades();
  const c = scorecard({ ...s.input, equity: [] }, s.window, PROSE);
  assert.equal(c.returns, null);
  assert.equal(c.verdict, null);
  assert.equal(c.working, null);
  assert.match(c.warnings.join(' '), /No equity snapshot/);
  // The render must not throw on a half empty card.
  assert.match(renderScorecardText(c), /no return to report/);
});

test('the Sunday review text carries the number, the verdict and the sample sizes', () => {
  const text = renderScorecardText(card(set25Trades()));
  assert.match(text, /^TENFOLD SCORECARD/);
  assert.match(text, /Net \+7\.22% \(\$721\.79 on \$10,000\.00 starting equity\)/);
  assert.match(text, /Gross \+9\.80%/);
  assert.match(text, /Expense drag 0\.87% of equity per month/);
  assert.match(text, /Beat the market by 4\.8 points over 3 months\./);
  assert.match(text, /Not at the target: \+2\.38% a month net/);
  assert.match(text, /against the 7% the approved holdout produced/);
  assert.match(text, /Win rate: 60\.00% on 25 trades/);
  assert.match(text, /Average win: \+13\.47% \(\$134\.67\) on 15 wins \(within noise\)/);
  assert.match(text, /Agreement with the owner: 85\.00% on 20 votes/);
  assert.match(text, /real fills 0\.14% worse than paper on 25 fills/);
  assert.match(text, /Observations only\./);
  assert.match(text, /A verdict needs 1 months of equity, and a bucket under 20 trades is shown but marked within noise\./);
  assert.match(text, /the approved holdout, 5 Sept 2025 to 4 Sept 2026: \+125\.81% net over 12 months against SPY \+20\.31% total return, worst drawdown -50\.97%\.$/);
  // No emoji, no tables, no em dashes in the email body.
  assert.doesNotMatch(text, /[—–]/);
  assert.doesNotMatch(text, /\|/);
});

test('the crash review says fell with the market and shows no margin was carried', () => {
  const text = renderScorecardText(card(setCrash()));
  assert.match(text, /Net -9\.64%/);
  assert.match(text, /Fell with the market; the market fell more\./);
  assert.match(text, /SPY -15\.00% \(price return, no distributions supplied\), net is 5\.36 points ahead/);
  assert.match(text, /no margin was carried in this window/);
  assert.match(text, /25 of 25 closed trades never reached their target \(100%\)/);
});

// ---------------------------------------------------------------------------
// The floor itself, on the same fixture, with nothing overridden
// ---------------------------------------------------------------------------

test('with the standing floor in place, 90 days of equity draws no verdict at all', () => {
  // 25 closed trades and a 4.8 point lead over SPY. The old floor counted
  // trades, so this printed "Beat the market" off three months of history.
  const s = set25Trades();
  const c = scorecard(s.input, s.window, { now: FROZEN_NOW });
  assert.equal(c.trades.closed.n, 25);
  assert.equal(c.noiseFloorMonths, 12);
  assert.equal(c.verdict!.kind, 'within-noise');
  assert.match(c.verdict!.sentence, /3 months of equity is too short to say/);
  assert.equal(c.working!.kind, 'too-early');
  // Every figure is still on the card. Only the claim is withheld.
  assert.equal(c.returns!.netReturnPct, 7.2179);
  assert.equal(c.benchmarks.excessNetOverSpyPoints, 4.8179);
});

test('the card carries the evidence its thresholds were set from', () => {
  const c = card(set25Trades());
  assert.equal(c.approvedHoldout.id, 'xmom-12-1-top200');
  assert.equal(c.approvedHoldout.months, 12);
  assert.equal(c.approvedHoldout.netTotalReturnPct, 125.81);
  assert.equal(c.approvedHoldout.spyTotalReturnPct, 20.31);
  assert.equal(c.approvedHoldout.maxDrawdownPct, -50.97);
});

test('a window that opens on zero equity returns null rather than throwing', () => {
  // A book funded part way through the window. pctChange used to throw here and
  // the throw reached /score as a 500.
  const s = set25Trades();
  const zeroed = s.input.equity.map((p, i) => (i === 0 ? { ...p, equity: 0 } : p));
  const c = scorecard({ ...s.input, equity: [zeroed[0]!] }, s.window, PROSE);
  assert.equal(c.returns, null);
  assert.equal(c.verdict, null);
  assert.equal(c.working, null);
  assert.match(renderScorecardText(c), /no return to report/);
});
