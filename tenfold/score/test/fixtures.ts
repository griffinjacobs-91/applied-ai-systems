/**
 * Synthetic data for the tests and the demo render. Everything here is made up
 * on purpose: no real fill, no real close, no real account figure. Prices are
 * built so the arithmetic is checkable by hand. Every position opens at $100 a
 * share, so a $1,000 position is ten shares and a +20% exit is exactly $200.
 */

import type {
  Benchmark,
  EquityPoint,
  Expense,
  PaperFill,
  ScoreInput,
  ScoreWindow,
  Trade,
  TradeOutcome,
  TradeSide,
  Verdict,
} from '../types.ts';

export const OPEN_PRICE = 100;

export function addDays(base: string, n: number): string {
  const t = Date.parse(`${base}T00:00:00.000Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export interface TradeSpec {
  symbol: string;
  openDay: number;
  holdDays: number;
  /** Return on the position, in percent. */
  retPct: number;
  outcome: TradeOutcome;
  positionUsd?: number;
  side?: TradeSide;
}

export function buildTrades(baseDate: string, specs: TradeSpec[]): Trade[] {
  return specs.map((s, i) => {
    const positionUsd = s.positionUsd ?? 1000;
    const shares = positionUsd / OPEN_PRICE;
    const side: TradeSide = s.side ?? 'long';
    const closePrice = OPEN_PRICE * (1 + (side === 'short' ? -s.retPct : s.retPct) / 100);
    const open = addDays(baseDate, s.openDay);
    const closed = addDays(baseDate, s.openDay + s.holdDays);
    const t: Trade = {
      tradeId: `T${String(i + 1).padStart(3, '0')}`,
      symbol: s.symbol,
      side,
      openedAt: open,
      openPrice: OPEN_PRICE,
      shares,
      stopPrice: OPEN_PRICE * 0.88,
      targetPrice: OPEN_PRICE * 1.2,
      outcome: s.outcome,
    };
    if (s.outcome !== 'open') {
      t.closedAt = closed;
      t.closePrice = Number(closePrice.toFixed(6));
    }
    return t;
  });
}

/** Realised dollars from a spec, for the equity curve. */
function specPnl(s: TradeSpec): number {
  const positionUsd = s.positionUsd ?? 1000;
  return (positionUsd * s.retPct) / 100;
}

export function buildEquity(
  baseDate: string,
  days: number,
  startEquity: number,
  specs: TradeSpec[],
  marginUsed: number | ((day: number) => number) = 0,
): EquityPoint[] {
  const out: EquityPoint[] = [];
  for (let d = 0; d <= days; d++) {
    const realised = specs
      .filter((s) => s.outcome !== 'open' && s.openDay + s.holdDays <= d)
      .reduce((a, s) => a + specPnl(s), 0);
    const equity = Number((startEquity + realised).toFixed(2));
    out.push({
      date: addDays(baseDate, d),
      equity,
      cash: Number((equity * 0.2).toFixed(2)),
      marginUsed: typeof marginUsed === 'function' ? marginUsed(d) : marginUsed,
    });
  }
  return out;
}

/**
 * Griffin's standing bill: Massive $30, RapidAPI $10, Supabase $10 a month,
 * plus model spend. One row per vendor per 30 day block.
 */
export function buildExpenses(
  baseDate: string,
  months: number,
  modelSpendPerMonthUsd = 18,
): Expense[] {
  const rows: Expense[] = [];
  for (let m = 0; m < months; m++) {
    const periodStart = addDays(baseDate, m * 30);
    const periodEnd = addDays(baseDate, m * 30 + 29);
    rows.push({ kind: 'subscription', vendor: 'Massive', amountUsd: 30, periodStart, periodEnd });
    rows.push({ kind: 'subscription', vendor: 'RapidAPI', amountUsd: 10, periodStart, periodEnd });
    rows.push({ kind: 'subscription', vendor: 'Supabase', amountUsd: 10, periodStart, periodEnd });
    if (modelSpendPerMonthUsd > 0) {
      rows.push({
        kind: 'model',
        vendor: 'Anthropic',
        amountUsd: modelSpendPerMonthUsd,
        periodStart,
        periodEnd,
      });
    }
  }
  return rows;
}

/** A straight line from start to end, one close a day. Enough to price a window. */
export function buildSeries(
  name: string,
  baseDate: string,
  days: number,
  startClose: number,
  endClose: number,
): Benchmark {
  const series = [];
  for (let d = 0; d <= days; d++) {
    series.push({
      date: addDays(baseDate, d),
      close: Number((startClose + ((endClose - startClose) * d) / days).toFixed(4)),
    });
  }
  return { name, series };
}

export function buildVerdicts(trades: Trade[], agree: number, disagree: number, unsure: number): Verdict[] {
  const out: Verdict[] = [];
  trades.forEach((t, i) => {
    if (i < agree) out.push({ tradeId: t.tradeId, verdict: 'agree' });
    else if (i < agree + disagree) out.push({ tradeId: t.tradeId, verdict: 'disagree' });
    else if (i < agree + disagree + unsure) out.push({ tradeId: t.tradeId, verdict: 'unsure' });
  });
  return out;
}

/**
 * Paper fills against a real open of $100. Alpaca paper printed 99.80 (the real
 * book paid 0.20% up), the simulator printed 99.95.
 */
export function buildPaperFills(trades: Trade[], alpacaCount: number): PaperFill[] {
  return trades.map((t, i) => ({
    tradeId: t.tradeId,
    price: i < alpacaCount ? 99.8 : 99.95,
    mode: i < alpacaCount ? ('alpaca' as const) : ('simulated' as const),
  }));
}

export interface SyntheticSet {
  name: string;
  input: ScoreInput;
  window: ScoreWindow;
  specs: TradeSpec[];
}

const BASE = '2026-06-08';

function repeat(
  prefix: string,
  count: number,
  make: (i: number) => Omit<TradeSpec, 'symbol'>,
): TradeSpec[] {
  return Array.from({ length: count }, (_, i) => ({
    symbol: `${prefix}${i + 1}`,
    ...make(i),
  }));
}

/**
 * SET A. Ninety days, 25 closed trades, the book ahead of a quiet market.
 * Gross +9.80% ($980 on $10,000). Costs $204 of subscriptions and model spend
 * plus $54.21 of margin interest on a flat $2,000 balance. Net +7.22%.
 * SPY +2.40%. Six stops, four of them inside five days.
 */
export function set25Trades(): SyntheticSet {
  const specs: TradeSpec[] = [
    // Eight target hits at +20%.
    ...repeat('TGT', 8, (i) => ({ openDay: 2 + i * 3, holdDays: 14 + i, retPct: 20, outcome: 'target' as const })),
    // Seven closed by hand at +6%.
    ...repeat('WIN', 7, (i) => ({ openDay: 5 + i * 4, holdDays: 9 + i, retPct: 6, outcome: 'closed' as const })),
    // Six stops at -12%. Four fire inside five days.
    ...repeat('STP', 4, (i) => ({ openDay: 8 + i * 6, holdDays: 2 + i, retPct: -12, outcome: 'stopped' as const })),
    ...repeat('STL', 2, (i) => ({ openDay: 30 + i * 9, holdDays: 11 + i * 4, retPct: -12, outcome: 'stopped' as const })),
    // Three closed by hand at -4%.
    ...repeat('CUT', 3, (i) => ({ openDay: 12 + i * 7, holdDays: 6 + i, retPct: -4, outcome: 'closed' as const })),
    // One $200 call that expired to zero.
    { symbol: 'EXP1', openDay: 20, holdDays: 25, retPct: -100, outcome: 'expired', positionUsd: 200 },
  ];
  const trades = buildTrades(BASE, specs);
  return {
    name: '25 trades, quiet market, book ahead',
    specs,
    window: { start: BASE, end: addDays(BASE, 90), label: '90 day' },
    input: {
      trades,
      equity: buildEquity(BASE, 90, 10_000, specs, 2000),
      expenses: buildExpenses(BASE, 3),
      benchmarks: [buildSeries('SPY', BASE, 90, 500, 512)],
      verdicts: buildVerdicts(trades, 17, 3, 4),
      paperFills: buildPaperFills(trades, 15),
      marginAnnualRatePct: 11,
      basket: {
        name: 'Strong Buy basket',
        takenAt: BASE,
        holdings: [
          { symbol: 'AAA', close: 50 },
          { symbol: 'BBB', close: 20 },
          { symbol: 'CCC', close: 100 },
          { symbol: 'DDD', close: 80 },
          { symbol: 'EEE', close: 25 },
        ],
        current: [
          { symbol: 'AAA', close: 54 },
          { symbol: 'BBB', close: 19 },
          { symbol: 'CCC', close: 108 },
          { symbol: 'DDD', close: 82.4 },
          { symbol: 'EEE', close: 26.5 },
        ],
      },
      mainAccount: { startGainPct: 20, endGainPct: 24.8 },
      signalCounts: { fired: 40, taken: 25 },
    },
  };
}

/**
 * SET B. The crash. Ninety days, 25 closed trades, SPY down 15%, the book down
 * 9.64% net. No margin was carried. This is the set that has to produce
 * "fell with the market; the market fell more".
 */
export function setCrash(): SyntheticSet {
  const specs: TradeSpec[] = [
    ...repeat('HLD', 10, (i) => ({ openDay: 1 + i * 2, holdDays: 20 + i, retPct: 8, outcome: 'closed' as const })),
    ...repeat('STP', 12, (i) => ({ openDay: 4 + i * 5, holdDays: 3 + (i % 6), retPct: -12, outcome: 'stopped' as const })),
    ...repeat('CUT', 3, (i) => ({ openDay: 30 + i * 8, holdDays: 9 + i, retPct: -4, outcome: 'closed' as const })),
  ];
  const trades = buildTrades(BASE, specs);
  return {
    name: 'crash, book fell less than SPY',
    specs,
    window: { start: BASE, end: addDays(BASE, 90), label: '90 day' },
    input: {
      trades,
      equity: buildEquity(BASE, 90, 10_000, specs, 0),
      expenses: buildExpenses(BASE, 3),
      benchmarks: [buildSeries('SPY', BASE, 90, 500, 425)],
      verdicts: buildVerdicts(trades, 12, 8, 3),
      paperFills: buildPaperFills(trades, 25),
      marginAnnualRatePct: 11,
      basket: {
        name: 'Strong Buy basket',
        takenAt: BASE,
        holdings: [
          { symbol: 'AAA', close: 50 },
          { symbol: 'BBB', close: 20 },
          { symbol: 'CCC', close: 100 },
          { symbol: 'DDD', close: 80 },
          { symbol: 'EEE', close: 25 },
        ],
        current: [
          { symbol: 'AAA', close: 41 },
          { symbol: 'BBB', close: 17.2 },
          { symbol: 'CCC', close: 86 },
          { symbol: 'DDD', close: 69.6 },
          { symbol: 'EEE', close: 21 },
        ],
      },
      mainAccount: { startGainPct: 20, endGainPct: 4.4 },
      signalCounts: { fired: 61, taken: 25 },
    },
  };
}

/**
 * SET C. The plug-puller. SPY up 4%, the book down 7.44% net on 22 trades.
 * Unexplained losses while the market is fine: the owner's own stated reason to stop.
 */
export function setModelNotMarket(): SyntheticSet {
  const specs: TradeSpec[] = [
    ...repeat('WIN', 9, (i) => ({ openDay: 2 + i * 3, holdDays: 12 + i, retPct: 9, outcome: 'closed' as const })),
    ...repeat('STP', 10, (i) => ({ openDay: 6 + i * 6, holdDays: 2 + (i % 4), retPct: -12, outcome: 'stopped' as const })),
    ...repeat('CUT', 3, (i) => ({ openDay: 40 + i * 7, holdDays: 8 + i, retPct: -5, outcome: 'closed' as const })),
  ];
  const trades = buildTrades(BASE, specs);
  return {
    name: 'book fell while SPY rose',
    specs,
    window: { start: BASE, end: addDays(BASE, 90), label: '90 day' },
    input: {
      trades,
      equity: buildEquity(BASE, 90, 10_000, specs, 0),
      expenses: buildExpenses(BASE, 3),
      benchmarks: [buildSeries('SPY', BASE, 90, 500, 520)],
      verdicts: buildVerdicts(trades, 8, 9, 2),
      paperFills: buildPaperFills(trades, 11),
      marginAnnualRatePct: 11,
      signalCounts: { fired: 55, taken: 22 },
    },
  };
}

/**
 * SET D. Three trades in a month. Everything is within noise and it is too
 * early to judge working. This is the set that must refuse to draw a conclusion.
 */
export function set3Trades(): SyntheticSet {
  const specs: TradeSpec[] = [
    { symbol: 'AAA', openDay: 2, holdDays: 9, retPct: 10, outcome: 'closed' },
    { symbol: 'BBB', openDay: 5, holdDays: 12, retPct: 10, outcome: 'target' },
    { symbol: 'CCC', openDay: 7, holdDays: 3, retPct: -12, outcome: 'stopped' },
  ];
  const trades = buildTrades(BASE, specs);
  return {
    name: '3 trades, one month, within noise',
    specs,
    window: { start: BASE, end: addDays(BASE, 30), label: '30 day' },
    input: {
      trades,
      equity: buildEquity(BASE, 30, 10_000, specs, 0),
      expenses: buildExpenses(BASE, 1),
      benchmarks: [buildSeries('SPY', BASE, 30, 500, 505)],
      verdicts: buildVerdicts(trades, 2, 1, 0),
      paperFills: buildPaperFills(trades, 3),
      marginAnnualRatePct: 11,
      signalCounts: { fired: 9, taken: 3 },
    },
  };
}

export const FROZEN_NOW = '2026-09-07T03:00:00.000Z';
