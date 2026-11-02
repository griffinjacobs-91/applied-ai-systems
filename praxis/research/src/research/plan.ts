// research/plan — the scheduling arithmetic, and nothing else.
//
// Pure functions on plain data: which stage runs next, whether the next call
// fits the budget, whether the wall clock ran out, which trade+town pairs still
// owe us probe runs, and whether somebody else's lock has gone stale. No
// database, no network, no clock of its own — every function takes the now it
// should reason about, so a test can hand it any moment it likes.
//
// The reason this is its own file: a runner that decides and acts in the same
// breath cannot be tested, and an untested scheduler is how a batch quietly
// burns a budget on the same pair eight times.

import { toPair } from './trades.ts';
import { ENGINE_KEYS, STAGE_ORDER } from './types.ts';
import type { EngineKey, Pair, QuestionId, Stage } from './types.ts';

/** The first stage in order with work waiting, or null when the batch is done. */
export function pickStage(counts: Record<Stage, number>): Stage | null {
  for (const stage of STAGE_ORDER) {
    if ((counts[stage] ?? 0) > 0) return stage;
  }
  return null;
}

/**
 * Does the next call still fit? A cap of zero or less is not "unlimited", it is
 * "no budget", so nothing runs. Spending exactly to the cap is allowed.
 */
export function withinBudget(spentUsd: number, capUsd: number, nextUsd: number): boolean {
  if (capUsd <= 0) return false;
  return spentUsd + nextUsd <= capUsd;
}

/** Nine minutes by default, which leaves room under a ten minute function ceiling. */
export function deadlinePassed(startedAtMs: number, nowMs: number, capMs = 540_000): boolean {
  return nowMs - startedAtMs >= capMs;
}

/** A lock older than its TTL belongs to a run that died. Fifteen minutes by default. */
export function lockExpired(startedAt: string, nowMs: number, ttlMs = 15 * 60_000): boolean {
  const started = Date.parse(startedAt);
  // An unparseable lock timestamp is a broken lock, and a broken lock must not
  // hold a batch hostage.
  if (Number.isNaN(started)) return true;
  return nowMs - started >= ttlMs;
}

/**
 * Every (question, engine) run a trade owes. Four runs for a trade with no
 * emergency, eight for one that has one. Order is fixed so a diff of two plans
 * reads the same way twice.
 */
export function expectedRuns(trade: { urgent: string | null }): Array<{ question_id: QuestionId; engine: EngineKey }> {
  const questions: QuestionId[] = trade.urgent === null ? ['best'] : ['best', 'urgent'];
  const runs: Array<{ question_id: QuestionId; engine: EngineKey }> = [];
  for (const question_id of questions) {
    for (const engine of ENGINE_KEYS) {
      runs.push({ question_id, engine });
    }
  }
  return runs;
}

interface LeadLocation {
  trade: string | null;
  city: string | null;
  state: string | null;
  /** The Jev grade, when the lead has one. The probe gate reads it. */
  grade_score?: number | null;
}

/**
 * The grade a trade+town pair needs before the answer engines are asked about
 * it: at least one lead in the pair at or above this score. Measured on the
 * pond's grades of 22 Oct 2026 (the before-reviews grade): 178 of 277 pairs
 * clear 45, and 19 of the 20 leads the reviews later put at high and fixable
 * sit in one of them (the twentieth was never graded before its reviews). At
 * 50, 156 pairs clear but two of the twenty are lost. The profile stage uses
 * the same bar per lead, so a profile is only written where it can be used.
 */
export const PROBE_BAR = 45;

interface ExistingRun {
  trade: string;
  city: string;
  state: string;
  question_id: QuestionId;
  engine: EngineKey;
  status: string;
}

function keyOf(pair: Pair): string {
  return `${pair.trade}|${pair.city}|${pair.state}`;
}

/**
 * The distinct trade+town pairs that still owe probe runs. A pair is owed when
 * any expected (question, engine) row is missing or sits at 'failed' — a failed
 * row is a hole in the evidence, not an answer, so it gets asked again.
 *
 * Leads with no trade or no city are skipped rather than guessed at. Order is
 * trade then city, so two runs of the same batch schedule identically.
 *
 * With a bar, a pair is owed only once one of its leads is graded at or above
 * it: an ungraded pair waits for the grade stage, and a pair whose leads all
 * graded below it is never asked. No bar (one lead researched on its own
 * record) asks regardless.
 */
export function pairsNeedingProbe(
  leads: Array<LeadLocation>,
  existing: Array<ExistingRun>,
  tradesBySlug: (slug: string) => { urgent: string | null } | null,
  bar?: number,
): Pair[] {
  // Normalize the leads down to distinct pairs first, so a town with forty
  // roofers costs one probe batch, not forty.
  const pairs = new Map<string, Pair>();
  const cleared = new Set<string>();
  for (const lead of leads) {
    const slug = (lead.trade ?? '').trim().toLowerCase();
    if (!slug) continue;
    const pair = toPair(slug, lead.city ?? '', lead.state);
    if (!pair) continue;
    const key = keyOf(pair);
    if (!pairs.has(key)) pairs.set(key, pair);
    if (bar === undefined || (typeof lead.grade_score === 'number' && lead.grade_score >= bar)) cleared.add(key);
  }
  for (const key of [...pairs.keys()]) if (!cleared.has(key)) pairs.delete(key);

  // Index what we already hold, so the check below is a lookup and not a scan.
  const held = new Set<string>();
  for (const row of existing) {
    if (row.status === 'failed') continue;
    const pair = toPair(row.trade, row.city, row.state);
    if (!pair) continue;
    held.add(`${keyOf(pair)}|${row.question_id}|${row.engine}`);
  }

  const needed: Pair[] = [];
  for (const pair of pairs.values()) {
    const trade = tradesBySlug(pair.trade);
    if (!trade) continue;
    const owed = expectedRuns(trade).some(
      (run) => !held.has(`${keyOf(pair)}|${run.question_id}|${run.engine}`),
    );
    if (owed) needed.push(pair);
  }

  needed.sort((a, b) => a.trade.localeCompare(b.trade) || a.city.localeCompare(b.city));
  return needed;
}
