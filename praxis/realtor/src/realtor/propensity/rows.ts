// realtor/propensity/rows — the stored shapes of a signal and a score, and the
// mapping between them and the pure modules. Pure: no Supabase here, so the
// tests and the card's view can import it off disk.

import type { Recomputed } from './recompute.ts';
import { WEIGHTS } from './rubric.ts';
import { SIGNAL_LABELS, type Signal, type StoredSignal } from './types.ts';

export const SIGNAL_COLUMNS = 'id, lead_id, kind, source, event_date, source_ref, source_url, weight, detail, payload, found_at';

export interface SignalRow {
  id: string;
  lead_id: string;
  kind: string;
  source: string;
  event_date: string;
  source_ref: string | null;
  source_url: string | null;
  weight: number;
  detail: string;
  payload: Record<string, unknown> | null;
  found_at: string;
}

export function toStored(r: SignalRow): StoredSignal {
  return {
    id: r.id,
    lead_id: r.lead_id,
    kind: r.kind as StoredSignal['kind'],
    source: r.source as StoredSignal['source'],
    date: r.event_date,
    ref: r.source_ref,
    url: r.source_url,
    weight: Number(r.weight),
    detail: r.detail,
    payload: r.payload ?? {},
    found_at: r.found_at,
  };
}

export function sigKey(s: Pick<Signal, 'kind' | 'source' | 'ref' | 'url'>): string {
  return `${s.kind}|${s.source}|${s.ref ?? ''}|${s.url ?? ''}`.slice(0, 500);
}

export function toRow(leadId: string, s: Signal): Record<string, unknown> {
  return {
    lead_id: leadId,
    kind: s.kind,
    source: s.source,
    event_date: s.date,
    source_ref: s.ref,
    source_url: s.url,
    weight: WEIGHTS[s.kind],
    detail: s.detail.slice(0, 400),
    payload: s.payload ?? {},
    sig_key: sigKey(s),
  };
}

// ── The score row ────────────────────────────────────────────────────────────

export interface ScoreRow {
  lead_id: string;
  score: number | null;
  points: number;
  signal_count: number;
  top_signals: Array<{ kind: string; label: string; date: string; source: string; ref: string | null; url: string | null; detail: string; weight: number }>;
  held_at_four: string | null;
  sources_run: string[];
  reason: string | null;
  reason_hash: string | null;
  reason_model: string | null;
  rubric_version: number;
  computed_at: string;
  computed_by: string;
}

export const SCORE_COLUMNS =
  'lead_id, score, points, signal_count, top_signals, held_at_four, sources_run, reason, reason_hash, reason_model, rubric_version, computed_at, computed_by';

export function scoreRowFrom(leadId: string, r: Recomputed, sourcesRun: readonly string[], by: 'run' | 'sweep' | 'profile', keepReason: Pick<ScoreRow, 'reason' | 'reason_hash' | 'reason_model'> | null): Record<string, unknown> {
  return {
    lead_id: leadId,
    score: r.score.score,
    points: r.score.points,
    signal_count: r.score.counted.length,
    top_signals: r.score.top.map((x) => ({
      kind: x.signal.kind,
      label: SIGNAL_LABELS[x.signal.kind],
      date: x.signal.date,
      source: x.signal.source,
      ref: x.signal.ref,
      url: x.signal.url,
      detail: x.signal.detail,
      weight: x.weight,
    })),
    held_at_four: r.score.heldAtFour,
    sources_run: [...new Set(['crm', ...sourcesRun])],
    reason: keepReason?.reason ?? null,
    reason_hash: keepReason?.reason ? keepReason.reason_hash : null,
    reason_model: keepReason?.reason ? keepReason.reason_model : null,
    rubric_version: r.score.rubricVersion,
    computed_at: new Date().toISOString(),
    computed_by: by,
  };
}

/** A short, stable tag of which signals a line was worded from (the line's hash ends with it). */
export function hashTop(topKey: string): string {
  let h = 5381;
  for (let i = 0; i < topKey.length; i++) h = ((h << 5) + h + topKey.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

