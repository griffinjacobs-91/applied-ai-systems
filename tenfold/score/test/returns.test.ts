import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cashFlowsOf,
  equityEndpoints,
  expenseDragPctPerMonth,
  expensesForWindow,
  grossReturn,
  marginInterest,
  netReturn,
  restateForCashEvents,
} from '../returns.ts';
import { DAYS_PER_MONTH } from '../constants.ts';
import type { EquityPoint, Expense } from '../types.ts';
import { addDays, buildEquity, buildExpenses, set25Trades, setCrash } from './fixtures.ts';

const W = { start: '2026-06-08', end: '2026-09-06' };

test('equity endpoints take the last snapshot on or before each edge', () => {
  const eq: EquityPoint[] = [
    { date: '2026-06-05', equity: 9_900, cash: 0, marginUsed: 0 },
    { date: '2026-06-08', equity: 10_000, cash: 0, marginUsed: 0 },
    { date: '2026-07-01', equity: 10_500, cash: 0, marginUsed: 0 },
    { date: '2026-09-06', equity: 11_000, cash: 0, marginUsed: 0 },
    { date: '2026-09-20', equity: 12_000, cash: 0, marginUsed: 0 },
  ];
  const e = equityEndpoints(eq, W)!;
  assert.equal(e.startEquity, 10_000);
  assert.equal(e.endEquity, 11_000);
  assert.equal(e.days, 90);
  assert.equal(e.points, 3);
});

test('equity endpoints return null on an empty series', () => {
  assert.equal(equityEndpoints([], W), null);
  assert.equal(grossReturn([], W), null);
  assert.equal(netReturn([], [], W), null);
});

test('gross return is the equity change over the window', () => {
  const g = grossReturn(buildEquity('2026-06-08', 90, 10_000, set25Trades().specs, 0), W)!;
  assert.equal(g.grossPnlUsd, 980);
  assert.equal(g.grossReturnPct, 9.8);
});

test('expenses are prorated by day where a charge straddles the window edge', () => {
  const rows: Expense[] = [
    // Fully inside.
    { kind: 'subscription', vendor: 'Massive', amountUsd: 30, periodStart: '2026-06-10', periodEnd: '2026-06-19' },
    // Half in: 10 day period, 5 days inside the window that ends 2026-09-06.
    { kind: 'subscription', vendor: 'Supabase', amountUsd: 10, periodStart: '2026-09-02', periodEnd: '2026-09-11' },
    // Entirely outside.
    { kind: 'model', vendor: 'Anthropic', amountUsd: 99, periodStart: '2026-03-01', periodEnd: '2026-03-31' },
  ];
  const x = expensesForWindow(rows, W);
  assert.equal(x.totalUsd, 35);
  assert.equal(x.byKind['subscription'], 35);
  assert.equal(x.byKind['model'], undefined);
  assert.equal(x.lines.length, 2);
});

test("Griffin's standing bill lands as $50 a month of subscriptions plus model spend", () => {
  const x = expensesForWindow(buildExpenses('2026-06-08', 3, 18), W);
  assert.equal(x.byKind['subscription'], 150);
  assert.equal(x.byKind['model'], 54);
  assert.equal(x.totalUsd, 204);
  assert.equal(x.byVendor['Massive'], 90);
  assert.equal(x.byVendor['RapidAPI'], 30);
  assert.equal(x.byVendor['Supabase'], 30);
});

test('expense drag: $50 a month is 0.5% of a $10k book and 0.05% of a $100k book', () => {
  assert.equal(expenseDragPctPerMonth(50, 10_000, DAYS_PER_MONTH), 0.5);
  assert.equal(expenseDragPctPerMonth(50, 100_000, DAYS_PER_MONTH), 0.05);
  // Same bill, ten times the book, one tenth the drag. That is the whole point.
  assert.equal(
    expenseDragPctPerMonth(50, 10_000, DAYS_PER_MONTH) /
      expenseDragPctPerMonth(50, 100_000, DAYS_PER_MONTH),
    10,
  );
});

