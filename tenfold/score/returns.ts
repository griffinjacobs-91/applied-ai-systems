/**
 * Book returns for a window, gross and net of every cost.
 *
 * the owner sees NET first. Griffin's rule, 7 Sept 2026: the tool cannot work
 * without the two data subscriptions, so they are expenses against the gains.
 * Margin interest is netted the same way and is derived here from the equity
 * series, never from an Expense line, so it can never be counted twice.
 */

import type { CashEvent, CashFlow, EquityPoint, Expense, ExpenseKind, ScoreWindow } from './types.ts';
import { DAYS_PER_MONTH, DAYS_PER_YEAR, DEFAULT_MARGIN_ANNUAL_RATE_PCT } from './constants.ts';
import { daysBetween, overlapDays, parseDate, round, sum, withinWindow } from './math.ts';

export interface EquityEndpoints {
  startDate: string;
  endDate: string;
  startEquity: number;
  endEquity: number;
  /** Calendar days spanned by the window itself, not by the points found. */
  days: number;
  /** How many equity snapshots fell inside the window. */
  points: number;
}

function sortByDate(series: EquityPoint[]): EquityPoint[] {
  return [...series].sort((a, b) => parseDate(a.date) - parseDate(b.date));
}

/**
 * The equity reading that opens the window: the last snapshot on or before
 * window.start, falling back to the first snapshot after it when the book did
 * not exist yet. Returns null for an empty series.
 */
export function equityEndpoints(
  equity: EquityPoint[],
  window: ScoreWindow,
): EquityEndpoints | null {
  if (equity.length === 0) return null;
  const s = sortByDate(equity);
  const startT = parseDate(window.start);
  const endT = parseDate(window.end);

  let open = s.filter((p) => parseDate(p.date) <= startT).at(-1);
  if (!open) open = s.find((p) => parseDate(p.date) <= endT);
  const close = s.filter((p) => parseDate(p.date) <= endT).at(-1);
  if (!open || !close) return null;

  return {
    startDate: open.date,
    endDate: close.date,
    startEquity: open.equity,
    endEquity: close.equity,
    days: daysBetween(window.start, window.end),
    points: s.filter((p) => withinWindow(p.date, window.start, window.end)).length,
  };
}

/** The two kinds a person moves. Everything else on the cash ledger is return. */
export function cashFlowsOf(events: CashEvent[]): CashFlow[] {
  return events
    .filter((e) => e.kind === 'deposit' || e.kind === 'withdrawal')
    .map((e) => ({ date: e.date, amountUsd: Number(e.amountUsd) }));
}

/**
 * Restate each equity point for cash events recorded AFTER that point was written.
 *
 * An equity row is written once a day with the cash events it could see then, and only
 * the row for an event's own date is rebuilt when one is recorded. A deposit the owner records
 * on 4 October for 9 September therefore sits in the 9 September row and every row from
 * the next morning on, and NOT in the rows between, which would read as the money arriving
 * twice. `recordedEventsUsd` is the cumulative total the row was written with (the
 * `cash_events_usd` column); the ledger says what the total through that date is now, and
 * the difference goes into the row's cash and equity. A point that does not say what it
 * was written with is left as it is.
 */
export function restateForCashEvents(
  points: Array<EquityPoint & { recordedEventsUsd?: number | null }>,
  events: CashEvent[],
): EquityPoint[] {
  const sorted = [...events]
    .filter((e) => Number.isFinite(Number(e.amountUsd)))
    .sort((a, b) => parseDate(a.date) - parseDate(b.date));
  return points.map(({ recordedEventsUsd, ...p }) => {
    if (recordedEventsUsd == null || !Number.isFinite(recordedEventsUsd)) return p;
    const t = parseDate(p.date);
    let through = 0;
    for (const e of sorted) {
      if (parseDate(e.date) > t) break;
      through += Number(e.amountUsd);
    }
    const delta = round(through - recordedEventsUsd, 2);
    if (delta === 0) return p;
    const cash = round(p.cash + delta, 2);
    return { ...p, equity: round(p.equity + delta, 2), cash, marginUsed: cash < 0 ? round(-cash, 2) : 0 };
  });
}

export interface GrossReturn extends EquityEndpoints {
  grossPnlUsd: number;
  grossReturnPct: number;
  /** Net money moved in (positive) or out between the two endpoints. Not in the P&L. */
  flowsUsd: number;
  /**
   * What the percent is OF: the opening equity plus each flow weighted by the share of
   * the window it was in the book. Equal to startEquity when nothing moved.
   */
  baseUsd: number;
}

