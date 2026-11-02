/** Small numeric and date helpers. No dependencies, no surprises. */

import type { IsoDate, Sampled } from './types.ts';
import { NOISE_FLOOR_TRADES } from './constants.ts';

/** Parse "YYYY-MM-DD" or a full ISO string to epoch milliseconds, UTC. */
export function parseDate(d: IsoDate): number {
  const s = d.length === 10 ? `${d}T00:00:00.000Z` : d;
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`unparseable date: ${d}`);
  return t;
}

export const MS_PER_DAY = 86_400_000;

/** Calendar days from a to b. Fractional if the inputs carry a time. */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return (parseDate(b) - parseDate(a)) / MS_PER_DAY;
}

/** Inclusive on both ends. */
export function withinWindow(d: IsoDate, start: IsoDate, end: IsoDate): boolean {
  const t = parseDate(d);
  return t >= parseDate(start) && t <= parseDate(end);
}

/** Overlap in days between two closed intervals, zero if they do not touch. */
export function overlapDays(
  aStart: IsoDate,
  aEnd: IsoDate,
  bStart: IsoDate,
  bEnd: IsoDate,
): number {
  const lo = Math.max(parseDate(aStart), parseDate(bStart));
  const hi = Math.min(parseDate(aEnd), parseDate(bEnd));
  if (hi < lo) return 0;
  // Both ends inclusive, so a single shared day counts as one day.
  return (hi - lo) / MS_PER_DAY + 1;
}

export function round(x: number, dp = 2): number {
  if (!Number.isFinite(x)) return x;
  const f = 10 ** dp;
  return Math.round((x + Number.EPSILON * Math.sign(x) * Math.abs(x)) * f) / f;
}

export function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function sum(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

/**
 * Percent change from a to b, in points. NULL, never a throw, when the base is
 * zero or not a finite number.
 *
 * This used to throw. A window whose first equity snapshot is zero is a real
 * thing on a book that was funded mid-window, and a throw here reached the page
 * as a 500 on /score rather than as an honest "there is no return to report".
 * Every caller already handles null.
 */
export function pctChange(from: number, to: number): number | null {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return null;
  return ((to - from) / from) * 100;
}

/** Attach a sample size and the noise flag to any figure. */
export function sampled(n: number, floor = NOISE_FLOOR_TRADES): Sampled {
  return { n, withinNoise: n < floor };
}

/** Format a signed percent for the email render, e.g. "+7.22%" or "-9.64%". */
export function fmtPct(x: number | null, dp = 2): string {
  if (x === null || !Number.isFinite(x)) return 'n/a';
  const r = round(x, dp);
  const sign = r > 0 ? '+' : '';
  return `${sign}${r.toFixed(dp)}%`;
}

/** Format an unsigned percent, e.g. "64.00%". */
export function fmtRate(x: number | null, dp = 2): string {
  if (x === null || !Number.isFinite(x)) return 'n/a';
  return `${round(x, dp).toFixed(dp)}%`;
}

export function fmtUsd(x: number | null, dp = 2): string {
  if (x === null || !Number.isFinite(x)) return 'n/a';
  const r = round(x, dp);
  const sign = r < 0 ? '-' : '';
  const [whole, frac] = Math.abs(r).toFixed(dp).split('.');
  const grouped = (whole as string).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${grouped}${frac ? `.${frac}` : ''}`;
}

/** "on 25 trades" / "on 25 trades (within noise)". */
export function fmtN(s: Sampled, unit = 'trades'): string {
  return s.withinNoise ? `on ${s.n} ${unit} (within noise)` : `on ${s.n} ${unit}`;
}
