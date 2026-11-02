/**
 * Every threshold the scorecard uses, in one place, so a reader can argue with
 * a number instead of hunting for it.
 *
 * WHERE THESE COME FROM, 8 Sept 2026. The first draft of this file carried the
 * old 10-day-over-30-day cross rule's thresholds: a floor of 20 closed trades
 * and a target of 10 percent a month. Neither belongs to the rule the book
 * actually runs. `xmom-12-1-top200` rebalances at month end and holds six
 * names, so it closes about two to three positions a month: 20 closed trades is
 * most of a year expressed as if it were a trade count, and 10 percent a month
 * is above anything the approved sheet ever produced, so the verdict read "not
 * at the target" permanently and could never say anything else.
 *
 * Both are now set from the sheet the owner approved:
 * ~/Deliverables/2026-09-07-john-book-app/strategy-summary-v2.json.
 */

/**
 * The approved holdout, verbatim from `strategy-summary-v2.json`, candidate
 * `xmom-12-1-top200`, block `holdout`. This is the only out-of-sample evidence
 * the rule has, and every threshold below is derived from it rather than
 * guessed. Percentages, because nothing downstream of this package is allowed a
 * dollar.
 */
export const APPROVED_HOLDOUT = {
  id: 'xmom-12-1-top200',
  label: 'the approved holdout, 5 Sept 2025 to 4 Sept 2026',
  startDate: '2025-09-05',
  endDate: '2026-09-04',
  months: 12,
  tradingDays: 252,
  /** Before the $50 a month bill. */
  totalReturnPct: 134.51,
  /** After it. This is the number the live net return is comparable with. */
  netTotalReturnPct: 125.81,
  /** SPY over the same days, total return with dividends reinvested. */
  spyTotalReturnPct: 20.31,
  /** Worst peak-to-trough on the way to that number. */
  maxDrawdownPct: -50.97,
  /**
   * WHEN THE HOLE WAS DUG, AND HOW LONG IT TOOK TO CLIMB OUT.
   *
   * These three used to be prose: "136" was a literal typed into
   * src/pages/score.astro and the two dates were in nobody's code at all, so
   * the one number on the card a reader could argue with was the one number
   * that had no source. They are `holdout.ddFrom`, `holdout.ddTo` and
   * `holdout.ddDurationDays` off `xmom-12-1-top200` in
   * strategy-summary-v2.json, the same block every figure above comes from.
   *
   * ddFrom is the high the fall started from and ddTo is the trough. The
   * duration is measured from the high to the day the equity got back to it,
   * which is why it is longer than the gap between the two dates.
   */
  drawdownFrom: '2025-10-15',
  drawdownTo: '2025-12-17',
  drawdownRecoveryDays: 136,
  closedTrades: 21,
  /** 7 of 12 months cleared 10 percent. 4 of 12 were negative. */
  monthsOver10Pct: 7,
  monthsNegative: 4,
} as const;

/**
 * THE NOISE FLOOR IS MONTHS OF EQUITY, NOT TRADES.
 *
 * A month-end rebalance produces one independent decision a month whether it
 * turns over one name or six, so the sample that matters is months of equity
 * history. Twelve is the length of the holdout the rule was approved on: the
 * shortest span anybody has ever judged this rule over. Under it the card
 * reports every figure and withholds the claim.
 *
 * Even at twelve the sheet's own month-resampled bootstrap put the excess over
 * SPY at [-0.63, +10.40] and containing zero, so twelve months buys a
 * description, not a proof. The sentences say so.
 */
export const NOISE_FLOOR_MONTHS = 12;

/**
 * The floor for labelling a per-trade BUCKET: a win rate, an average win, a
 * basket of names. This one is still counted in trades, because a rate over
 * four outcomes is a coin however many months they are spread across. It no
 * longer gates any verdict; that is what NOISE_FLOOR_MONTHS is for.
 */
export const NOISE_FLOOR_TRADES = 20;

/**
 * Working, set to what the approved holdout actually delivered: +125.81 percent
 * net over 12 months is 7.02 percent a month compounded. Rounded to 7.0.
 *
 * This is a bar the rule has cleared once, out of sample, which is the only
 * kind of bar worth measuring against.
 */
export const WORKING_TARGET_PCT_PER_MONTH = 7.0;

/**
 * the owner's own wish, said twice on 7 Sept 2026. It is not the test any more,
 * because no version of this rule has ever produced it and a target nothing can
 * reach is a target that tells him nothing. It is still carried in the prose so
 * the two numbers can be read side by side.
 */
export const JOHN_STATED_TARGET_PCT_PER_MONTH = 10;

/** Below one full month there is no monthly average to speak of. */
export const MIN_MONTHS_TO_JUDGE = 1;

/**
 * Net and SPY inside this many percentage points of each other is a tie, not a
 * win. Without a band, a 0.03 point edge would print "beat the market".
 */
export const MARKET_TIE_BAND_POINTS = 1.0;

/** A stop hit inside this many days is counted as a fast stop (possibly too tight). */
export const STOP_FAST_DAYS = 5;

/** Days per month used for every "per month" figure. 365.25 / 12. */
export const DAYS_PER_MONTH = 30.4375;

export const DAYS_PER_YEAR = 365.25;

/** Schwab-ish margin rate. Override per input; interest is netted before the score. */
export const DEFAULT_MARGIN_ANNUAL_RATE_PCT = 11;

/**
 * Griffin's standing monthly bill for running the book, 7 Sept 2026. The tool
 * cannot work without the data subscriptions, so they are expenses against the
 * gains. Model spend and margin interest are on top of this and vary.
 */
export const FIXED_MONTHLY_SUBSCRIPTIONS_USD = {
  massive: 30,
  rapidapi: 10,
  supabase: 10,
} as const;

export const FIXED_MONTHLY_SUBSCRIPTION_TOTAL_USD =
  FIXED_MONTHLY_SUBSCRIPTIONS_USD.massive +
  FIXED_MONTHLY_SUBSCRIPTIONS_USD.rapidapi +
  FIXED_MONTHLY_SUBSCRIPTIONS_USD.supabase;
