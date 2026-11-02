/**
 * Input types for the scorecard. Plain data, no classes, no dependencies.
 *
 * Doctrine: everything here is an OUTCOME record. Nothing in this package reads
 * the engine's own prior, its confidence, or its ranking. A monitor calibrated
 * against its own reflection measures nothing.
 */

/** ISO date, either "YYYY-MM-DD" or a full ISO timestamp. */
export type IsoDate = string;

export type TradeOutcome = 'open' | 'closed' | 'stopped' | 'target' | 'expired';

export type TradeSide = 'long' | 'short';

export interface Trade {
  /** Stable id. Verdicts and paper fills key off this. */
  tradeId: string;
  symbol: string;
  side: TradeSide;
  openedAt: IsoDate;
  openPrice: number;
  closedAt?: IsoDate;
  closePrice?: number;
  /** Share count, or contract count for an option line. */
  shares: number;
  stopPrice: number;
  targetPrice: number;
  outcome: TradeOutcome;
}

/** One end-of-day snapshot of the book. */
export interface EquityPoint {
  date: IsoDate;
  /** Total account value: cash plus positions, before any expense netting. */
  equity: number;
  cash: number;
  /** Dollars of margin outstanding that day. Interest accrues on this. */
  marginUsed: number;
}

/**
 * Money moved into (positive) or out of (negative) the account by its owner, on the day
 * it moved. Not return: a deposit is not a gain and a withdrawal is not a loss. Dividends
 * and settlements are NOT flows; they are what the holdings did.
 */
export interface CashFlow {
  date: IsoDate;
  amountUsd: number;
}

/** One row of the cash ledger that still counts: a dividend, a settlement, a deposit or a withdrawal. Signed. */
export interface CashEvent {
  kind: string;
  date: IsoDate;
  amountUsd: number;
}

export type ExpenseKind = 'subscription' | 'model' | 'commission' | 'other';

/**
 * A cost charged against the book. Margin interest is NOT an Expense: it is
 * derived from the equity series by marginInterest(), so putting it here too
 * would double count it.
 */
export interface Expense {
  kind: ExpenseKind;
  vendor: string;
  amountUsd: number;
  /** The period the charge covers. Overlap with the window is prorated by day. */
  periodStart: IsoDate;
  periodEnd: IsoDate;
}

export interface PricePoint {
  date: IsoDate;
  close: number;
}

/**
 * One cash distribution on a benchmark, per share. Ex-date, because that is the
 * day the holder stops being entitled to it and the day the price drops by it.
 */
export interface Distribution {
  exDate: IsoDate;
  amountPerShare: number;
}

/** Which measurement a benchmark figure is. Total return is the comparable one. */
export type ReturnBasis = 'total-return' | 'price-return';

export interface Benchmark {
  name: string;
  series: PricePoint[];
  /**
   * Cash distributions inside the window. Supply them and the benchmark is
   * measured as a TOTAL return, the way the approved backtest measured SPY.
   * Leave them out and the figure is price return and is labelled as such;
   * it is never quietly called total return.
   */
  distributions?: Distribution[];
}

export type VerdictCall = 'agree' | 'disagree' | 'unsure';

/** the owner's tap on the morning call. */
export interface Verdict {
  tradeId: string;
  verdict: VerdictCall;
}

/** What the paper broker filled at, against which the real fill is measured. */
export interface PaperFill {
  tradeId: string;
  price: number;
  mode: 'alpaca' | 'simulated';
}

/** Equal weight buy and hold basket, snapshotted once and marked to market. */
export interface BasketSnapshot {
  name: string;
  takenAt: IsoDate;
  /** Closes on the snapshot day. */
  holdings: PricePoint2[];
  /** Closes on the window end day. */
  current: PricePoint2[];
}

export interface PricePoint2 {
  symbol: string;
  close: number;
}

/**
 * the owner's main account. Dollar values are never stored, only the account's
 * cumulative gain percent at each upload, so the window return is derived
 * from two percent figures.
 */
export interface MainAccountPercents {
  name?: string;
  startGainPct: number;
  endGainPct: number;
}

export interface SignalCounts {
  fired: number;
  taken: number;
}

export interface ScoreWindow {
  start: IsoDate;
  end: IsoDate;
  /** "30 day", "90 day", "since inception". Free text, shown in the render. */
  label?: string;
}

export interface ScoreInput {
  trades: Trade[];
  equity: EquityPoint[];
  expenses: Expense[];
  /** Deposits and withdrawals. Kept out of the return; see grossReturn. */
  flows?: CashFlow[];
  benchmarks?: Benchmark[];
  verdicts?: Verdict[];
  paperFills?: PaperFill[];
  /** Broker's annual margin rate in percent. Defaults to DEFAULT_MARGIN_ANNUAL_RATE_PCT. */
  marginAnnualRatePct?: number;
  basket?: BasketSnapshot;
  mainAccount?: MainAccountPercents;
  signalCounts?: SignalCounts;
}

/** Every figure in the output carries its sample size and a noise flag. */
export interface Sampled {
  n: number;
  withinNoise: boolean;
}
