// realtor/propensity/sweep — when the nightly realtor sweep also recomputes
// the likelihood scores. Pure.
//
// The job is the existing /api/cron/realtor-stage-sweep (08:00 UTC daily);
// no new cron. On PROPENSITY_WEEKDAY (Monday, Denver) it recomputes every
// contact's FREE signals and score (recompute.ts): no county, no Firecrawl,
// no People Data Labs, no model. It also recomputes on any other day when a
// stored score was written under an older rubric, so a rubric change reaches
// the whole book by the next morning instead of the next Monday.
//
// Model wording of the one-line reason is off unless PROPENSITY_WORDING is
// 'on' for the deploy (Griffin, 23 Sep: no research or wording on her real
// contacts until he has seen how many there are). The sweep never words.

import { RUBRIC_VERSION } from './rubric.ts';

/** 0 = Sunday. Monday. */
export const PROPENSITY_WEEKDAY = 1;

function weekday(today: string): number {
  const [y, m, d] = today.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
}

export function isPropensityDay(today: string): boolean {
  return weekday(today) === PROPENSITY_WEEKDAY;
}

/**
 * Should tonight's sweep recompute? Monday always; any day when a stored
 * score is from an older rubric, or when no score has been written yet.
 */
export function shouldRecompute(today: string, storedRubricVersions: readonly number[]): { run: boolean; why: string } {
  if (isPropensityDay(today)) return { run: true, why: 'weekly' };
  if (storedRubricVersions.length === 0) return { run: true, why: 'no scores yet' };
  if (storedRubricVersions.some((v) => v !== RUBRIC_VERSION)) return { run: true, why: `rubric ${RUBRIC_VERSION}` };
  return { run: false, why: 'not the weekly day' };
}

/** Is model wording allowed on this deploy? Off unless the env says 'on'. */
export function wordingEnabled(env: string | undefined): boolean {
  return (env ?? '').trim().toLowerCase() === 'on';
}
