// signals/types — the shapes the acquisition-signal vehicle passes around.
//
// The vehicle (src/lib/signals/README.md): a private-equity platform announces
// a local acquisition; every independent competitor nearby now has a reason
// to think about their own business. We verify the deal, find the
// competitors, read their public reviews for operational pain, write each one
// a free playbook under the standing rule, and hand the ones Griffin approves
// to Jordan, who asks permission before sending the playbook link.

// ── The deal ─────────────────────────────────────────────────────────────────

/** One acquired business, as the announcement names it. */
export interface DealTarget {
  name: string;
  city: string | null;
  state: string | null;
  /** Code found the name on the announcement page (normalized match). */
  verified: boolean;
}

/** What the model read off the announcement, before code checks it. */
export interface DealExtract {
  /** The buyer as announced (the platform), e.g. "TruTemp Services". */
  platform: string | null;
  /** The private-equity sponsors named, e.g. ["Centre Partners", "Baldwin Creek Partners"]. */
  sponsors: string[];
  targets: Array<{ name: string; city: string | null; state: string | null }>;
  /** ISO date as the page states it, or null. */
  announced_on: string | null;
  /** The trade the acquired businesses are in, as one of TRADES' slugs, or null. */
  trade: string | null;
  headline: string | null;
}

export interface VerifiedDeal {
  source_url: string;
  headline: string | null;
  platform: string | null;
  sponsors: string[];
  announced_on: string | null;
  trade: string | null;
  targets: DealTarget[];
  /** At least one target verified on the page. Nothing downstream runs otherwise. */
  verified: boolean;
  /** Why it is not verified, in plain words. */
  why: string | null;
}

// ── Reviews and pain ─────────────────────────────────────────────────────────

/** One public Google review, trimmed to what the vehicle uses. */
export interface Review {
  id: string | null;
  stars: number | null;
  text: string;
  published_at: string | null;
  owner_reply_at: string | null;
  owner_reply: string | null;
  url: string | null;
}

/**
 * The kinds of operational pain GJC's catalog fixes. Each is decided by code
 * from review words or review dates, never by a model.
 */
export type PainKind = 'missed-calls' | 'no-callback' | 'scheduling' | 'no-follow-up' | 'review-replies';

export interface PainHit {
  kind: PainKind;
  /** The review it came from. */
  review_id: string | null;
  stars: number | null;
  published_at: string | null;
  /** The sentence that matched, verbatim from the review. */
  quote: string;
}

export interface ReplyTiming {
  reviews: number;
  /** Reviews with an owner reply. */
  replied: number;
  /** Reviews at 3 stars or fewer with no owner reply. */
  unanswered_low: number;
  /** Observed days between review and reply, median, from listed dates only. */
  median_observed_days: number | null;
  /** One example pair, for the playbook's "observed dates" panel. */
  example: { review_at: string; reply_at: string } | null;
}

export type ProspectTier = 'high' | 'medium' | 'low';

export interface PainReport {
  hits: PainHit[];
  /** Counts per kind. */
  kinds: Partial<Record<PainKind, number>>;
  timing: ReplyTiming;
  score: number;
  tier: ProspectTier;
  /** Why the tier, in one plain line for the desk. */
  because: string;
}

// ── The prospect ─────────────────────────────────────────────────────────────

/** A competitor near an acquired shop, before it is stored. */
export interface ProspectDraft {
  place_id: string;
  business_name: string;
  city: string | null;
  state: string | null;
  address: string | null;
  website: string | null;
  phone: string | null;
  rating: number | null;
  reviews_count: number | null;
  maps_url: string | null;
  reviews: Review[];
}

export type Decision = 'pending' | 'approved' | 'skipped';
export type PlaybookStatus = 'none' | 'ready' | 'failed';

/**
 * A pond lead (the `leads` table), as the signal desk and the free-playbook
 * outreach read it. Signal prospects are ordinary leads (Griffin's ruling,
 * 18 Oct): signal_deal_id says which deal surfaced one; a Western Slope lead
 * with strong review pain and no deal has it null.
 */
export interface OutreachLead {
  id: string;
  business_name: string | null;
  first_name: string | null;
  last_name: string | null;
  city: string | null;
  state: string | null;
  county: string | null;
  trade: string | null;
  website: string | null;
  phone: string | null;
  emails: string[] | null;
  place_id: string | null;
  source_url: string | null;
  source_type: string | null;
  stage: string;
  gbp_json: { rating?: number | null; review_count?: number | null; maps_url?: string | null } | null;
  site_json: { emails?: string[]; owner_names?: string[] } | null;
  reviews_json: Review[] | null;
  pain_json: PainReport | null;
  pain_score: number | null;
  pain_tier: ProspectTier | null;
  reviews_checked_at: string | null;
  signal_deal_id: string | null;
  playbook_json: Playbook | null;
  playbook_status: PlaybookStatus;
  playbook_error: string | null;
  playbook_token: string | null;
  playbook_opened_at: string | null;
  outreach_decision: Decision;
  outreach_decided_by: string | null;
  outreach_decided_at: string | null;
  outreach_contact_name: string | null;
  outreach_contact_email: string | null;
  jordan_lead_id: string | null;
  created_at: string;
}

export interface DealRow extends VerifiedDeal {
  id: string;
  status: 'verified' | 'unverified' | 'searched' | 'failed';
  error: string | null;
  searched_at: string | null;
  created_at: string;
}

// ── The playbook ─────────────────────────────────────────────────────────────

export interface PlaybookFinding {
  id: string;
  /** A review pain the code found, or 'scope' for a playbook built from a SOW. */
  kind: PainKind | 'scope';
  title: string;
  /** Verbatim quotes, each checked against the scraped reviews. */
  quotes: string[];
  what_it_costs: string;
}

export interface PlaybookBreak {
  failure: string;
  consequence: string;
  what_handles_it: string;
}

export interface PlaybookFix {
  title: string;
  /** The finding this fix answers (PlaybookFinding.id). */
  finding: string;
  outcome: string;
  steps: Array<{ do: string; detail: string }>;
  systems: string[];
  data_needed: string[];
  where_it_breaks: PlaybookBreak[];
  measure: { metric: string; baseline: string; target: string };
  upkeep: string;
}

export interface Playbook {
  title: string;
  prepared_for: string;
  opening: string;
  findings: PlaybookFinding[];
  fixes: PlaybookFix[];
  first_100_days: Array<{ window: string; focus: string; actions: string[] }>;
  numbers_to_watch: Array<{ name: string; definition: string }>;
  doing_it_yourself: string;
  close: string;
  /** Set by code after generation, never by the model. */
  meta?: {
    /** What the playbook was written from: public reviews, or the SOW GJC drafted for the business. */
    mode?: 'reviews' | 'sow';
    /** The business, for the hand-this-to-your-AI prompt (ai-prompt.ts). */
    business?: { name: string; city: string | null; trade: string | null };
    model: string | null;
    generated_at: string;
    attempts: number;
    words: number;
    sources: Array<{ label: string; url: string | null }>;
    /** The numbers the page shows, as they were when the text was written. */
    facts?: { rating: number | null; reviewsRead: number; replied: number; timingExample: { review_at: string; reply_at: string } | null };
  };
}
