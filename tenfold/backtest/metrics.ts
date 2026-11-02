// Scoring. Every figure here is derived from the daily equity series and the
// trade list produced by the engine; nothing is asserted from outside.

import { MARGIN_MULT, MARGIN_RATE, type Trade } from './engine.ts';

export type MonthReturn = { month: string; ret: number; days: number };

/**
 * Calendar-month returns from the daily equity curve. The first and last month
 * are partial; `days` says how many trading days each covers so a partial
 * month is never read as a full one.
 */
export function monthlyReturns(dates: string[], equity: number[]): MonthReturn[] {
  const out: MonthReturn[] = [];
  let i = 0;
  while (i < dates.length) {
    const m = dates[i].slice(0, 7);
    const start = i;
    while (i < dates.length && dates[i].slice(0, 7) === m) i++;
    // Base is the last equity of the previous month; for the first month it is
    // the opening capital, which is equity[0] because no order can fill on the
    // very first day of the simulation.
    const base = start === 0 ? equity[0] : equity[start - 1];
    out.push({ month: m, ret: equity[i - 1] / base - 1, days: i - start });
  }
  return out;
}

export function maxDrawdown(equity: number[]): { dd: number; peakIdx: number; troughIdx: number } {
  let peak = -Infinity, peakIdx = 0, dd = 0, bestPeak = 0, trough = 0;
  for (let i = 0; i < equity.length; i++) {
    if (equity[i] > peak) { peak = equity[i]; peakIdx = i; }
    const d = equity[i] / peak - 1;
    if (d < dd) { dd = d; bestPeak = peakIdx; trough = i; }
  }
  return { dd, peakIdx: bestPeak, troughIdx: trough };
}

/** Worst return over any window of `n` calendar days, walked day by day. */
export function worstWindow(dates: string[], equity: number[], n = 90) {
  let worst = Infinity, from = '', to = '';
  let j = 0;
  for (let i = 0; i < dates.length; i++) {
    const limit = Date.parse(dates[i]) + n * 86_400_000;
    while (j < dates.length && Date.parse(dates[j]) <= limit) j++;
    const end = j - 1;
    if (end <= i) continue;
    // only count windows that actually span the full period
    if (Date.parse(dates[end]) < Date.parse(dates[i]) + (n - 7) * 86_400_000) continue;
    const r = equity[end] / equity[i] - 1;
    if (r < worst) { worst = r; from = dates[i]; to = dates[end]; }
    j = Math.max(i + 1, j);
  }
  return worst === Infinity ? null : { ret: worst, from, to };
}

export function cagr(equity: number[], dates: string[]): number {
  const years = (Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])) / (365.25 * 86_400_000);
  if (years <= 0) return 0;
  return Math.pow(equity[equity.length - 1] / equity[0], 1 / years) - 1;
}

export type Stats = {
  n: number;
  startEquity: number;
  endEquity: number;
  totalReturn: number;
  cagr: number;
  maxDD: number;
  ddFrom: string;
  ddTo: string;
  months: MonthReturn[];
  bestMonth: MonthReturn | null;
  worstMonth: MonthReturn | null;
  monthsOver10: number;
  monthsNegative: number;
  fullMonths: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  avgHoldDays: number | null;
  medianHoldDays: number | null;
  worst90: { ret: number; from: string; to: string } | null;
};

export function stats(dates: string[], equity: number[], trades: Trade[]): Stats {
  const months = monthlyReturns(dates, equity);
  const full = months.filter((m) => m.days >= 15);
  const dd = maxDrawdown(equity);
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const holds = trades.map((t) => t.holdDays).sort((a, b) => a - b);
  const sortedFull = [...full].sort((a, b) => a.ret - b.ret);
  return {
    n: dates.length,
    startEquity: equity[0],
    endEquity: equity[equity.length - 1],
    totalReturn: equity[equity.length - 1] / equity[0] - 1,
    cagr: cagr(equity, dates),
    maxDD: dd.dd,
    ddFrom: dates[dd.peakIdx],
    ddTo: dates[dd.troughIdx],
    months,
    bestMonth: sortedFull.length ? sortedFull[sortedFull.length - 1] : null,
    worstMonth: sortedFull.length ? sortedFull[0] : null,
    monthsOver10: full.filter((m) => m.ret > 0.10).length,
    monthsNegative: full.filter((m) => m.ret < 0).length,
    fullMonths: full.length,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? wins.length / trades.length : null,
    avgWin: wins.length ? wins.reduce((a, t) => a + t.ret, 0) / wins.length : null,
    avgLoss: losses.length ? losses.reduce((a, t) => a + t.ret, 0) / losses.length : null,
    avgHoldDays: holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : null,
    medianHoldDays: holds.length ? holds[Math.floor(holds.length / 2)] : null,
    worst90: worstWindow(dates, equity, 90),
  };
}

