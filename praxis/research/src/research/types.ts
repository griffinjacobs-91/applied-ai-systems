// The shapes every research module agrees on. Types only, no runtime code, so
// any module (and any test that loads a module off disk) can import from here
// without pulling in the Supabase client or a network call.
//
// Three layers, three keys:
//   1. probe_runs      — one row per (batch, trade, city, state, question, engine, run).
//                        Shared by every lead in that trade + town.
//   2. per-lead facts  — leads.gbp_json, leads.site_json. Machine-gathered, no model.
//   3. per-lead profile— leads.research_json. Composed from 1 + 2, with the model
//                        writing only the gap, the hook and the confirm notes.
//
// The honesty rule that runs through all of it: we only ever say what we saw.
// "not named" means the name was absent from an answer we hold; "not checked"
// means an engine failed or was never run; "not seen" on a directory means we
// did not observe a listing, which is not the same as there being none.

// ── Trades and questions ─────────────────────────────────────────────────────

export interface Trade {
  /** Stable key stored on leads.trade, e.g. 'roofing'. */
  slug: string;
  /** Human label, e.g. 'Roofing'. */
  label: string;
  /** The AO vertical key this trade rolls up to (src/lib/research/ao.ts VERTICALS). */
  vertical: string;
  /** What a buyer calls one of these: 'roofer', 'plumber', 'dentist'. */
  noun: string;
  /**
   * The urgent buyer scenario, or null when the trade has no emergency ("my
   * roof is leaking" makes sense; "I urgently need a boutique" does not). A
   * null here means the pair costs four probe runs instead of eight.
   */
  urgent: string | null;
  /** Google Places categories that map to this trade with no model in the loop. */
  placesCategories: string[];
  /**
   * Words in the BUSINESS NAME that settle the trade with no model in the loop
   * ('yoga', 'barber', 'crossfit'). Matched on word boundaries against the
   * folded name. Specific trades carry these; coarse buckets do not.
   */
  nameHints?: string[];
}

export type QuestionId = 'best' | 'urgent';

export interface ProbeQuestion {
  id: QuestionId;
  text: string;
  /** sha256 hex of the normalized question text. */
  sha: string;
}

// ── Engines ──────────────────────────────────────────────────────────────────

export type EngineKey = 'perplexity' | 'chatgpt' | 'gemini' | 'claude';

export const ENGINE_KEYS: readonly EngineKey[] = ['perplexity', 'chatgpt', 'gemini', 'claude'] as const;

export interface EngineConfig {
  key: EngineKey;
  label: string;
  /** OpenRouter model slug. */
  model: string;
  surface: 'api';
  retrieval: 'native-live-web' | 'provider-native-web-search';
  /** The OpenRouter plugin block, or null when retrieval is built into the model. */
  webPlugin: { id: 'web'; engine: 'native'; max_results: number } | null;
  citations: boolean;
  /** The consumer product this surface is NOT. Reproduced on every profile. */
  consumerProduct: string;
  surfaceNote: string;
}

/** Engines this stack cannot reach. Listed so no surface ever implies coverage. */
export const NOT_PROBED: readonly string[] = ['Google AI Overviews', 'Copilot', 'Grok', 'Meta AI'] as const;

export interface ProbeAnswer {
  text: string;
  citations: string[];
  modelReturned: string | null;
  provider: string | null;
  retrieval: string;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
  generationId: string | null;
}

// ── probe_runs rows ──────────────────────────────────────────────────────────

export type ProbeRunStatus = 'answered' | 'failed';

export interface ProbeRunRow {
  id: string;
  batch: string;
  trade: string;
  city: string;
  state: string;
  question_id: QuestionId;
  question: string;
  question_sha: string;
  question_set_version: string;
  engine: EngineKey;
  model_requested: string;
  model_returned: string | null;
  provider: string | null;
  retrieval: string | null;
  run_index: number;
  status: ProbeRunStatus;
  answer_text: string | null;
  citations: string[];
  /** Business names in order of first mention, written by the extraction step. Null until extracted. */
  extracted_names: string[] | null;
  extract_model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_usd: number | null;
  generation_id: string | null;
  error: string | null;
  created_at: string;
}

/** What a probe run looks like before it has an id (the insert shape). */
export type ProbeRunInsert = Omit<ProbeRunRow, 'id' | 'created_at'>;

// ── Google Business Profile facts (leads.gbp_json) ───────────────────────────

export interface GbpHours {
  day: string;
  hours: string;
}

