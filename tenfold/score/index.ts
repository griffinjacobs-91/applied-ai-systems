/**
 * @tenfold/engine-score
 *
 * One function assembles the scorecard the app renders and the Sunday review
 * email carries: scorecard(input, window). Pure math. No network, no database,
 * no cron, no clock except the one you hand it.
 *
 * Two rules run through the whole package:
 *   1. Score against outcomes. Nothing reads the engine's own prior, ranking or
 *      confidence. A monitor calibrated against its own reflection reports
 *      nothing.
 *   2. Every figure carries n, and a bucket under 20 trades is labelled within
 *      noise rather than dressed as a finding.
 */

import type {
  Benchmark,
  ScoreInput,
  ScoreWindow,
} from './types.ts';
import {
  APPROVED_HOLDOUT,
  DEFAULT_MARGIN_ANNUAL_RATE_PCT,
  NOISE_FLOOR_MONTHS,
  NOISE_FLOOR_TRADES,
} from './constants.ts';
import { fmtN, fmtPct, fmtRate, fmtUsd, round } from './math.ts';
import {
  expensesForWindow,
  marginInterest,
  netReturn,
  type MarginInterest,
  type NetReturn,
  type WindowExpenses,
} from './returns.ts';
import {
  basketReturn,
  benchmarkReturn,
  excessOverBenchmark,
  findBenchmark,
  mainAccountReturn,
  type BasketReturn,
  type BenchmarkReturn,
  type MainAccountReturn,
} from './benchmarks.ts';
import {
  agreementStats,
  closedTradesInWindow,
  slippageStats,
  tradeStats,
  type AgreementStats,
  type SlippageStats,
  type TradeStats,
} from './trades.ts';
import { modelOrMarket, workingTest, type MarketVerdict, type WorkingTest } from './verdict.ts';
import { observations, type ObservationSet } from './observations.ts';

export * from './types.ts';
export * from './constants.ts';
export * from './returns.ts';
export * from './benchmarks.ts';
export * from './trades.ts';
export * from './verdict.ts';
export * from './observations.ts';
export { round, fmtPct, fmtUsd, fmtRate, daysBetween } from './math.ts';

export interface ScoreCard {
  generatedAt: string;
  window: ScoreWindow;
  /** Null when the equity series has nothing on or before the window end. */
  returns: NetReturn | null;
  costs: {
    expenses: WindowExpenses;
    margin: MarginInterest;
    totalUsd: number;
    dragPctPerMonth: number | null;
  };
  benchmarks: {
    spy: BenchmarkReturn | null;
    excessNetOverSpyPoints: number | null;
    others: BenchmarkReturn[];
    basket: BasketReturn | null;
    excessNetOverBasketPoints: number | null;
    mainAccount: MainAccountReturn | null;
    excessNetOverMainAccountPoints: number | null;
  };
  trades: TradeStats;
  agreement: AgreementStats;
  slippage: SlippageStats;
  /** Null when there is no SPY series or no equity to compute net from. */
  verdict: MarketVerdict | null;
  working: WorkingTest | null;
  observations: ObservationSet;
  /** Anything missing or suspect, said out loud instead of rendered as a zero. */
  warnings: string[];
  /** The floor a VERDICT is gated on: months of equity history. */
  noiseFloorMonths: number;
  /** The floor a per-trade BUCKET is labelled on. Gates nothing. */
  noiseFloorTrades: number;
  /** The out-of-sample evidence every threshold above is set from. */
  approvedHoldout: typeof APPROVED_HOLDOUT;
}

export interface ScorecardOptions {
  /** Injected clock, so the same input always renders the same card. */
  now?: string;
  /** Which benchmark carries the model-or-market verdict. Defaults to SPY. */
  primaryBenchmarkName?: string;
  /**
   * Override the months-of-equity floor. The tests use it to exercise the
   * verdict prose on a 90 day fixture; nothing in the app passes it.
   */
  noiseFloorMonths?: number;
}

