// The realtor edition's contact vocabularies, in one place.
//
// Pure: no Supabase, no fetch. Loaded straight off disk by
// test/realtor-roles.test.mjs, which also reads the migrations in
// supabase/migrations-realtor/ and fails if a list here and the SQL that
// enforces it ever disagree. Adding a role is therefore two edits in one PR:
// a line in ROLES below and a row in the contact_roles seed (or a later
// migration that inserts it). The test is what keeps the two honest.
//
// WHY ROLES ARE A LIST AND NOT A STAGE. A person is a buyer AND a past client
// AND a referral source at once, and the people who matter most to a realtor's
// business (the 23 Sep recording: developers, builders, investors, flippers,
// architects, project managers) are never "in a stage" at all -- they are a
// relationship. So `leads.roles` is text[], more than one allowed, and the
// stage is a separate question about where a deal is.

export type ContactRole =
  | 'buyer'
  | 'seller'
  | 'past_client'
  | 'sphere'
  | 'referral_source'
  | 'developer'
  | 'builder'
  | 'investor'
  | 'flipper'
  | 'architect'
  | 'project_manager'
  | 'lender'
  | 'title'
  | 'surveyor'
  // Session 23 (migration 18): the trade around a sale, so a fellow realtor,
  // an inspector or a plumber is never read as a client.
  | 'agent'
  | 'inspector'
  | 'appraiser'
  | 'contractor'
  | 'vendor'
  | 'property_manager'
  | 'attorney'
  | 'photographer'
  | 'tc';

export interface RoleDef {
  key: ContactRole;
  label: string;
  /** People she sells to, or people who send her deals and build the inventory. */
  side: 'client' | 'network';
}

/** In the order a picker shows them: the people she sells for, then the trade. */
export const ROLES: readonly RoleDef[] = [
  { key: 'buyer', label: 'Buyer', side: 'client' },
  { key: 'seller', label: 'Seller', side: 'client' },
  { key: 'past_client', label: 'Past client', side: 'client' },
  { key: 'sphere', label: 'Sphere', side: 'client' },
  { key: 'referral_source', label: 'Referral source', side: 'network' },
  { key: 'developer', label: 'Developer', side: 'network' },
  { key: 'builder', label: 'Builder', side: 'network' },
  { key: 'investor', label: 'Investor', side: 'network' },
  { key: 'flipper', label: 'Flipper', side: 'network' },
  { key: 'architect', label: 'Architect', side: 'network' },
  { key: 'project_manager', label: 'Project manager', side: 'network' },
  { key: 'lender', label: 'Lender', side: 'network' },
  { key: 'title', label: 'Title', side: 'network' },
  { key: 'surveyor', label: 'Surveyor', side: 'network' },
  { key: 'agent', label: 'Agent', side: 'network' },
  { key: 'inspector', label: 'Inspector', side: 'network' },
  { key: 'appraiser', label: 'Appraiser', side: 'network' },
  { key: 'contractor', label: 'Contractor', side: 'network' },
  { key: 'vendor', label: 'Vendor', side: 'network' },
  { key: 'property_manager', label: 'Property manager', side: 'network' },
  { key: 'attorney', label: 'Attorney', side: 'network' },
  { key: 'photographer', label: 'Photographer', side: 'network' },
  { key: 'tc', label: 'Transaction coordinator', side: 'network' },
];

export const ROLE_KEYS: readonly ContactRole[] = ROLES.map((r) => r.key);

export const ROLE_LABELS: Record<ContactRole, string> = Object.fromEntries(
  ROLES.map((r) => [r.key, r.label]),
) as Record<ContactRole, string>;

const ROLE_SET = new Set<string>(ROLE_KEYS);

export function isRole(v: unknown): v is ContactRole {
  return typeof v === 'string' && ROLE_SET.has(v);
}

/**
 * Clean a submitted role list: known keys only, each once, in ROLES order so
 * two people who ticked the same boxes store the same array. Unknown values
 * are returned separately rather than dropped in silence, so an endpoint can
 * refuse them out loud (the database trigger would refuse them anyway).
 */
export function normalizeRoles(input: unknown): { roles: ContactRole[]; unknown: string[] } {
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? input.split(',') : [];
  const seen = new Set<string>();
  const unknown: string[] = [];
  for (const item of raw) {
    const v = typeof item === 'string' ? item.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
    if (!v) continue;
    if (ROLE_SET.has(v)) seen.add(v);
    else unknown.push(String(item).trim());
  }
  return { roles: ROLE_KEYS.filter((k) => seen.has(k)), unknown };
}

/** "Buyer, Investor" for a list cell. Unknown keys print as themselves. */
export function rolesLabel(roles: readonly string[] | null | undefined): string {
  return (roles ?? []).map((r) => ROLE_LABELS[r as ContactRole] ?? r).join(', ');
}

// ── The other contact vocabularies ──────────────────────────────────────────
// Each mirrors a CHECK constraint in supabase/migrations-realtor/.

/**
 * person    — one human being.
 * household — one card standing for several people ("Bob & Sue Smith") the
 *             way an imported book often has them. Split into person rows
 *             joined by household_id when she knows both; until then the
 *             household card is the honest record of what the book said.
 * entity    — an LLC, trust, builder, bank. Never gets a home anniversary.
 */
export type ContactKind = 'person' | 'household' | 'entity';
export const CONTACT_KINDS: readonly ContactKind[] = ['person', 'household', 'entity'];
export const KIND_LABELS: Record<ContactKind, string> = {
  person: 'Person',
  household: 'Household',
  entity: 'Company or trust',
};

/** Where the relationship began. Distinct from leads.source_type, which is
 *  machine provenance (which sync or import wrote the row). */
export type ContactSource = 'website' | 'open_house' | 'referral' | 'sign_call' | 'brokerage_lead' | 'import';
export const CONTACT_SOURCES: readonly ContactSource[] = [
  'website',
  'open_house',
  'referral',
  'sign_call',
  'brokerage_lead',
  'import',
];
export const SOURCE_LABELS: Record<ContactSource, string> = {
  website: 'Website',
  open_house: 'Open house',
  referral: 'Referral',
  sign_call: 'Sign call',
  brokerage_lead: 'Brokerage lead',
  import: 'Import',
};

/** How a contact stands to a property. */
export type PropertyRelation = 'owns' | 'bought' | 'sold' | 'renting' | 'interested';
export const PROPERTY_RELATIONS: readonly PropertyRelation[] = ['owns', 'bought', 'sold', 'renting', 'interested'];

/** Which side of a transaction she (or the record) was on. */
export type TransactionSide = 'buy' | 'sell' | 'both';
export const TRANSACTION_SIDES: readonly TransactionSide[] = ['buy', 'sell', 'both'];