/**
 * Gross return: what the positions did, before any cost is netted out.
 *
 * MONEY MOVED IS NOT RETURN. the owner, 5 October 2026: recording the shares he journaled in
 * as a deposit put +46.7% on the score, because the window's closing equity held money
 * its opening equity never had. A flow after the opening snapshot and on or before the
 * closing one comes out of the P&L, and goes into the base for the share of the window
 * it was at work (Modified Dietz). With no flows this is exactly the old
 * `end / start - 1`. A flow is inside the equity row of the day it moved, so it is at
 * work from the end of that day.
 *
 * Null when the window opens on zero equity, which is a real state on a book
 * funded part way through the window. A percent change off a zero base is not a
 * big number, it is not a number, and the honest render of it is the empty
 * state rather than Infinity or a 500.
 */
export function grossReturn(
  equity: EquityPoint[],
  window: ScoreWindow,
  flows: CashFlow[] = [],
): GrossReturn | null {
  const e = equityEndpoints(equity, window);
  if (!e) return null;
  if (!Number.isFinite(e.startEquity) || !Number.isFinite(e.endEquity) || e.startEquity === 0) return null;
  const openT = parseDate(e.startDate);
  const closeT = parseDate(e.endDate);
  const span = closeT - openT;
  let net = 0;
  let weighted = 0;
  for (const f of flows) {
    const amount = Number(f.amountUsd);
    if (!Number.isFinite(amount) || amount === 0) continue;
    const t = parseDate(f.date);
    if (t <= openT || t > closeT) continue;
    net += amount;
    weighted += span > 0 ? (amount * (closeT - t)) / span : 0;
  }
  const pnl = e.endEquity - e.startEquity - net;
  let base = e.startEquity + weighted;
  // More out than was ever at work is a book that was emptied; the opening equity is the
  // honest denominator then, and it is the old one.
  if (!(base > 0)) base = e.startEquity;
  return {
    ...e,
    grossPnlUsd: round(pnl, 2),
    grossReturnPct: round((pnl / base) * 100, 4),
    flowsUsd: round(net, 2),
    baseUsd: round(base, 2),
  };
}

export interface ProratedExpense {
  kind: ExpenseKind;
  vendor: string;
  /** The share of the charge that falls inside the window. */
  amountUsd: number;
  fullAmountUsd: number;
  overlapDays: number;
  periodDays: number;
}

export interface WindowExpenses {
  totalUsd: number;
  byKind: Record<string, number>;
  byVendor: Record<string, number>;
  lines: ProratedExpense[];
}

/**
 * Expenses charged to the window, prorated by day where a charge straddles the
 * edge. A $30 monthly subscription over a 90 day window is $90ish, not $30.
 */
export function expensesForWindow(expenses: Expense[], window: ScoreWindow): WindowExpenses {
  const lines: ProratedExpense[] = [];
  for (const x of expenses) {
    const periodDays = daysBetween(x.periodStart, x.periodEnd) + 1;
    if (periodDays <= 0) continue;
    const ov = overlapDays(x.periodStart, x.periodEnd, window.start, window.end);
    if (ov <= 0) continue;
    const share = Math.min(ov / periodDays, 1);
    lines.push({
      kind: x.kind,
      vendor: x.vendor,
      amountUsd: round(x.amountUsd * share, 2),
      fullAmountUsd: x.amountUsd,
      overlapDays: round(ov, 2),
      periodDays: round(periodDays, 2),
    });
  }
  const byKind: Record<string, number> = {};
  const byVendor: Record<string, number> = {};
  for (const l of lines) {
    byKind[l.kind] = round((byKind[l.kind] ?? 0) + l.amountUsd, 2);
    byVendor[l.vendor] = round((byVendor[l.vendor] ?? 0) + l.amountUsd, 2);
  }
  return {
    totalUsd: round(sum(lines.map((l) => l.amountUsd)), 2),
    byKind,
    byVendor,
    lines,
  };
}

export interface MarginInterest {
  interestUsd: number;
  annualRatePct: number;
  avgMarginUsedUsd: number;
  maxMarginUsedUsd: number;
  daysAccrued: number;
  /** Interest as a percent of the equity the window opened with. */
  pctOfStartingEquity: number | null;
}