export function scorecard(
  input: ScoreInput,
  window: ScoreWindow,
  opts: ScorecardOptions = {},
): ScoreCard {
  const warnings: string[] = [];
  const rate = input.marginAnnualRatePct ?? DEFAULT_MARGIN_ANNUAL_RATE_PCT;
  const primaryName = opts.primaryBenchmarkName ?? 'SPY';

  const ret = netReturn(input.equity, input.expenses, window, rate, input.flows ?? []);
  if (!ret) warnings.push('No equity snapshot on or before the window end: return figures are unavailable.');

  const expenses = expensesForWindow(input.expenses, window);
  const margin = marginInterest(input.equity, window, rate);
  if (expenses.totalUsd === 0) {
    warnings.push('No expenses fell in this window. The subscriptions are a standing cost; a zero here usually means the expense rows were not loaded.');
  }

  const spyBench = findBenchmark(input.benchmarks, primaryName);
  const spy = spyBench ? benchmarkReturn(spyBench, window) : null;
  if (!spy) warnings.push(`No ${primaryName} series for this window: the model-or-market line cannot be drawn.`);
  if (spy && spy.basis === 'price-return') {
    warnings.push(
      `${primaryName} is measured on price return: no distributions were supplied for this window. ` +
        `The approved backtest measured it on TOTAL return, so this understates the benchmark and ` +
        `flatters the book by roughly 1.5 points a year.`,
    );
  }

  const others: BenchmarkReturn[] = [];
  for (const b of input.benchmarks ?? []) {
    if (spyBench && b === spyBench) continue;
    const r = benchmarkReturn(b as Benchmark, window);
    if (r) others.push(r);
  }

  const basket = input.basket ? basketReturn(input.basket) : null;
  if (basket && basket.namesMissing.length > 0) {
    warnings.push(`Strong Buy basket: no closing price for ${basket.namesMissing.join(', ')}; those names are excluded from the average.`);
  }
  const mainAccount = input.mainAccount ? mainAccountReturn(input.mainAccount) : null;

  const closed = closedTradesInWindow(input.trades, window);
  const stats = tradeStats(closed);
  const openInWindow = input.trades.filter((t) => t.outcome === 'open').length;
  stats.open = openInWindow;

  const agreement = agreementStats(input.verdicts, closed);
  if (agreement.unmatched > 0) {
    warnings.push(`${agreement.unmatched} verdict(s) reference a trade outside this window and were not counted.`);
  }
  const slippage = slippageStats(input.paperFills, closed);

  const net = ret?.netReturnPct ?? null;
  const floorMonths = opts.noiseFloorMonths ?? NOISE_FLOOR_MONTHS;
  const verdict =
    net !== null && ret && spy
      ? modelOrMarket({
          netReturnPct: net,
          benchmarkReturnPct: spy.returnPct,
          benchmarkName: spy.name,
          monthsOfEquity: ret.months,
          tradeCount: stats.closed.n,
          noiseFloorMonths: floorMonths,
        })
      : null;

  const working =
    net !== null && ret
      ? workingTest({
          netReturnPct: net,
          months: ret.months,
          tradeCount: stats.closed.n,
          noiseFloorMonths: floorMonths,
        })
      : null;

  return {
    generatedAt: opts.now ?? new Date().toISOString(),
    window,
    returns: ret,
    costs: {
      expenses,
      margin,
      totalUsd: round(expenses.totalUsd + margin.interestUsd, 2),
      dragPctPerMonth: ret?.expenseDragPctPerMonth ?? null,
    },
    benchmarks: {
      spy,
      excessNetOverSpyPoints: net !== null && spy ? excessOverBenchmark(net, spy.returnPct) : null,
      others,
      basket,
      excessNetOverBasketPoints:
        net !== null && basket && basket.returnPct !== null
          ? excessOverBenchmark(net, basket.returnPct)
          : null,
      mainAccount,
      excessNetOverMainAccountPoints:
        net !== null && mainAccount ? excessOverBenchmark(net, mainAccount.returnPct) : null,
    },
    trades: stats,
    agreement,
    slippage,
    verdict,
    working,
    observations: observations(input.trades, window, input.signalCounts),
    warnings,
    noiseFloorMonths: floorMonths,
    noiseFloorTrades: NOISE_FLOOR_TRADES,
    approvedHoldout: APPROVED_HOLDOUT,
  };
}

function line(label: string, value: string): string {
  return `${label}: ${value}`;
}

function ahead(points: number | null): string {
  if (points === null) return '';
  const r = round(points, 2);
  if (r === 0) return ', net is level with it';
  return `, net is ${Math.abs(r).toFixed(2)} points ${r > 0 ? 'ahead' : 'behind'}`;
}

/**
 * The Sunday review body. Plain text, no tables, no emoji, staged for Griffin.
 * Never sent to the owner: this is the page where the parameters get argued about.
 */
