// signals/pain — what a business's own public reviews say is going wrong.
//
// Code decides every flag. A model never reads the reviews to "find pain":
// a flag is a sentence that matched a pattern below, quoted verbatim, or a
// count read off the review dates. That is what lets the playbook say "three
// of your customers wrote that nobody picked up" and have it be true.
//
// The patterns want a negation next to the act ("never called back", "nobody
// answered"), so "they always answer the phone" flags nothing. A sentence
// counts once per kind per review, so one angry paragraph cannot outvote
// twenty quiet customers.
//
// The reply timing is observed dates only (the video's caveat, kept): a
// listed reply date can be an edit, so it is never called a measured
// response time.

import type { PainHit, PainKind, PainReport, ProspectTier, ReplyTiming, Review } from './types.ts';

const PHONE_CONTEXT = /\b(?:phone|phones|call|calls|called|calling|voicemail|voice mail|rang|ringing|line)\b/i;

// Each kind: patterns tried sentence by sentence. A kind with `phone: true`
// also needs the sentence to be about the phone, so "nobody answered my
// question" is not a missed call.
const PATTERNS: Array<{ kind: PainKind; phone?: true; res: RegExp[] }> = [
  {
    kind: 'missed-calls',
    phone: true,
    res: [
      /\b(?:no\s?one|nobody|never|didn'?t|did not|don'?t|do not|won'?t|wouldn'?t|couldn'?t|could not|can'?t|cannot)\s+(?:\w+\s+){0,3}?(?:answer(?:ed|s|ing)?|pick(?:ed|s|ing)?\s+up)\b/i,
      /\b(?:went|goes|go|sent)\s+(?:straight\s+|right\s+|directly\s+)?to\s+(?:voice\s?mail|a\s+machine)\b/i,
      /\bvoice\s?mail\s+(?:box\s+)?(?:was\s+|is\s+)?full\b/i,
      /\b(?:couldn'?t|could not|can'?t|cannot|never)\s+(?:get|reach|get\s+a\s+hold\s+of|get\s+ahold\s+of|get\s+through\s+to)\s+(?:anyone|anybody|someone|a\s+person|a\s+human|them|the\s+office|him|her)\b/i,
    ],
  },
  {
    kind: 'no-callback',
    res: [
      /\bnever\s+(?:once\s+)?(?:got\s+a\s+|received\s+a\s+|had\s+a\s+)?(?:call|called|phoned)\s+(?:me\s+|us\s+)?back\b/i,
      /\b(?:didn'?t|did not|never|wouldn'?t|won'?t)\s+(?:bother\s+to\s+)?(?:return|returned)\s+(?:my|our|any\s+of\s+my|any\s+of\s+our|the)?\s*(?:calls?|messages?|voicemails?)\b/i,
      /\b(?:didn'?t|did not|never)\s+(?:bother\s+to\s+)?call\s+(?:me|us)\s+back\b/i,
      /\bno\s+(?:return(?:ed)?\s+)?(?:call\s?back|phone\s+call\s+back|returned\s+call)\b/i,
      /\bleft\s+(?:\w+\s+){0,3}?(?:messages?|voice\s?mails?)\b[^.!?]{0,80}\b(?:never|no\s?one|nobody|didn'?t|no\s+response|no\s+answer)\b/i,
    ],
  },
  {
    kind: 'scheduling',
    res: [
      /\bno[-\s]?show(?:ed)?\b/i,
      /\b(?:didn'?t|did not|never)\s+(?:\w+\s+){0,2}?show(?:ed)?(?:\s+up)?\b/i,
      /\bnever\s+(?:came|arrived)\b/i,
      /\bstood\s+(?:me|us)\s+up\b/i,
      /\bwaited\s+(?:around\s+)?(?:all\s+day|all\s+morning|all\s+afternoon|for\s+hours|\d+\s+hours|(?:two|three|four|five|six)\s+hours)\b/i,
      /\b(?:\d+|two|three|four|five)\s+hours?\s+late\b/i,
      /\brescheduled\s+(?:\w+\s+){0,2}?(?:times|again|twice|three\s+times)\b/i,
    ],
  },
  {
    kind: 'no-follow-up',
    res: [
      /\b(?:never|didn'?t|did not)\s+(?:\w+\s+){0,2}?(?:follow(?:ed)?[-\s]up|heard\s+(?:back|from\s+(?:them|him|her|anyone)))\b/i,
      /\bnever\s+(?:got|received|sent)\s+(?:me\s+|us\s+)?(?:a|the|my|our|an)\s+(?:quote|estimate|bid|proposal)\b/i,
      /\bstill\s+waiting\s+(?:on|for)\s+(?:a|the|my|our|an)\s+(?:quote|estimate|bid|call|response)\b/i,
      /\b(?:no|never\s+got\s+a)\s+(?:follow[-\s]up|response)\s+(?:on|to|about)\s+(?:the|my|our|a)\s+(?:quote|estimate|bid)\b/i,
    ],
  },
];

/** What each pain is worth to the score. The phone kinds are GJC's first catalog fixes. */
export const WEIGHT: Record<PainKind, number> = {
  'missed-calls': 3,
  'no-callback': 3,
  scheduling: 2,
  'no-follow-up': 2,
  'review-replies': 2,
};

export const PAIN_LABEL: Record<PainKind, string> = {
  'missed-calls': 'calls not answered',
  'no-callback': 'no call back',
  scheduling: 'missed or late appointments',
  'no-follow-up': 'quotes and follow-ups that never came',
  'review-replies': 'reviews left without a reply',
};

const QUOTE_MAX = 280;

/** Sentences, kept verbatim (trimmed), so a quote can be matched back to the review. */
export function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8);
}

function quoteOf(s: string): string {
  return s.length > QUOTE_MAX ? `${s.slice(0, QUOTE_MAX - 1).trimEnd()}…` : s;
}

/** Every pain hit in one review: at most one per kind, the first sentence that matched. */
export function reviewHits(review: Review): PainHit[] {
  const out: PainHit[] = [];
  const said = sentences(review.text ?? '');
  for (const p of PATTERNS) {
    for (const s of said) {
      if (p.phone && !PHONE_CONTEXT.test(s)) continue;
      if (p.res.some((re) => re.test(s))) {
        out.push({ kind: p.kind, review_id: review.id, stars: review.stars, published_at: review.published_at, quote: quoteOf(s) });
        break;
      }
    }
  }
  // A no-callback sentence usually reads as a missed call too ("left three
  // voicemails, nobody called back"); count it once, as the callback.
  const kinds = new Set(out.map((h) => h.kind));
  return kinds.has('no-callback') && kinds.has('missed-calls')
    ? out.filter((h) => !(h.kind === 'missed-calls' && out.find((x) => x.kind === 'no-callback')?.quote === h.quote))
    : out;
}

function days(fromIso: string, toIso: string): number | null {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.round((b - a) / 86_400_000);
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/** Who answered their reviews, and how long the listed dates say it took. */
export function replyTiming(reviews: Review[]): ReplyTiming {
  let replied = 0;
  let unansweredLow = 0;
  const gaps: number[] = [];
  let example: ReplyTiming['example'] = null;
  let exampleGap = -1;
  for (const r of reviews) {
    const hasReply = !!(r.owner_reply_at || (r.owner_reply && r.owner_reply.trim()));
    if (hasReply) replied++;
    else if (r.stars !== null && r.stars <= 3) unansweredLow++;
    if (r.published_at && r.owner_reply_at) {
      const d = days(r.published_at, r.owner_reply_at);
      if (d !== null) {
        gaps.push(d);
        // The example shown is the slowest observed reply: the one worth fixing.
        if (d > exampleGap) {
          exampleGap = d;
          example = { review_at: r.published_at, reply_at: r.owner_reply_at };
        }
      }
    }
  }
  return { reviews: reviews.length, replied, unanswered_low: unansweredLow, median_observed_days: median(gaps), example };
}

/** The whole read of one business: hits, timing, score, tier and the desk's one line. */
export function analyzePain(reviews: Review[]): PainReport {
  const hits = reviews.flatMap(reviewHits);
  const kinds: Partial<Record<PainKind, number>> = {};
  for (const h of hits) kinds[h.kind] = (kinds[h.kind] ?? 0) + 1;
  const timing = replyTiming(reviews);

  let score = 0;
  for (const h of hits) score += WEIGHT[h.kind] + (h.stars !== null && h.stars <= 2 ? 1 : 0);
  const replyGap = timing.unanswered_low >= 2 || (timing.reviews >= 10 && timing.replied / timing.reviews < 0.25);
  if (replyGap) {
    kinds['review-replies'] = Math.max(timing.unanswered_low, 1);
    score += WEIGHT['review-replies'] + (timing.unanswered_low >= 4 ? 1 : 0);
  }

  // High needs a customer's own words. Dates alone make a medium at most.
  const tier: ProspectTier = score >= 5 && hits.length > 0 ? 'high' : score >= 2 ? 'medium' : 'low';
  const parts = (Object.keys(kinds) as PainKind[])
    .sort((a, b) => (kinds[b] ?? 0) - (kinds[a] ?? 0))
    .map((k) => (k === 'review-replies' ? `${timing.unanswered_low} low review${timing.unanswered_low === 1 ? '' : 's'} with no reply` : `${kinds[k]} mention${kinds[k] === 1 ? '' : 's'} of ${PAIN_LABEL[k]}`));
  const because = parts.length ? `${parts.join('; ')} (of the ${reviews.length} newest reviews)` : `Nothing in the ${reviews.length} newest reviews points at a fixable problem.`;
  return { hits, kinds, timing, score, tier, because };
}

/** Lower-case, curly quotes straightened, whitespace collapsed: how quotes are matched. */
export function normQuote(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/…$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A quote appears, word for word, in one of the reviews. */
export function quoteInReviews(quote: string, reviews: Review[]): boolean {
  const q = normQuote(quote);
  if (q.length < 8) return false;
  return reviews.some((r) => normQuote(r.text ?? '').includes(q));
}