/**
 * Interest accrued on marginUsed, day by day, at a simple annual rate.
 * Each snapshot's marginUsed is carried forward until the next snapshot, which
 * is how a broker charges it: on the balance you actually held.
 */
export function marginInterest(
  equity: EquityPoint[],
  window: ScoreWindow,
  annualRatePct: number = DEFAULT_MARGIN_ANNUAL_RATE_PCT,
): MarginInterest {
  const s = sortByDate(equity).filter((p) => withinWindow(p.date, window.start, window.end));
  let interest = 0;
  let weighted = 0;
  let days = 0;
  let max = 0;
  for (let i = 0; i < s.length; i++) {
    const p = s[i]!;
    const next = s[i + 1];
    // The last snapshot in the window carries to the window end.
    const span = next ? daysBetween(p.date, next.date) : daysBetween(p.date, window.end);
    if (span <= 0) continue;
    interest += p.marginUsed * (annualRatePct / 100) * (span / DAYS_PER_YEAR);
    weighted += p.marginUsed * span;
    days += span;
    if (p.marginUsed > max) max = p.marginUsed;
  }
  const endpoints = equityEndpoints(equity, window);
  return {
    interestUsd: round(interest, 2),
    annualRatePct,
    avgMarginUsedUsd: days > 0 ? round(weighted / days, 2) : 0,
    maxMarginUsedUsd: round(max, 2),
    daysAccrued: round(days, 2),
    pctOfStartingEquity:
      endpoints && endpoints.startEquity !== 0
        ? round((interest / endpoints.startEquity) * 100, 4)
        : null,
  };
}

export interface NetReturn {
  startEquity: number;
  endEquity: number;
  grossPnlUsd: number;
  grossReturnPct: number;
  expensesUsd: number;
  marginInterestUsd: number;
  totalCostsUsd: number;
  /** Costs as a percent of the equity the window opened with. */
  costsPctOfStartingEquity: number;
  netPnlUsd: number;
  /** Gross return minus costs, costs expressed against starting equity. */
  netReturnPct: number;
  days: number;
  months: number;
  /** Costs per month as a percent of equity. The $10k scale made visible. */
  expenseDragPctPerMonth: number;
}

/**
 * Net return. Gross minus the window's costs, with the costs expressed as a
 * percent of the equity the window opened with, which is the base the owner funded.
 */
export function netReturn(
  equity: EquityPoint[],
  expenses: Expense[],
  window: ScoreWindow,
  annualRatePct: number = DEFAULT_MARGIN_ANNUAL_RATE_PCT,
  flows: CashFlow[] = [],
): NetReturn | null {
  const g = grossReturn(equity, window, flows);
  if (!g) return null;
  const x = expensesForWindow(expenses, window);
  const m = marginInterest(equity, window, annualRatePct);
  const totalCosts = round(x.totalUsd + m.interestUsd, 2);
  // On the same base as the gross percent, so net is gross minus costs on one footing.
  const costsPct = g.baseUsd === 0 ? 0 : (totalCosts / g.baseUsd) * 100;
  const days = g.days;
  return {
    startEquity: g.startEquity,
    endEquity: g.endEquity,
    grossPnlUsd: g.grossPnlUsd,
    grossReturnPct: g.grossReturnPct,
    expensesUsd: x.totalUsd,
    marginInterestUsd: m.interestUsd,
    totalCostsUsd: totalCosts,
    costsPctOfStartingEquity: round(costsPct, 4),
    netPnlUsd: round(g.grossPnlUsd - totalCosts, 2),
    netReturnPct: round(g.grossReturnPct - costsPct, 4),
    days: round(days, 2),
    months: round(days / DAYS_PER_MONTH, 4),
    expenseDragPctPerMonth: expenseDragPctPerMonth(totalCosts, g.baseUsd, days),
  };
}

/**
 * Costs per month as a percent of equity. This is the number that shows why a
 * $10k book is a harder place to run a paid tool than a $100k one: $50 a month
 * is 0.5 percent of $10k and 0.05 percent of $100k.
 */
export function expenseDragPctPerMonth(
  totalCostsUsd: number,
  equityBase: number,
  days: number,
): number {
  if (equityBase === 0 || days <= 0) return 0;
  const months = days / DAYS_PER_MONTH;
  return round((totalCostsUsd / months / equityBase) * 100, 4);
}
