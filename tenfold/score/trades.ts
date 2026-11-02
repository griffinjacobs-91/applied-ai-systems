/**
 * Trade statistics. Every figure carries n, and under NOISE_FLOOR_TRADES the
 * figure is still shown but flagged within noise: a win rate off four trades is
 * a coin, not a finding.
 *
 * Only closed lines are scored. An open trade has no outcome yet and counting
 * it would be marking the engine against its own hope.
 */

import type { PaperFill, Sampled, Trade, Verdict, ScoreWindow } from './types.ts';
import { daysBetween, mean, round, sampled, withinWindow } from './math.ts';

export interface ScoredTrade {
  tradeId: string;
  symbol: string;
  side: Trade['side'];
  outcome: Trade['outcome'];
  openedAt: string;
  closedAt: string;
  holdDays: number;
  pnlUsd: number;
  returnPct: number;
  costBasisUsd: number;
}

/** A trade is countable when it is closed, priced, and dated. */
export function isClosed(t: Trade): boolean {
  return t.outcome !== 'open' && t.closePrice !== undefined && t.closedAt !== undefined;
}

/**
 * Trades belonging to the window: closed inside it. A trade opened in June and
 * closed in September belongs to the September window, because that is when its
 * outcome landed. Open trades are excluded everywhere.
 */
export function closedTradesInWindow(trades: Trade[], window: ScoreWindow): Trade[] {
  return trades.filter((t) => isClosed(t) && withinWindow(t.closedAt as string, window.start, window.end));
}

export function scoreTrade(t: Trade): ScoredTrade | null {
  if (!isClosed(t)) return null;
  const close = t.closePrice as number;
  const closedAt = t.closedAt as string;
  const basis = t.openPrice * t.shares;
  const direction = t.side === 'short' ? -1 : 1;
  const pnl = (close - t.openPrice) * t.shares * direction;
  return {
    tradeId: t.tradeId,
    symbol: t.symbol,
    side: t.side,
    outcome: t.outcome,
    openedAt: t.openedAt,
    closedAt,
    holdDays: round(daysBetween(t.openedAt, closedAt), 2),
    pnlUsd: round(pnl, 2),
    returnPct: basis === 0 ? 0 : round((pnl / basis) * 100, 4),
    costBasisUsd: round(basis, 2),
  };
}

export interface TradeStats {
  closed: Sampled;
  open: number;
  winRatePct: number | null;
  wins: Sampled;
  losses: Sampled;
  breakEven: number;
  avgWinPct: number | null;
  avgWinUsd: number | null;
  avgLossPct: number | null;
  avgLossUsd: number | null;
  avgHoldDays: number | null;
  medianHoldDays: number | null;
  totalPnlUsd: number;
  stoppedOut: number;
  targetHit: number;
  expired: number;
  closedByHand: number;
  perTrade: ScoredTrade[];
}

export function tradeStats(trades: Trade[]): TradeStats {
  const scored = trades.map(scoreTrade).filter((s): s is ScoredTrade => s !== null);
  const wins = scored.filter((s) => s.pnlUsd > 0);
  const losses = scored.filter((s) => s.pnlUsd < 0);
  const holds = scored.map((s) => s.holdDays).sort((a, b) => a - b);
  const mid = holds.length === 0
    ? null
    : holds.length % 2 === 1
      ? holds[(holds.length - 1) / 2]!
      : ((holds[holds.length / 2 - 1]! + holds[holds.length / 2]!) / 2);
  const avgWinPct = mean(wins.map((s) => s.returnPct));
  const avgLossPct = mean(losses.map((s) => s.returnPct));
  const avgWinUsd = mean(wins.map((s) => s.pnlUsd));
  const avgLossUsd = mean(losses.map((s) => s.pnlUsd));
  const avgHold = mean(scored.map((s) => s.holdDays));
  return {
    closed: sampled(scored.length),
    open: trades.filter((t) => t.outcome === 'open').length,
    winRatePct: scored.length === 0 ? null : round((wins.length / scored.length) * 100, 2),
    wins: sampled(wins.length),
    losses: sampled(losses.length),
    breakEven: scored.filter((s) => s.pnlUsd === 0).length,
    avgWinPct: avgWinPct === null ? null : round(avgWinPct, 2),
    avgWinUsd: avgWinUsd === null ? null : round(avgWinUsd, 2),
    avgLossPct: avgLossPct === null ? null : round(avgLossPct, 2),
    avgLossUsd: avgLossUsd === null ? null : round(avgLossUsd, 2),
    avgHoldDays: avgHold === null ? null : round(avgHold, 2),
    medianHoldDays: mid === null ? null : round(mid, 2),
    totalPnlUsd: round(scored.reduce((a, s) => a + s.pnlUsd, 0), 2),
    stoppedOut: scored.filter((s) => s.outcome === 'stopped').length,
    targetHit: scored.filter((s) => s.outcome === 'target').length,
    expired: scored.filter((s) => s.outcome === 'expired').length,
    closedByHand: scored.filter((s) => s.outcome === 'closed').length,
    perTrade: scored,
  };
}

