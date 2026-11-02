/**
 * The 30 day parameter observations, computed from outcomes, never guessed.
 *
 * the owner, 7 Sept 2026: he does not expect to quit at 90 days, he expects to look
 * at 30 days and ask whether the parameters are too tight or too loose.
 *
 * HARD RULE: observations only. Nothing here proposes a new value, and nothing
 * here may be wired to change a parameter. Griffin reads these and edits the
 * profile by hand. Under NOISE_FLOOR_TRADES the sentence says so out loud
 * rather than letting a share off six trades look like a finding.
 */

import type { Sampled, ScoreWindow, SignalCounts, Trade } from './types.ts';
import { NOISE_FLOOR_TRADES, STOP_FAST_DAYS } from './constants.ts';
import { round, sampled } from './math.ts';
import { closedTradesInWindow, scoreTrade } from './trades.ts';

export type ObservationId =
  | 'stops-hit-fast'
  | 'targets-never-reached'
  | 'calls-expired'
  | 'signals-taken';

export interface Observation {
  id: ObservationId;
  /** What parameter this observation bears on, in plain words. */
  parameter: string;
  count: number;
  sharePct: number | null;
  sample: Sampled;
  sentence: string;
}

export interface ObservationSet {
  window: ScoreWindow;
  observations: Observation[];
  note: string;
  thresholds: { stopFastDays: number; noiseFloorTrades: number };
}

function share(count: number, n: number): number | null {
  return n === 0 ? null : round((count / n) * 100, 2);
}

function withNoise(sentence: string, s: Sampled, unit = 'trades'): string {
  return s.withinNoise
    ? `${sentence} Within noise: ${s.n} ${unit} is under the ${NOISE_FLOOR_TRADES} needed to read anything into it.`
    : sentence;
}

/**
 * Observations for the window. Pass signalCounts when the run log has them;
 * without it the take rate observation is omitted rather than invented.
 */
export function observations(
  trades: Trade[],
  window: ScoreWindow,
  signalCounts?: SignalCounts,
  opts?: { stopFastDays?: number },
): ObservationSet {
  const fastDays = opts?.stopFastDays ?? STOP_FAST_DAYS;
  const closed = closedTradesInWindow(trades, window);
  const scored = closed.map(scoreTrade).filter((s) => s !== null);
  const out: Observation[] = [];

  // 1. Stops hit fast. A stop that fires inside five days did not give the
  //    thesis room; a wall of these is what "too tight" looks like.
  const stops = scored.filter((s) => s.outcome === 'stopped');
  const fast = stops.filter((s) => s.holdDays <= fastDays);
  const stopSample = sampled(stops.length);
  out.push({
    id: 'stops-hit-fast',
    parameter: `stop distance (currently -12% on entry), read against a ${fastDays} day clock`,
    count: fast.length,
    sharePct: share(fast.length, stops.length),
    sample: stopSample,
    sentence: withNoise(
      stops.length === 0
        ? 'No stops were hit in this window, so there is nothing to say about stop distance.'
        : `${fast.length} of ${stops.length} stops fired inside ${fastDays} days (${share(fast.length, stops.length)}%).`,
      stopSample,
      'stops',
    ),
  });

  // 2. Targets never reached. Every closed line had a target; how many got there.
  const hitTarget = scored.filter((s) => s.outcome === 'target');
  const missed = scored.length - hitTarget.length;
  const closedSample = sampled(scored.length);
  out.push({
    id: 'targets-never-reached',
    parameter: 'target distance (currently +20%, sell half and trail)',
    count: missed,
    sharePct: share(missed, scored.length),
    sample: closedSample,
    sentence: withNoise(
      scored.length === 0
        ? 'No trades closed in this window, so there is nothing to say about target distance.'
        : `${missed} of ${scored.length} closed trades never reached their target (${share(missed, scored.length)}%); ${hitTarget.length} did.`,
      closedSample,
    ),
  });

  // 3. Expired calls. An option that expired worthless is the limit price or the
  //    time window being wrong, and the owner's own condition was that the model
  //    really understand that options expire to zero.
  const expired = scored.filter((s) => s.outcome === 'expired');
  out.push({
    id: 'calls-expired',
    parameter: 'option limit price and days to expiry',
    count: expired.length,
    sharePct: share(expired.length, scored.length),
    sample: closedSample,
    sentence: withNoise(
      scored.length === 0
        ? 'No trades closed in this window, so there is nothing to say about expiries.'
        : `${expired.length} of ${scored.length} closed trades expired (${share(expired.length, scored.length)}%).`,
      closedSample,
    ),
  });

  // 4. Signals fired against signals taken. A wide gap is the call not landing,
  //    which is a delivery question, not a parameter question.
  if (signalCounts) {
    const s = sampled(signalCounts.fired);
    out.push({
      id: 'signals-taken',
      parameter: 'how many calls the book actually acted on',
      count: signalCounts.taken,
      sharePct: share(signalCounts.taken, signalCounts.fired),
      sample: s,
      sentence: withNoise(
        signalCounts.fired === 0
          ? 'No signals fired in this window.'
          : `${signalCounts.taken} of ${signalCounts.fired} signals were taken (${share(signalCounts.taken, signalCounts.fired)}%).`,
        s,
        'signals',
      ),
    });
  }

  return {
    window,
    observations: out,
    note: 'Observations only. Nothing here proposes or applies a parameter change; Griffin edits the profile by hand.',
    thresholds: { stopFastDays: fastDays, noiseFloorTrades: NOISE_FLOOR_TRADES },
  };
}