export interface GbpFacts {
  checked: true;
  /** False when the lookup ran and nothing matched this business in this town. */
  exists: boolean;
  /**
   * 'wide' when this was the wide search (name and phone, in the lead's town, five results each).
   * Absent on the old one-result batch search, whose misses are not proof there is no listing.
   */
  lookup?: 'wide';
  /** How the listing was found: by place id, by phone, by website host, by name. Null when not found. */
  matched_by: 'place_id' | 'phone' | 'website' | 'name' | null;
  /** Null when the actor did not report it; never guessed. */
  claimed: boolean | null;
  name: string | null;
  category: string | null;
  categories: string[];
  address: string | null;
  city: string | null;
  phone: string | null;
  website: string | null;
  maps_url: string | null;
  place_id: string | null;
  rating: number | null;
  review_count: number | null;
  /** ISO date of the newest review when the lookup asked for it. */
  newest_review_at: string | null;
  hours: GbpHours[];
  /** The closing time on the day the lookup ran, e.g. '5:00 PM', or null. */
  closes_today: string | null;
  permanently_closed: boolean;
  temporarily_closed: boolean;
  /** The search string or start url the lookup used. Kept so a wrong match can be traced. */
  query: string;
  fetched_at: string;
  /**
   * Another lead in the pond already carries this listing's place id: the
   * same business twice under two names or two sources. Recorded, never
   * merged by the machine; a human decides which row lives.
   */
  duplicate_of?: { id: string; business_name: string | null } | null;
}

/** A Google Places item as the Apify actor `compass~crawler-google-places` returns it. Loose on purpose. */
export interface ApifyPlace {
  title?: string | null;
  name?: string | null;
  categoryName?: string | null;
  categories?: string[] | null;
  address?: string | null;
  street?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  phone?: string | null;
  phoneUnformatted?: string | null;
  website?: string | null;
  url?: string | null;
  placeId?: string | null;
  totalScore?: number | null;
  reviewsCount?: number | null;
  claimThisBusiness?: boolean | null;
  permanentlyClosed?: boolean | null;
  temporarilyClosed?: boolean | null;
  openingHours?: Array<{ day?: string | null; hours?: string | null }> | null;
  reviews?: Array<{ publishedAtDate?: string | null; publishAt?: string | null }> | null;
  location?: { lat?: number | null; lng?: number | null } | null;
  imageUrls?: string[] | null;
  [key: string]: unknown;
}

// ── Website facts (leads.site_json) ──────────────────────────────────────────

export interface SiteFacts {
  checked: true;
  url: string;
  final_url: string | null;
  https: boolean;
  /** The homepage answered with a 2xx. */
  ok: boolean;
  status: number | null;
  /** A viewport meta tag is present, the cheapest honest proxy for "works on a phone". */
  mobile_viewport: boolean;
  header_phone: string | null;
  phones: string[];
  emails: string[];
  services: string[];
  /** AO towns mentioned anywhere on the pages read. */
  towns_mentioned: string[];
  /** Paths that look like per-town pages, e.g. '/fruita-roofing'. */
  town_pages: string[];
  has_service_area_page: boolean;
  twenty_four_seven: boolean;
  /** The booking host seen, e.g. 'calendly.com', or null. */
  online_booking: string | null;
  has_contact_form: boolean;
  /** 'wordpress' | 'wix' | 'squarespace' | 'godaddy' | 'weebly' | 'duda' | 'shopify' | 'custom' | null */
  builder: string | null;
  /** A years-in-business claim as written: 'since 1998', '25 years'. */
  years_claim: string | null;
  /** Best effort, from about pages and schema founder fields. */
  owner_names: string[];
  social_links: string[];
  directory_links: string[];
  schema_types: string[];
  /** Pages actually read, so a claim can be traced. */
  pages_read: string[];
  error: string | null;
  fetched_at: string;
}

// ── Directories ──────────────────────────────────────────────────────────────

export type DirectoryKey =
  | 'google_business'
  | 'facebook'
  | 'yelp'
  | 'bbb'
  | 'angi'
  | 'thumbtack'
  | 'homeadvisor'
  | 'nextdoor'
  | 'yellowpages';

export type DirectoryStatus = 'found' | 'not_seen' | 'not_checked';

export interface DirectoryObservation {
  status: DirectoryStatus;
  url: string | null;
}

export type Directories = Record<DirectoryKey, DirectoryObservation>;

// ── The composed profile (leads.research_json) ───────────────────────────────

export type EngineResultStatus = 'answered' | 'failed' | 'not_run';