export interface AgreementStats {
  /** Agree divided by agree plus disagree. Unsure is not a vote either way. */
  agreementRatePct: number | null;
  agree: number;
  disagree: number;
  unsure: number;
  /** Verdicts matched to a trade in this window. */
  sample: Sampled;
  /** Verdicts referencing a trade that is not in this window. */
  unmatched: number;
}

/**
 * How often the owner's tap agreed with the call. Scored on his verdicts, not on
 * whether the trade made money: this measures trust in the call, not the call.
 */
export function agreementStats(verdicts: Verdict[] | undefined, trades: Trade[]): AgreementStats {
  const ids = new Set(trades.map((t) => t.tradeId));
  const all = verdicts ?? [];
  const matched = all.filter((v) => ids.has(v.tradeId));
  const agree = matched.filter((v) => v.verdict === 'agree').length;
  const disagree = matched.filter((v) => v.verdict === 'disagree').length;
  const unsure = matched.filter((v) => v.verdict === 'unsure').length;
  const voted = agree + disagree;
  return {
    agreementRatePct: voted === 0 ? null : round((agree / voted) * 100, 2),
    agree,
    disagree,
    unsure,
    sample: sampled(voted),
    unmatched: all.length - matched.length,
  };
}

export interface SlippageStats {
  /**
   * Average percent by which the real fill was worse than the paper fill.
   * Positive means the real book paid up against the paper book.
   */
  avgSlippagePct: number | null;
  worstSlippagePct: number | null;
  bestSlippagePct: number | null;
  sample: Sampled;
  byMode: Record<string, { avgSlippagePct: number | null; n: number }>;
  unmatched: number;
  perTrade: { tradeId: string; mode: PaperFill['mode']; paperPrice: number; realPrice: number; slippagePct: number }[];
}

/**
 * Paper book against real book. For a long, paying more than paper is worse;
 * for a short, being filled lower than paper is worse. Positive is always worse
 * for the book, whichever way the trade points.
 */
export function slippageStats(fills: PaperFill[] | undefined, trades: Trade[]): SlippageStats {
  const byId = new Map(trades.map((t) => [t.tradeId, t]));
  const all = fills ?? [];
  const rows: SlippageStats['perTrade'] = [];
  for (const f of all) {
    const t = byId.get(f.tradeId);
    if (!t || f.price === 0) continue;
    const direction = t.side === 'short' ? -1 : 1;
    rows.push({
      tradeId: f.tradeId,
      mode: f.mode,
      paperPrice: f.price,
      realPrice: t.openPrice,
      slippagePct: round((((t.openPrice - f.price) / f.price) * 100) * direction, 4),
    });
  }
  const vals = rows.map((r) => r.slippagePct);
  const avg = mean(vals);
  const byMode: SlippageStats['byMode'] = {};
  for (const mode of ['alpaca', 'simulated'] as const) {
    const m = rows.filter((r) => r.mode === mode).map((r) => r.slippagePct);
    if (m.length === 0) continue;
    const a = mean(m);
    byMode[mode] = { avgSlippagePct: a === null ? null : round(a, 4), n: m.length };
  }
  return {
    avgSlippagePct: avg === null ? null : round(avg, 4),
    worstSlippagePct: vals.length ? round(Math.max(...vals), 4) : null,
    bestSlippagePct: vals.length ? round(Math.min(...vals), 4) : null,
    sample: sampled(rows.length),
    byMode,
    unmatched: all.length - rows.length,
    perTrade: rows,
  };
}
