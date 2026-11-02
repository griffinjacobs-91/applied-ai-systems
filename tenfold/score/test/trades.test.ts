import test from 'node:test';
import assert from 'node:assert/strict';

import {
  agreementStats,
  closedTradesInWindow,
  isClosed,
  scoreTrade,
  slippageStats,
  tradeStats,
} from '../trades.ts';
import type { Trade } from '../types.ts';
import { set25Trades, set3Trades } from './fixtures.ts';

const S = set25Trades();
const closed = closedTradesInWindow(S.input.trades, S.window);

test('open trades are never scored', () => {
  const open: Trade = {
    tradeId: 'X1', symbol: 'AAA', side: 'long', openedAt: '2026-06-10', openPrice: 100,
    shares: 10, stopPrice: 88, targetPrice: 120, outcome: 'open',
  };
  assert.equal(isClosed(open), false);
  assert.equal(scoreTrade(open), null);
  // An open position is hope, not an outcome. Counting it would score the
  // engine against its own expectation.
  const stats = tradeStats([open]);
  assert.equal(stats.closed.n, 0);
  assert.equal(stats.winRatePct, null);
});

test('a trade counts in the window it closed in, not the one it opened in', () => {
  const t: Trade = {
    tradeId: 'X2', symbol: 'AAA', side: 'long', openedAt: '2026-05-01', openPrice: 100,
    closedAt: '2026-07-01', closePrice: 110, shares: 10, stopPrice: 88, targetPrice: 120,
    outcome: 'closed',
  };
  assert.equal(closedTradesInWindow([t], { start: '2026-06-08', end: '2026-09-06' }).length, 1);
  assert.equal(closedTradesInWindow([t], { start: '2026-04-01', end: '2026-05-31' }).length, 0);
});

test('a short makes money when the price falls', () => {
  const s = scoreTrade({
    tradeId: 'X3', symbol: 'AAA', side: 'short', openedAt: '2026-06-10', openPrice: 100,
    closedAt: '2026-06-20', closePrice: 90, shares: 10, stopPrice: 112, targetPrice: 80,
    outcome: 'closed',
  })!;
  assert.equal(s.pnlUsd, 100);
  assert.equal(s.returnPct, 10);
  assert.equal(s.holdDays, 10);
});

test('the 25 trade set: win rate, averages and holds, all with n', () => {
  const t = tradeStats(closed);
  assert.equal(t.closed.n, 25);
  assert.equal(t.closed.withinNoise, false);
  assert.equal(t.winRatePct, 60);
  assert.equal(t.wins.n, 15);
  assert.equal(t.losses.n, 10);
  assert.equal(t.avgWinPct, 13.47);
  assert.equal(t.avgWinUsd, 134.67);
  assert.equal(t.avgLossPct, -18.4);
  assert.equal(t.avgLossUsd, -104);
  assert.equal(t.avgHoldDays, 12.4);
  assert.equal(t.medianHoldDays, 13);
  assert.equal(t.totalPnlUsd, 980);
});

test('exit counts split cleanly and add to the closed total', () => {
  const t = tradeStats(closed);
  assert.equal(t.stoppedOut, 6);
  assert.equal(t.targetHit, 8);
  assert.equal(t.expired, 1);
  assert.equal(t.closedByHand, 10);
  assert.equal(t.stoppedOut + t.targetHit + t.expired + t.closedByHand, t.closed.n);
});

test('three trades is flagged within noise on every bucket', () => {
  const s = set3Trades();
  const t = tradeStats(closedTradesInWindow(s.input.trades, s.window));
  assert.equal(t.closed.n, 3);
  assert.equal(t.closed.withinNoise, true);
  assert.equal(t.wins.withinNoise, true);
  assert.equal(t.losses.withinNoise, true);
  // The figure is still produced. It is labelled, not hidden.
  assert.equal(t.winRatePct, 66.67);
});

test('agreement rate counts agree against disagree; unsure is not a vote', () => {
  const a = agreementStats(S.input.verdicts, closed);
  assert.equal(a.agree, 17);
  assert.equal(a.disagree, 3);
  assert.equal(a.unsure, 4);
  assert.equal(a.sample.n, 20);
  assert.equal(a.sample.withinNoise, false);
  assert.equal(a.agreementRatePct, 85);
});

test('verdicts on trades outside the window are reported, not silently dropped', () => {
  const a = agreementStats([{ tradeId: 'NOPE', verdict: 'agree' }], closed);
  assert.equal(a.unmatched, 1);
  assert.equal(a.agreementRatePct, null);
  assert.equal(a.sample.n, 0);
});

test('slippage is positive when the real book paid up against paper', () => {
  const s = slippageStats(S.input.paperFills, closed);
  assert.equal(s.sample.n, 25);
  assert.equal(s.byMode['alpaca']!.n, 15);
  assert.equal(s.byMode['alpaca']!.avgSlippagePct, 0.2004);
  assert.equal(s.byMode['simulated']!.n, 10);
  assert.equal(s.byMode['simulated']!.avgSlippagePct, 0.05);
  assert.equal(s.avgSlippagePct, 0.1402);
  assert.equal(s.worstSlippagePct, 0.2004);
  assert.equal(s.bestSlippagePct, 0.05);
});

test('slippage flips sign for a short, so positive is always worse for the book', () => {
  const shortTrade: Trade = {
    tradeId: 'S1', symbol: 'AAA', side: 'short', openedAt: '2026-06-10', openPrice: 99,
    closedAt: '2026-06-20', closePrice: 90, shares: 10, stopPrice: 112, targetPrice: 80,
    outcome: 'closed',
  };
  // Sold short at 99 where paper sold at 100: a dollar of edge given away.
  const s = slippageStats([{ tradeId: 'S1', price: 100, mode: 'alpaca' }], [shortTrade]);
  assert.equal(s.avgSlippagePct, 1);
  const longTrade: Trade = { ...shortTrade, tradeId: 'L1', side: 'long' };
  // Bought at 99 where paper bought at 100: a dollar of edge gained.
  const l = slippageStats([{ tradeId: 'L1', price: 100, mode: 'alpaca' }], [longTrade]);
  assert.equal(l.avgSlippagePct, -1);
});

test('no paper fills means null, not zero slippage', () => {
  const s = slippageStats(undefined, closed);
  assert.equal(s.avgSlippagePct, null);
  assert.equal(s.sample.n, 0);
});
