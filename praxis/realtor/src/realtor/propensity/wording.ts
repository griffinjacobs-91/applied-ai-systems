// realtor/propensity/wording — the one-line reason on a likelihood score.
// Pure: the evidence bundle, the prompt and the refusal filter. The call is
// in word.ts.
//
// The score and its top three signals are CODE's. The model only words one
// line from those three signals, and the line is refused when it:
//   - holds a number the signals do not (the brief opener's filter,
//     brief.ts inventedDigits / inventedNumberWords), or a percent or a
//     dollar figure;
//   - talks money or value, or promises anything;
//   - names anything on fair-housing.ts's list that the signals do not
//     already say (an address can hold a word like "Mission");
//   - runs past one sentence, or uses a dash.
// A refused or missing line leaves the score whole: the card shows the three
// signals without a line.

import { createHash } from 'node:crypto';
import { inventedDigits, inventedNumberWords } from '../brief.ts';
import { PROMPT_PROHIBITION, protectedTermIn } from './fair-housing.ts';
import { SIGNAL_LABELS, type Signal } from './types.ts';

/** Bump when the prompt or the checks change: every stored line is re-worded on the next pass. */
export const WORDING_VERSION = 1;

export const REASON_SYSTEM = [
  'You write one short line for a real estate agent: why this person in her book may buy or sell soon.',
  'Use ONLY the signals given. Plain words, no sales language, no exclamation marks, no dashes of any kind.',
  'Never write a number, date or count that is not in the signals. Do not mention money, prices, value, equity, rates or the market.',
  PROMPT_PROHIBITION,
  'Do not say they WILL buy or sell; say what the record shows.',
  'Return only JSON: {"reason": "<one sentence, under 160 characters>"}. If the signals give you nothing to say, return {"error": "<why>"}.',
].join('\n');

export interface ReasonEvidence {
  user: string;
  evidenceText: string;
  hash: string;
}

const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function spoken(d: string): string {
  const [y, m, dd] = d.split('-').map(Number);
  return `${MONTHS_LONG[m - 1]} ${dd}, ${y}`;
}

export function reasonEvidence(firstName: string | null, top: readonly Pick<Signal, 'kind' | 'date' | 'detail'>[]): ReasonEvidence {
  const bundle = {
    contact_first_name: firstName || null,
    signals: top.map((s) => ({ what: SIGNAL_LABELS[s.kind], on: spoken(s.date), fact: s.detail })),
  };
  const evidenceText = JSON.stringify(bundle);
  const hash = createHash('sha256').update(`${WORDING_VERSION}\n${evidenceText}`).digest('hex');
  const user = 'SIGNALS (return only the JSON object described in your instructions):\n\n' + JSON.stringify(bundle, null, 2);
  return { user, evidenceText, hash };
}

const MONEY = /\b(worth|value|values|valuation|valued|equity|apprais\w*|appreciat\w*|comps?|price|prices|priced|pricing|rates?|mortgage|market|profit|cash)\b|\$|%/i;
const PROMISE = /\b(guarantee\w*|promise\w*|definitely|certainly|will (?:buy|sell|move|list))\b/i;

function stripFences(text: string): string {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  return s === -1 || e <= s ? t : t.slice(s, e + 1);
}

export type ReasonValidation = { ok: true; reason: string } | { ok: false; error: string; declined?: boolean };

/** A protected term in the line that the evidence itself does not hold. */
export function protectedNotInEvidence(line: string, evidenceText: string): string | null {
  const ev = evidenceText.toLowerCase();
  let rest = line;
  for (let i = 0; i < 20; i++) {
    const t = protectedTermIn(rest);
    if (!t) return null;
    if (!new RegExp(`\\b${t.replace(/\s+/g, '\\s+')}\\b`, 'i').test(ev)) return t;
    rest = rest.replace(new RegExp(`\\b${t.replace(/\s+/g, '\\s+')}\\b`, 'ig'), ' ');
  }
  return null;
}

export function validateReason(raw: string, evidenceText: string): ReasonValidation {
  let o: unknown;
  try {
    o = JSON.parse(stripFences(raw));
  } catch {
    return { ok: false, error: 'The model did not return JSON.' };
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { ok: false, error: 'The model returned something other than an object.' };
  const rec = o as Record<string, unknown>;
  if (typeof rec.error === 'string' && rec.error.trim()) return { ok: false, error: rec.error.trim().slice(0, 300), declined: true };
  const reason = typeof rec.reason === 'string' ? rec.reason.trim().replace(/\s+/g, ' ') : '';
  if (!reason) return { ok: false, error: 'The model returned no reason.' };
  if (reason.length > 200) return { ok: false, error: 'The reason ran past one line.' };
  const sentences = reason.split(/(?<=[.!?])\s+(?=\S)/).filter((s) => s.trim() !== '');
  if (sentences.length > 1) return { ok: false, error: `The reason is ${sentences.length} sentences; one only.` };
  const invented = [...inventedDigits(reason, evidenceText), ...inventedNumberWords(reason, evidenceText)];
  if (invented.length > 0) return { ok: false, error: `Numbers not in the signals: ${invented.join(', ')}` };
  if (MONEY.test(reason)) return { ok: false, error: 'The reason talks money or value.' };
  if (PROMISE.test(reason)) return { ok: false, error: 'The reason promises an outcome.' };
  const p = protectedNotInEvidence(reason, evidenceText);
  if (p) return { ok: false, error: `The reason names a protected trait (${p}).` };
  if (/[‒-―]|\s-\s/.test(reason)) return { ok: false, error: 'The reason uses a dash.' };
  return { ok: true, reason };
}

