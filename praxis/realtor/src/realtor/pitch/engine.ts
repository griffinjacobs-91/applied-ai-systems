// realtor/pitch/engine — what she can offer someone, picked by code from facts.
//
// Pure: no I/O, no model, no context-specific knowledge. A context adapter
// (contexts/targets.ts today; contact, today, project, partner, pipeline and
// inquiry next) turns its own records into a flat FACTS record of named
// fields, and hands the engine its own list of RULES. The engine:
//
//   1. refuses a rule whose declared facts are missing (undefined or null):
//      it does not fire, and the refusal is returned with the missing names,
//      never dropped in silence;
//   2. runs each remaining rule's `when`; a rule that fires becomes an ANGLE
//      carrying its label, its facts line (the rule's own template over the
//      facts), the evidence rows that fired it, and the assets it leans on;
//   3. drops every angle the context has blocked (a builder that is exclusive,
//      sells direct or is flagged never gets a listing ask: block 'listing');
//   4. sorts by weight, highest first, then by rule id so a tie is stable.
//
// The model is never called here. The only model call is word.ts, which words
// the top angles from their facts lines and refuses anything they do not say.
//
// ADDING A CONTEXT. Write contexts/<name>.ts: a facts builder from that
// context's records, a list of rules made with defineRule(), and a function
// that calls evaluate(). Nothing in this file changes.

/** A flat record of named facts. A missing fact is undefined or null. */
export type Facts = Readonly<Record<string, unknown>>;

/** What an angle asks of the person, so a context can block a whole class. */
export type AngleClass = 'listing' | 'buyer' | 'land' | 'referral' | 'question' | 'reach';

export interface Rule<F extends Facts = Facts> {
  /** Stable id, snake case: 'bring_buyers'. */
  id: string;
  /** The contexts this rule is written for ('targets', 'contact', ...). */
  contexts: readonly string[];
  /** The named facts it needs. Any one missing and the rule refuses to fire. */
  needs: readonly (keyof F & string)[];
  /** Higher is stronger. */
  weight: number;
  class: AngleClass;
  /** The short name on the card: 'Bring buyers'. */
  label: string;
  /** Fires on the facts. Only called when every declared fact is present. */
  when: (f: F) => boolean;
  /** The facts line: plain sentences built only from the facts (and assets). */
  facts: (f: F) => string[];
  /** The evidence row ids that fired it, when the facts carry them. */
  evidence?: (f: F) => string[];
  /** The asset fields (assets.ts) the wording may use for this angle. */
  assets?: readonly string[];
  /** A line the wording must obey for this angle ('never ask for a listing'). */
  rule?: string;
}

export function defineRule<F extends Facts>(r: Rule<F>): Rule<F> {
  if (!/^[a-z][a-z0-9_]*$/.test(r.id)) throw new Error(`pitch rule id must be snake case: ${r.id}`);
  if (!r.contexts.length) throw new Error(`pitch rule ${r.id} names no context`);
  return r;
}

export interface Angle {
  id: string;
  label: string;
  class: AngleClass;
  weight: number;
  facts: string[];
  evidenceIds: string[];
  assets: string[];
  rule: string | null;
}

export interface Evaluation {
  /** Every angle that fired and was not blocked, strongest first. */
  angles: Angle[];
  /** Rules that could not run: a declared fact was missing. */
  refused: Array<{ id: string; missing: string[] }>;
  /** Rules that fired but were blocked by the context. */
  blocked: Array<{ id: string; class: AngleClass }>;
}

const missing = (v: unknown) => v === undefined || v === null || (typeof v === 'number' && !Number.isFinite(v));

/** Run the rules for one context over one facts record. Pure. */
export function evaluate<F extends Facts>(rules: readonly Rule<F>[], context: string, facts: F, opts: { block?: ReadonlySet<AngleClass> } = {}): Evaluation {
  const out: Evaluation = { angles: [], refused: [], blocked: [] };
  for (const r of rules) {
    if (!r.contexts.includes(context)) continue;
    const gaps = r.needs.filter((k) => missing(facts[k]));
    if (gaps.length) {
      out.refused.push({ id: r.id, missing: [...gaps] });
      continue;
    }
    if (!r.when(facts)) continue;
    if (opts.block?.has(r.class)) {
      out.blocked.push({ id: r.id, class: r.class });
      continue;
    }
    out.angles.push({
      id: r.id,
      label: r.label,
      class: r.class,
      weight: r.weight,
      facts: r.facts(facts),
      evidenceIds: r.evidence ? r.evidence(facts) : [],
      assets: [...(r.assets ?? [])],
      rule: r.rule ?? null,
    });
  }
  out.angles.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
  return out;
}

/** The top n angles, and a key that changes when they do (a stored opener for other angles is stale). */
export function topAngles(angles: readonly Angle[], n = 2): { top: Angle[]; key: string } {
  const top = angles.slice(0, n);
  return { top, key: top.map((a) => a.id).join('+') };
}