/** Equity restricted to one calendar year, rebased to that year's first close. */
export function sliceYear(dates: string[], equity: number[], year: string) {
  const first = dates.findIndex((d) => d.startsWith(year));
  if (first < 0) return null;
  let last = first;
  while (last + 1 < dates.length && dates[last + 1].startsWith(year)) last++;
  // Base off the last close of the prior year where one exists, so a year's
  // return is not free of the gap over the new year.
  const base = first > 0 ? first - 1 : first;
  return {
    dates: dates.slice(first, last + 1),
    equity: equity.slice(first, last + 1),
    baseEquity: equity[base],
    ret: equity[last] / equity[base] - 1,
  };
}

/**
 * The 1.5x margin case, as a SIMPLE MULTIPLE on the daily return series and
 * not a re-simulation: each day the book's return is scaled 1.5x and the
 * interest on the borrowed half a unit of equity is subtracted at 11% a year.
 * It assumes the leverage could always be obtained at that rate and that no
 * margin call ever forced a sale, neither of which is tested here.
 */
export function marginMultiple(equity: number[]): number[] {
  const out = [equity[0]];
  const daily = MARGIN_RATE * (MARGIN_MULT - 1) / 252;
  for (let i = 1; i < equity.length; i++) {
    const r = equity[i] / equity[i - 1] - 1;
    out.push(out[i - 1] * (1 + MARGIN_MULT * r - daily));
  }
  return out;
}

// =====================================================================
// B9, B15: the metrics a mature backtester prints, added 7 September in
// the trust pass. Everything below is derived from the daily equity
// series and the trade list; nothing is asserted from outside.
// =====================================================================

/** Simple daily returns from an equity curve. Length n-1. */
export function dailyReturns(equity: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < equity.length; i++) out.push(equity[i] / equity[i - 1] - 1);
  return out;
}

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const stdev = (a: number[]) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1));
};

/** Annualised Sharpe on daily returns, zero risk-free rate, 252 days a year. */
export function sharpe(equity: number[]): number | null {
  const r = dailyReturns(equity);
  const sd = stdev(r);
  if (!(sd > 0)) return null;
  return (mean(r) / sd) * Math.sqrt(252);
}

/** Annualised Sortino: the same numerator over downside deviation only. */
export function sortino(equity: number[]): number | null {
  const r = dailyReturns(equity);
  const down = r.filter((v) => v < 0);
  if (down.length < 2) return null;
  const dd = Math.sqrt(down.reduce((s, v) => s + v * v, 0) / down.length);
  if (!(dd > 0)) return null;
  return (mean(r) / dd) * Math.sqrt(252);
}

/** CAGR over the absolute maximum drawdown. Null when there was no drawdown. */
export function calmar(equity: number[], dates: string[]): number | null {
  const dd = Math.abs(maxDrawdown(equity).dd);
  if (!(dd > 0)) return null;
  return cagr(equity, dates) / dd;
}

/** Gross winnings over gross losses. Under 1.0 the book pays out more than it takes. */
export function profitFactor(trades: Trade[]): number | null {
  let win = 0, loss = 0;
  for (const t of trades) { if (t.pnl > 0) win += t.pnl; else loss -= t.pnl; }
  if (!(loss > 0)) return null;
  return win / loss;
}

export type Expectancy = { dollars: number; pct: number; n: number };

/** What one trade is worth on average, in dollars and as a return on the money committed. */
export function expectancy(trades: Trade[]): Expectancy {
  if (trades.length === 0) return { dollars: 0, pct: 0, n: 0 };
  return {
    dollars: mean(trades.map((t) => t.pnl)),
    pct: mean(trades.map((t) => t.ret)),
    n: trades.length,
  };
}

export type Exposure = { avgCapitalHeld: number; pctDaysWithPosition: number; avgNames: number };

/** How much of the book was actually at work, and how often anything was held. */
export function exposure(equity: number[], heldValue: number[], openCount: number[]): Exposure {
  const ratios: number[] = [];
  for (let i = 0; i < equity.length; i++) if (equity[i] > 0) ratios.push(heldValue[i] / equity[i]);
  return {
    avgCapitalHeld: mean(ratios),
    pctDaysWithPosition: openCount.filter((c) => c > 0).length / Math.max(1, openCount.length),
    avgNames: mean(openCount),
  };
}