export interface EngineResult {
  engine: EngineKey;
  label: string;
  question_id: QuestionId;
  status: EngineResultStatus;
  /** Null when the engine did not answer. Never null on an answered run. */
  named: boolean | null;
  /** 1-based position among the extracted names, when named. */
  position: number | null;
  /** The businesses this answer named, in order. */
  names: string[];
  probe_run_id: string | null;
  model: string | null;
}

export type AeoStatus = 'absent' | 'partial' | 'present' | 'unknown';

export interface Competitor {
  name: string;
  /** How many answers named them. */
  mentions: number;
  engines: EngineKey[];
  best_position: number;
}

export interface ConfirmFact {
  key: 'years' | 'headcount' | 'counties' | 'listings' | 'website';
  /** Said out loud in the intake's own bracket words: "You have been at this since 1998, so 20 plus years?" */
  statement: string;
  /** The intake field this confirms, so the answer drops straight into the form. */
  intake_field: string;
  /** The bracket value, when one could be derived. */
  value: string | string[] | null;
}

export interface CatalogGate {
  /** The catalog number from src/lib/audit-prompt.ts SERVICE_CATALOG. Never 23 or 24. */
  item: number;
  title: string;
  /** The deterministic reason, from facts, not from a model. */
  because: string;
}

export interface EmptySlot {
  key: string;
  /** The question the sales partner asks; the value is never pre-computed. */
  question: string;
  intake_field: string | null;
}

/** What the model is allowed to write. Everything else in ResearchJson is code-derived. */
export interface ModelProfile {
  gap: string;
  hook: string;
  confirm_notes: Array<{ key: ConfirmFact['key']; statement: string }>;
  gate_reasons: Record<string, string>;
  cautions: string[];
}

export interface ResearchJson {
  version: number;
  snapshot_at: string;
  batch: string;
  question_set_version: string;
  surfaces: 'api';
  not_probed: string[];
  engines: EngineResult[];
  aeo_status: AeoStatus;
  competitors: Competitor[];
  gbp_summary: GbpFacts | { checked: false } | null;
  site_summary: Omit<SiteFacts, 'pages_read'> | { checked: false } | null;
  directories: Directories;
  gap: string;
  hook: string;
  confirm: ConfirmFact[];
  catalog_gates: CatalogGate[];
  empty_slots: EmptySlot[];
  cautions: string[];
}

/** The columns the profile stage writes back so today's templates keep working. */
export interface SummaryColumns {
  aeo_status: AeoStatus;
  aeo_note: string | null;
  probe_json: Record<string, unknown>;
}

// ── The lead as the research modules see it ──────────────────────────────────

export interface ResearchLead {
  id: string;
  business_name: string | null;
  name_aliases: string[];
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  city: string | null;
  state: string | null;
  county: string | null;
  vertical: string | null;
  vertical_label: string | null;
  trade: string | null;
  place_id: string | null;
  why: string | null;
  source_type: string | null;
  source_url: string | null;
  stage: string;
  gbp_json: GbpFacts | null;
  site_json: SiteFacts | null;
  research_json: ResearchJson | null;
  research_version: number;
  researched_at: string | null;
}

// ── Scheduling ───────────────────────────────────────────────────────────────

export type Stage = 'classify' | 'probe' | 'gbp' | 'reviews' | 'site' | 'grade' | 'profile' | 'owner';

/**
 * The order "next in order" (and the cron) walks. Grade first, then spend
 * (Griffin, 22 Oct): the listing and the website are read first because they
 * are cheap (about a cent a lead, and free), Jev grades from them, and only
 * then does the answer-engine probe run, for the trade+town pairs that hold a
 * lead the grade put at or above PROBE_BAR (plan.ts). The probe was $85 of the
 * first $123 of research, spent before anything was graded. owner runs last:
 * it reads the listing and the site the earlier stages fetched.
 *
 * reviews is not in it. Reading every new lead's reviews is the whole-pond read
 * ruled out on 19 Oct; the Research room reads them from the top of the grade
 * down (research/assess.ts). The stage still runs when asked for by name.
 */
export const STAGE_ORDER: readonly Stage[] = ['classify', 'gbp', 'site', 'grade', 'probe', 'profile', 'owner'] as const;

/** Every stage the run endpoint accepts by name: the walk above, plus reviews. */
export const ALL_STAGES: readonly Stage[] = [...STAGE_ORDER, 'reviews'] as const;

export type StopReason = 'done' | 'deadline' | 'budget' | 'locked' | 'error';

export interface Pair {
  trade: string;
  city: string;
  state: string;
}