export function renderScorecardText(card: ScoreCard): string {
  const L: string[] = [];
  const w = card.window;
  const r = card.returns;

  L.push('TENFOLD SCORECARD');
  L.push(
    `Window ${w.start} to ${w.end}` +
      (w.label ? ` (${w.label})` : '') +
      (r ? `, ${r.days} days, ${r.months.toFixed(2)} months` : ''),
  );
  L.push(`Generated ${card.generatedAt}`);
  L.push('');

  L.push('THE NUMBER');
  if (!r) {
    L.push('No equity history for this window, so there is no return to report.');
  } else {
    L.push(`Net ${fmtPct(r.netReturnPct)} (${fmtUsd(r.netPnlUsd)} on ${fmtUsd(r.startEquity)} starting equity)`);
    L.push(`Gross ${fmtPct(r.grossReturnPct)} (${fmtUsd(r.grossPnlUsd)}) before costs`);
    L.push(`Costs ${fmtUsd(r.totalCostsUsd)}, which is ${fmtRate(r.costsPctOfStartingEquity)} of starting equity`);
    L.push(`Expense drag ${fmtRate(r.expenseDragPctPerMonth)} of equity per month`);
  }
  L.push('');

  L.push('MODEL OR MARKET');
  L.push(card.verdict ? card.verdict.sentence : 'No benchmark series, so this line cannot be drawn.');
  L.push('');

  L.push('IS IT WORKING');
  L.push(card.working ? card.working.sentence : 'No return figure, so the monthly average cannot be computed.');
  L.push('');

  L.push('BENCHMARKS');
  const b = card.benchmarks;
  if (b.spy) {
    L.push(
      `${b.spy.name} ${fmtPct(b.spy.returnPct)} ` +
        `(${b.spy.basis === 'total-return' ? `total return, ${b.spy.distributionsCounted} distributions reinvested` : 'price return, no distributions supplied'})` +
        `${ahead(b.excessNetOverSpyPoints)}`,
    );
  }
  for (const o of b.others) L.push(`${o.name} ${fmtPct(o.returnPct)}`);
  if (b.basket) {
    L.push(
      `${b.basket.name} ${fmtPct(b.basket.returnPct)} equal weight on ${b.basket.namesScored} names` +
        `${b.basket.sample.withinNoise ? ' (within noise)' : ''}${ahead(b.excessNetOverBasketPoints)}`,
    );
  }
  if (b.mainAccount) {
    L.push(
      `${b.mainAccount.name} ${fmtPct(b.mainAccount.returnPct)} across the window` +
        `${ahead(b.excessNetOverMainAccountPoints)}`,
    );
  }
  if (!b.spy && b.others.length === 0 && !b.basket && !b.mainAccount) L.push('None loaded.');
  L.push('');

  L.push('COSTS');
  const kinds = Object.entries(card.costs.expenses.byKind).sort((a, c) => c[1] - a[1]);
  if (kinds.length === 0) L.push('No expense rows in this window.');
  for (const [kind, amt] of kinds) L.push(`${kind} ${fmtUsd(amt)}`);
  L.push(
    card.costs.margin.maxMarginUsedUsd === 0
      ? 'margin interest $0.00, no margin was carried in this window'
      : `margin interest ${fmtUsd(card.costs.margin.interestUsd)} at ${card.costs.margin.annualRatePct.toFixed(1)}% ` +
        `on an average balance of ${fmtUsd(card.costs.margin.avgMarginUsedUsd)} over ${card.costs.margin.daysAccrued} days`,
  );
  L.push(`total ${fmtUsd(card.costs.totalUsd)}`);
  L.push('');

  L.push('TRADES');
  const t = card.trades;
  L.push(`${t.closed.n} closed, ${t.open} still open`);
  L.push(line('Win rate', `${fmtRate(t.winRatePct)} ${fmtN(t.closed)}`));
  L.push(line('Average win', `${fmtPct(t.avgWinPct)} (${fmtUsd(t.avgWinUsd)}) ${fmtN(t.wins, 'wins')}`));
  L.push(line('Average loss', `${fmtPct(t.avgLossPct)} (${fmtUsd(t.avgLossUsd)}) ${fmtN(t.losses, 'losses')}`));
  L.push(line('Average hold', `${t.avgHoldDays ?? 'n/a'} days, median ${t.medianHoldDays ?? 'n/a'}`));
  L.push(
    line(
      'Exits',
      `${t.stoppedOut} stopped out, ${t.targetHit} hit target, ${t.expired} expired, ${t.closedByHand} closed by hand`,
    ),
  );
  L.push(line('Realised', fmtUsd(t.totalPnlUsd)));
  const a = card.agreement;
  L.push(
    line(
      'Agreement with the owner',
      a.agreementRatePct === null
        ? 'no verdicts yet'
        : `${fmtRate(a.agreementRatePct)} ${fmtN(a.sample, 'votes')} (${a.agree} agree, ${a.disagree} disagree, ${a.unsure} unsure)`,
    ),
  );
  const s = card.slippage;
  L.push(
    line(
      'Paper against real',
      s.avgSlippagePct === null
        ? 'no paper fills matched'
        : `real fills ${fmtRate(Math.abs(s.avgSlippagePct))} ${s.avgSlippagePct >= 0 ? 'worse' : 'better'} than paper ${fmtN(s.sample, 'fills')}`,
    ),
  );
  L.push('');

  L.push('OBSERVATIONS');
  L.push(card.observations.note);
  for (const o of card.observations.observations) L.push(`${o.parameter}: ${o.sentence}`);
  L.push('');

  if (card.warnings.length > 0) {
    L.push('WARNINGS');
    for (const x of card.warnings) L.push(x);
    L.push('');
  }

  L.push(
    `Every figure carries its sample size. A verdict needs ${card.noiseFloorMonths} months of equity, ` +
      `and a bucket under ${card.noiseFloorTrades} trades is shown but marked within noise.`,
  );
  L.push(
    `Thresholds come from ${card.approvedHoldout.label}: ` +
      `${fmtPct(card.approvedHoldout.netTotalReturnPct)} net over ${card.approvedHoldout.months} months ` +
      `against SPY ${fmtPct(card.approvedHoldout.spyTotalReturnPct)} total return, ` +
      `worst drawdown ${fmtPct(card.approvedHoldout.maxDrawdownPct)}.`,
  );
  return L.join('\n');
}