/** The longest run of consecutive losing trades, in exit order. */
export function longestLosingStreak(trades: Trade[]): number {
  const byExit = [...trades].sort((a, b) => (a.exitDate ?? '').localeCompare(b.exitDate ?? ''));
  let best = 0, run = 0;
  for (const t of byExit) {
    if (t.pnl <= 0) { run++; if (run > best) best = run; } else run = 0;
  }
  return best;
}

export type DrawdownEpisode = {
  peakDate: string; troughDate: string; recoveryDate: string | null;
  depth: number;                      // negative
  lengthDays: number;                 // peak to trough, trading days
  recoveryDays: number | null;        // trough to recovery, trading days
  totalDays: number;                  // peak to recovery, or to the last day
  recovered: boolean;
};

/**
 * Every distinct drawdown episode: a high-water mark, the trough beneath it,
 * and the day the book climbed back to that mark. The last episode is open
 * when the book never recovered, which is what "still in it" means.
 */
export function drawdownEpisodes(dates: string[], equity: number[]): DrawdownEpisode[] {
  const out: DrawdownEpisode[] = [];
  let peak = equity[0], peakIdx = 0, troughIdx = -1, trough = Infinity;
  for (let i = 1; i < equity.length; i++) {
    if (equity[i] >= peak) {
      if (troughIdx >= 0) {
        out.push({
          peakDate: dates[peakIdx], troughDate: dates[troughIdx], recoveryDate: dates[i],
          depth: trough / peak - 1,
          lengthDays: troughIdx - peakIdx,
          recoveryDays: i - troughIdx,
          totalDays: i - peakIdx,
          recovered: true,
        });
      }
      peak = equity[i]; peakIdx = i; troughIdx = -1; trough = Infinity;
    } else if (equity[i] < trough) {
      trough = equity[i]; troughIdx = i;
    }
  }
  if (troughIdx >= 0) {
    out.push({
      peakDate: dates[peakIdx], troughDate: dates[troughIdx], recoveryDate: null,
      depth: trough / peak - 1,
      lengthDays: troughIdx - peakIdx,
      recoveryDays: null,
      totalDays: equity.length - 1 - peakIdx,
      recovered: false,
    });
  }
  return out.sort((a, b) => a.depth - b.depth);
}

/** Max drawdown duration in trading days, and whether it ever recovered. */
export function drawdownDuration(dates: string[], equity: number[]) {
  const eps = drawdownEpisodes(dates, equity);
  if (eps.length === 0) return { days: 0, recovered: true, from: dates[0], to: dates[0] };
  const worst = eps[0];
  return {
    days: worst.totalDays,
    recovered: worst.recovered,
    from: worst.peakDate,
    to: worst.recoveryDate ?? dates[dates.length - 1],
  };
}

export type ExitRow = { reason: string; count: number; meanRet: number; meanHoldBars: number; totalPnl: number };

/** B15: which exit is burning the money. */
export function exitReasonTable(trades: Trade[]): ExitRow[] {
  const m = new Map<string, Trade[]>();
  for (const t of trades) {
    const key = t.reason.startsWith('stop') ? 'stop' : t.reason;
    if (!m.has(key)) m.set(key, []);
    m.get(key)!.push(t);
  }
  return [...m.entries()].map(([reason, ts]) => ({
    reason,
    count: ts.length,
    meanRet: mean(ts.map((t) => t.ret)),
    meanHoldBars: mean(ts.map((t) => t.barsHeld)),
    totalPnl: ts.reduce((s, t) => s + t.pnl, 0),
  })).sort((a, b) => a.totalPnl - b.totalPnl);
}

export type ExcursionSummary = {
  winners: { n: number; meanMae: number; meanMfe: number; medianMae: number };
  losers: { n: number; meanMae: number; meanMfe: number; medianMfe: number };
};

/**
 * B15: how far a trade went against the book before it worked, and how much
 * was left on the table. The winners' worst excursion is the number that says
 * whether a -12% stop is too tight; the losers' best excursion says whether
 * +20% is too early.
 */
export function excursions(trades: Trade[]): ExcursionSummary {
  const w = trades.filter((t) => t.pnl > 0);
  const l = trades.filter((t) => t.pnl <= 0);
  const med = (a: number[]) => {
    if (a.length === 0) return 0;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  };
  return {
    winners: {
      n: w.length, meanMae: mean(w.map((t) => t.mae)), meanMfe: mean(w.map((t) => t.mfe)),
      medianMae: med(w.map((t) => t.mae)),
    },
    losers: {
      n: l.length, meanMae: mean(l.map((t) => t.mae)), meanMfe: mean(l.map((t) => t.mfe)),
      medianMfe: med(l.map((t) => t.mfe)),
    },
  };
}