test('expense drag is zero when there is no base or no elapsed time', () => {
  assert.equal(expenseDragPctPerMonth(50, 0, 30), 0);
  assert.equal(expenseDragPctPerMonth(50, 10_000, 0), 0);
});

test('margin interest accrues on the balance actually held, day by day', () => {
  const eq = buildEquity('2026-06-08', 90, 10_000, [], 2000);
  const m = marginInterest(eq, W, 11);
  // 2000 * 11% * 90/365.25
  assert.equal(m.interestUsd, 54.21);
  assert.equal(m.daysAccrued, 90);
  assert.equal(m.avgMarginUsedUsd, 2000);
  assert.equal(m.maxMarginUsedUsd, 2000);
  assert.equal(m.pctOfStartingEquity, 0.5421);
});

test('margin interest follows a changing balance and is zero with no margin', () => {
  const eq = buildEquity('2026-06-08', 90, 10_000, [], (d) => (d < 45 ? 4000 : 0));
  const m = marginInterest(eq, W, 11);
  // 4000 for 45 days, nothing after.
  assert.equal(m.interestUsd, 54.21);
  assert.equal(m.maxMarginUsedUsd, 4000);
  assert.equal(m.avgMarginUsedUsd, 2000);
  assert.equal(marginInterest(buildEquity('2026-06-08', 90, 10_000, [], 0), W, 11).interestUsd, 0);
});

test('net return is gross minus every cost, taken against starting equity', () => {
  const s = set25Trades();
  const n = netReturn(s.input.equity, s.input.expenses, s.window, 11)!;
  assert.equal(n.startEquity, 10_000);
  assert.equal(n.grossReturnPct, 9.8);
  assert.equal(n.expensesUsd, 204);
  assert.equal(n.marginInterestUsd, 54.21);
  assert.equal(n.totalCostsUsd, 258.21);
  assert.equal(n.netPnlUsd, 721.79);
  assert.equal(n.netReturnPct, 7.2179);
  // Costs are 2.58% of a $10k book over three months, 0.87% a month.
  assert.equal(n.costsPctOfStartingEquity, 2.5821);
  assert.equal(n.expenseDragPctPerMonth, 0.8733);
  assert.equal(n.months, 2.9569);
});

test('net return is more negative than gross in a losing window', () => {
  const s = setCrash();
  const n = netReturn(s.input.equity, s.input.expenses, s.window, 11)!;
  assert.equal(n.grossReturnPct, -7.6);
  assert.equal(n.netReturnPct, -9.64);
  assert.ok(n.netReturnPct < n.grossReturnPct, 'costs must never flatter a loss');
});

test('a window shorter than the equity series does not leak later days in', () => {
  const s = set25Trades();
  const short = { start: '2026-06-08', end: addDays('2026-06-08', 30) };
  const n = netReturn(s.input.equity, s.input.expenses, short, 11)!;
  assert.equal(n.days, 30);
  assert.ok(n.endEquity < 10_980, 'the 90 day ending equity must not appear in a 30 day window');
});

// ---------------------------------------------------------------------------
// Money moved in and out is not return. the owner, 5 October 2026: +46.7% on /score.
// FIXTURE numbers, not a reading of his book.
// ---------------------------------------------------------------------------

const FW = { start: '2026-09-01', end: '2026-10-01' };
const pt = (date: string, equity: number, cash = 0): EquityPoint => ({ date, equity, cash, marginUsed: 0 });

test('a deposit inside the window is not a gain', () => {
  // 10,000 on 1 Sep, 5,000 deposited 11 Sep, 15,300 at the close: the book made 300.
  const eq = [pt('2026-09-01', 10_000), pt('2026-09-11', 15_100), pt('2026-10-01', 15_300)];
  const without = grossReturn(eq, FW)!;
  assert.equal(without.grossReturnPct, 53);
  const g = grossReturn(eq, FW, [{ date: '2026-09-11', amountUsd: 5_000 }])!;
  assert.equal(g.grossPnlUsd, 300);
  assert.equal(g.flowsUsd, 5_000);
  // 30 days; the 5,000 was at work for 20 of them.
  assert.equal(g.baseUsd, Number((10_000 + 5_000 * 20 / 30).toFixed(2)));
  assert.equal(g.grossReturnPct, Number(((300 / (10_000 + 5_000 * 20 / 30)) * 100).toFixed(4)));
});

