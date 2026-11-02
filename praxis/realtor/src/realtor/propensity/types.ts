// realtor/propensity/types — the shapes of a buy-or-sell likelihood signal.
//
// Pure declarations. A SIGNAL is one dated public or CRM fact about one
// contact that bears on whether they are likely to buy or sell soon, with the
// name of where it came from. A SCORE (rubric.ts) is computed by code from a
// contact's signals; nothing here is guessed and nothing is a model's opinion.
//
// Every date is an ISO calendar day ('YYYY-MM-DD'). A signal with no date is
// not a signal: the writers refuse it (and the CHECK in
// supabase/migrations-realtor/2026_09_24_15_propensity.sql refuses it again).

/**
 * Where a signal came from. propensity_signals.source; the migration's CHECK
 * lists the same words and test/realtor-propensity.test.mjs holds the two
 * together.
 *
 *   deed      a recorded sale from a county sales feed (Mesa's assessor sales
 *             service), with its reception number
 *   parcel    a county parcel layer's owner and last-sale fields
 *   eagleweb  a county EagleWeb sale search row (Montrose, Ouray), no names
 *   sos       a Colorado Secretary of State record (data.colorado.gov)
 *   web       a public page read through Firecrawl, allowed sites only
 *   pdl       People Data Labs person enrichment, business contacts only
 *   crm       her own CRM: transactions, stage, source, touches, notes
 */
export type SignalSource = 'deed' | 'parcel' | 'eagleweb' | 'sos' | 'web' | 'pdl' | 'crm';
export const SIGNAL_SOURCES: readonly SignalSource[] = ['deed', 'parcel', 'eagleweb', 'sos', 'web', 'pdl', 'crm'];

/**
 * What a signal says. propensity_signals.kind. The family (property,
 * business, career, crm) is what the rubric's "one of them property or
 * business" rule reads.
 */
export type SignalKind =
  // property (deed, parcel, eagleweb, or her own closing on file)
  | 'mover_band'        // owned their home 5 to 9 years: the band people move in
  | 'home_sold'         // the home they bought has since sold: a past client with no home, a buyer
  | 'second_property'   // bought another property after their home
  | 'lot_bought'        // bought vacant land: a build is coming
  | 'recent_purchase'   // bought their home in the last 2 years (counts DOWN)
  | 'long_tenure'       // owned 10 years or more: known, not in the band
  // business (Colorado SOS, or a business's own public page)
  | 'entity_formed'     // a new company with them as registered agent
  | 'entity_dissolved'  // a company of theirs dissolved
  | 'trade_name_new_address' // a trade name registered at an address that is not their home on file
  | 'business_opened'
  | 'business_moved'
  | 'business_closed'
  // career and location (PDL, or a company page or press)
  | 'job_change'
  | 'employer_change'
  | 'location_change'
  | 'relocation_public'
  | 'fsbo_own_page'     // a "for sale by owner" or "coming soon" note on their OWN page
  // her CRM
  | 'stated_intent'     // her dated note says they plan to buy, sell or move
  | 'active_file'       // on file as active or under contract right now
  | 'repeat_client'     // two or more closings with her
  | 'referral_source'   // came to her by referral
  | 'recent_contact';   // she has talked to them in the last 12 months

export const SIGNAL_KINDS: readonly SignalKind[] = [
  'mover_band', 'home_sold', 'second_property', 'lot_bought', 'recent_purchase', 'long_tenure',
  'entity_formed', 'entity_dissolved', 'trade_name_new_address', 'business_opened', 'business_moved', 'business_closed',
  'job_change', 'employer_change', 'location_change', 'relocation_public', 'fsbo_own_page',
  'stated_intent', 'active_file', 'repeat_client', 'referral_source', 'recent_contact',
];

export type SignalFamily = 'property' | 'business' | 'career' | 'crm';

export const SIGNAL_FAMILY: Record<SignalKind, SignalFamily> = {
  mover_band: 'property',
  home_sold: 'property',
  second_property: 'property',
  lot_bought: 'property',
  recent_purchase: 'property',
  long_tenure: 'property',
  entity_formed: 'business',
  entity_dissolved: 'business',
  trade_name_new_address: 'business',
  business_opened: 'business',
  business_moved: 'business',
  business_closed: 'business',
  job_change: 'career',
  employer_change: 'career',
  location_change: 'career',
  relocation_public: 'career',
  fsbo_own_page: 'property',
  stated_intent: 'crm',
  active_file: 'crm',
  repeat_client: 'crm',
  referral_source: 'crm',
  recent_contact: 'crm',
};

/** Short labels, for the card and the People column's hover. */
export const SIGNAL_LABELS: Record<SignalKind, string> = {
  mover_band: 'In the 5 to 9 year mover band',
  home_sold: 'Home sold since',
  second_property: 'Bought another property',
  lot_bought: 'Bought a lot',
  recent_purchase: 'Bought in the last 2 years',
  long_tenure: 'Owned 10 years or more',
  entity_formed: 'New company formed',
  entity_dissolved: 'Company dissolved',
  trade_name_new_address: 'Trade name at a new address',
  business_opened: 'Business opened',
  business_moved: 'Business moved',
  business_closed: 'Business closed',
  job_change: 'New job title',
  employer_change: 'New employer',
  location_change: 'Moved, per PDL',
  relocation_public: 'Relocation, public page',
  fsbo_own_page: 'Sale note on their own page',
  stated_intent: 'Told you their plans',
  active_file: 'Active file',
  repeat_client: 'Repeat client',
  referral_source: 'Came by referral',
  recent_contact: 'Talked this year',
};

/** One signal, as the pure modules pass it around (and as the table stores it). */
export interface Signal {
  kind: SignalKind;
  source: SignalSource;
  /** YYYY-MM-DD: when the fact happened (or, for a state like mover_band, the day it became true). */
  date: string;
  /**
   * The row it stands on: a deed reception number, an SOS entity id, a PDL
   * record field path, a CRM table.row id. With `url`, at least one is set.
   */
  ref: string | null;
  /** A public page it stands on, when there is one. */
  url: string | null;
  /** One line, written by CODE from the fact (never a copied private note). */
  detail: string;
  /** The fields read, and only those (PDL: the three job and location fields). */
  payload?: Record<string, unknown>;
}

/** A signal as stored, with its row id. */
export interface StoredSignal extends Signal {
  id: string;
  lead_id: string;
  weight: number;
  found_at: string;
}
