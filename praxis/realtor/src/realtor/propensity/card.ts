// realtor/propensity/card — what the profile's Likelihood card shows. Pure:
// data.ts loadCard reads the two tables and hands them here.

import { effectiveWeight, scoreText, RUBRIC_LINES } from './rubric.ts';
import { mergeSignals, RESEARCH_SOURCES } from './recompute.ts';
import { SIGNAL_LABELS, type StoredSignal } from './types.ts';
import type { ScoreRow } from './rows.ts';

export const SOURCE_NAMES: Record<string, string> = {
  crm: 'Your CRM',
  deed: 'County deed',
  parcel: 'County parcel layer',
  eagleweb: 'County sale search',
  sos: 'Colorado SOS',
  web: 'Public web',
  pdl: 'People Data Labs',
};

export interface CardSignal {
  label: string;
  date: string;
  source: string;
  detail: string;
  url: string | null;
  ref: string | null;
  weight: number;
}

export interface CardView {
  scored: boolean;
  score: string;
  scoreNumber: number | null;
  points: number | null;
  reason: string | null;
  heldAtFour: string | null;
  top: CardSignal[];
  all: CardSignal[];
  computedAt: string | null;
  computedBy: string | null;
  /** In words: which research has run for this contact, and which has not. */
  researchLine: string;
  rubric: readonly string[];
}

function view(s: StoredSignal, today: string): CardSignal {
  return { label: SIGNAL_LABELS[s.kind], date: s.date, source: SOURCE_NAMES[s.source] ?? s.source, detail: s.detail, url: s.url, ref: s.ref, weight: effectiveWeight(s, today) };
}

export function researchLine(sourcesRun: readonly string[]): string {
  const ran = new Set(sourcesRun);
  const research = RESEARCH_SOURCES.filter((s) => ran.has(s));
  if (research.length === 0) {
    return 'Read from your CRM only. County deed, Colorado SOS, web and People Data Labs research has not run for this contact.';
  }
  const notRun = (['deed', 'sos', 'web', 'pdl'] as const).filter((s) => !ran.has(s)).map((s) => SOURCE_NAMES[s]);
  return `Read from your CRM and ${research.map((s) => SOURCE_NAMES[s]).join(', ')}.${notRun.length ? ` Not run: ${notRun.join(', ')}.` : ''}`;
}

export function cardView(score: ScoreRow | null, stored: readonly StoredSignal[], today: string): CardView {
  const crm = stored.filter((s) => s.source === 'crm');
  const merged = mergeSignals(crm, stored.filter((s) => s.source !== 'crm'), today) as StoredSignal[];
  const all = merged
    .map((s) => view(s, today))
    .filter((s) => s.weight !== 0)
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight) || (a.date < b.date ? 1 : -1));
  return {
    scored: !!score,
    score: score ? scoreText(score.score) : '—',
    scoreNumber: score?.score ?? null,
    points: score ? Number(score.points) : null,
    reason: score?.reason ?? null,
    heldAtFour: score?.held_at_four ?? null,
    top: (score?.top_signals ?? []).map((t) => ({ label: t.label, date: t.date, source: SOURCE_NAMES[t.source] ?? t.source, detail: t.detail, url: t.url, ref: t.ref, weight: t.weight })),
    all,
    computedAt: score?.computed_at ?? null,
    computedBy: score?.computed_by ?? null,
    researchLine: researchLine(score?.sources_run ?? ['crm']),
    rubric: RUBRIC_LINES,
  };
}