test('a withdrawal inside the window is not a loss', () => {
  const eq = [pt('2026-09-01', 10_000), pt('2026-10-01', 6_500)];
  const g = grossReturn(eq, FW, [{ date: '2026-10-01', amountUsd: -4_000 }])!;
  // Out on the last day: 500 made on 10,000.
  assert.equal(g.grossPnlUsd, 500);
  assert.equal(g.grossReturnPct, 5);
});

test('flows outside the two endpoints are left out, and none means the old number', () => {
  const eq = [pt('2026-09-01', 10_000), pt('2026-10-01', 11_000)];
  const g = grossReturn(eq, FW, [
    { date: '2026-09-01', amountUsd: 5_000 },
    { date: '2026-10-02', amountUsd: -4_000 },
  ])!;
  assert.equal(g.flowsUsd, 0);
  assert.equal(g.grossReturnPct, 10);
  assert.deepEqual(grossReturn(eq, FW, [])!, grossReturn(eq, FW)!);
});

test('net return puts the costs on the same base as the gross', () => {
  const eq = [pt('2026-09-01', 10_000), pt('2026-10-01', 15_150)];
  const x: Expense[] = [{ kind: 'subscription', vendor: 'feed', amountUsd: 150, periodStart: '2026-09-02', periodEnd: '2026-10-01' }];
  const n = netReturn(eq, x, FW, undefined, [{ date: '2026-09-01T12:00:00Z', amountUsd: 0 }, { date: '2026-09-02', amountUsd: 5_000 }])!;
  const base = 10_000 + (5_000 * 29) / 30;
  assert.equal(n.grossPnlUsd, 150);
  assert.equal(n.netPnlUsd, 0);
  assert.ok(Math.abs(n.netReturnPct) < 1e-3, `net ${n.netReturnPct}`);
  assert.equal(n.costsPctOfStartingEquity, Number(((150 / base) * 100).toFixed(4)));
});

test('a row written before a cash event was recorded is restated to hold it', () => {
  // The deposit for 9 Sep was recorded on 4 Oct: the 9 Sep row was rebuilt with it, the
  // 10 Sep row was written before and does not hold it, the 2 Oct row was written after.
  const rows = [
    { ...pt('2026-09-08', 10_000, 100), recordedEventsUsd: 0 },
    { ...pt('2026-09-09', 18_000, 8_100), recordedEventsUsd: 8_000 },
    { ...pt('2026-09-10', 10_050, -7_900), recordedEventsUsd: 0 },
    { ...pt('2026-10-02', 14_100, 100), recordedEventsUsd: 4_000 },
    { ...pt('2026-10-03', 14_200, 100) },
  ];
  const events = [
    { kind: 'deposit', date: '2026-09-09', amountUsd: 8_000 },
    { kind: 'dividend', date: '2026-09-20', amountUsd: 0 },
    { kind: 'withdrawal', date: '2026-10-01', amountUsd: -4_000 },
  ];
  const out = restateForCashEvents(rows, events);
  assert.deepEqual(out.map((p) => p.equity), [10_000, 18_000, 18_050, 14_100, 14_200]);
  assert.equal(out[2]!.cash, 100);
  assert.equal(out[2]!.marginUsed, 0, 'the margin a stale row showed was the missing deposit');
  assert.ok(!('recordedEventsUsd' in out[0]!));
  assert.deepEqual(cashFlowsOf(events), [
    { date: '2026-09-09', amountUsd: 8_000 },
    { date: '2026-10-01', amountUsd: -4_000 },
  ]);
});
