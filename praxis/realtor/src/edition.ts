// Which product this deploy is.
//
// One codebase, two deploys, two databases. PRAXIS_EDITION is `gjc` on
// Griffin Jacobs Consulting's deploy (praxisgj.com) and `realtor` on a
// realtor's own deploy, which talks to its own Supabase project. What each
// edition may open is the route table in src/lib/edition-routes.ts, enforced
// once, in src/middleware.ts.
//
// Unset means `gjc`, because that is every deploy that existed before this
// file and none of them carry the variable. A value that is SET but is not an
// edition is a misconfigured deploy, and it is refused loudly (the middleware
// throws on every request, and the build throws in astro.config.mjs) rather
// than quietly served as GJC. A realtor deploy with a typo in this variable
// must never come up showing GJC's pages.
//
// No realtor's name is written in code. Everything a realtor deploy says about
// the person it belongs to comes from that deploy's own env (see brand()).

import { parseCountyList, type CountyKey } from './counties/registry.ts';

export const EDITIONS = ['gjc', 'realtor'] as const;
export type Edition = (typeof EDITIONS)[number];

export class EditionConfigError extends Error {
  constructor(raw: string) {
    super(
      `PRAXIS_EDITION is set to ${JSON.stringify(raw)}, which is not an edition. ` +
        `Use one of: ${EDITIONS.join(', ')} (unset means gjc). Refusing to serve rather than guess.`,
    );
    this.name = 'EditionConfigError';
  }
}

/** Pure: the edition a raw env value names. Unset or blank is gjc; anything else unknown throws. */
export function parseEdition(raw: string | undefined | null): Edition {
  if (raw === undefined || raw === null) return 'gjc';
  const v = raw.trim();
  if (v === '') return 'gjc';
  if ((EDITIONS as readonly string[]).includes(v)) return v as Edition;
  throw new EditionConfigError(raw);
}

function readEnv(name: string): string | undefined {
  // process.env first, import.meta.env second, for the reason getJwtSecret()
  // gives in auth.ts: Vite replaces import.meta.env.X at build time, so reading
  // it first would bake the build machine's value into the bundle. On Vercel
  // the runtime value is in process.env; under `astro dev` the .env file is
  // only in import.meta.env, so that is the fallback.
  const fromProcess = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  if (fromProcess !== undefined) return fromProcess;
  try {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    return env?.[name];
  } catch {
    return undefined;
  }
}

// ── Edition and database must agree ──────────────────────────────────────────
//
// Unset means gjc (above), and that is the one way a realtor deploy fails
// OPEN: delete PRAXIS_EDITION from her Vercel project and the next request
// serves GJC's pages (intake, One Less Thing, Jordan's doors) over her
// database. The pairing closes it. A deploy whose Supabase URL names a realtor
// database must be the realtor edition, and one that names GJC's database must
// be gjc. A mismatch throws, the same loud refusal as a misspelled edition.
//
// Project refs only, never a name, per the rule at the top of this file. A new
// realtor deploy adds its database's ref to REALTOR_DATABASE_REFS.

export const GJC_DATABASE_REF = 'gjc-project-ref';
export const REALTOR_DATABASE_REFS: readonly string[] = ['realtor-project-ref'];

export class EditionDatabaseMismatchError extends Error {
  constructor(ed: Edition, envName: string) {
    super(
      ed === 'gjc'
        ? `${envName} points at a realtor database but PRAXIS_EDITION is gjc (or unset). ` +
            `Set PRAXIS_EDITION=realtor on this deploy. Refusing to serve GJC's app over a realtor's data.`
        : `${envName} points at GJC's database but PRAXIS_EDITION is realtor. Refusing to serve a realtor's app over GJC's data.`,
    );
    this.name = 'EditionDatabaseMismatchError';
  }
}

/** Pure: throws when the edition and a Supabase URL name different products. No URL, nothing to check. */
export function checkEditionDatabase(ed: Edition, env: (name: string) => string | undefined): void {
  for (const name of ['PUBLIC_SUPABASE_URL', 'SUPABASE_URL']) {
    const url = (env(name) ?? '').toLowerCase();
    if (!url) continue;
    if (ed === 'gjc' && REALTOR_DATABASE_REFS.some((ref) => url.includes(ref))) throw new EditionDatabaseMismatchError(ed, name);
    if (ed === 'realtor' && url.includes(GJC_DATABASE_REF)) throw new EditionDatabaseMismatchError(ed, name);
  }
}

/** The edition this process is serving. Read on every call (cheap), so a test can flip it. */
export function edition(): Edition {
  const ed = parseEdition(readEnv('PRAXIS_EDITION'));
  checkEditionDatabase(ed, readEnv);
  return ed;
}

export function isRealtor(): boolean {
  return edition() === 'realtor';
}

// ── Brand text ───────────────────────────────────────────────────────────────
//
// The words the chrome uses about itself and its owner. The gjc values are the
// strings the app printed before editions existed, verbatim, so GJC's pages
// render byte for byte as they did. The realtor values come from the realtor
// deploy's env; the code carries only neutral fallbacks.
//
// Realtor env (all optional, set on her deploy, never in code):
//   PRAXIS_PRODUCT_NAME   what the rail and the tab titles call the app
//   REALTOR_NAME          the agent's name (email "from" name, sign-in page)
//   REALTOR_BROKERAGE     the brokerage line on the sign-in page
//   REALTOR_PHONE         the agent's phone
//   REALTOR_COUNTY        the county the agent works, as a name (the page heading)
//   REALTOR_COUNTIES      the counties the research desk reads, as registry keys,
//                         comma separated ("mesa,montrose,ouray"); see
//                         realtorCounties() below and src/lib/counties/registry.ts
//   PRAXIS_SUPPORT_NAME   who to ask for an account or a password reset

export interface Brand {
  /** The app's name: the rail wordmark, the sign-in page, the tab-title suffix. */
  productName: string;
  /** Sign-in page headline and the line under it. */
  loginHeadline: string;
  loginSubline: string;
  /** Sign-in page foot line (the business the tool belongs to). */
  loginFoot: string;
  /** Who a person asks for an account or a reset ("Ask Griffin if ..."). */
  supportName: string;
  /** The display name email is sent under. */
  emailFromName: string;
  /** The top bar's search box. */
  searchLabel: string;
  /** The sign-in form's email placeholder. */
  emailPlaceholder: string;
  /** The person this deploy belongs to, when the edition has one (realtor). */
  owner: { name: string; brokerage: string; phone: string; county: string } | null;
}

const GJC_BRAND: Brand = {
  productName: 'Praxis',
  loginHeadline: 'The pipeline, one client at a time.',
  loginSubline: 'Intake to signature: nine stages, one next step, every document where you left it.',
  loginFoot: 'GRIFFIN JACOBS CONSULTING',
  supportName: 'Griffin',
  emailFromName: 'Griffin Jacobs Consulting',
  searchLabel: 'Find a business',
  emailPlaceholder: 'you@griffinjacobs.com',
  owner: null,
};

/** Pure: the brand for an edition, given an env reader. */
export function brandFor(ed: Edition, env: (name: string) => string | undefined = readEnv): Brand {
  if (ed === 'gjc') return GJC_BRAND;
  const get = (n: string) => (env(n) ?? '').trim();
  const name = get('REALTOR_NAME');
  const brokerage = get('REALTOR_BROKERAGE');
  const productName = get('PRAXIS_PRODUCT_NAME') || (name ? `${name} CRM` : 'CRM');
  return {
    productName,
    loginHeadline: 'Your book, one person at a time.',
    loginSubline: 'Every contact, every call and every closing, with the next step where you left it.',
    loginFoot: [name, brokerage].filter(Boolean).join(' · ').toUpperCase(),
    supportName: get('PRAXIS_SUPPORT_NAME') || 'your administrator',
    emailFromName: name || productName,
    searchLabel: 'Find a contact',
    emailPlaceholder: 'you@example.com',
    owner: { name, brokerage, phone: get('REALTOR_PHONE'), county: get('REALTOR_COUNTY') },
  };
}

export function brand(): Brand {
  return brandFor(edition());
}

// ── Counties ─────────────────────────────────────────────────────────────────
//
// REALTOR_COUNTIES replaces REALTOR_COUNTY as what the research desk reads.
// Backward compatible: a deploy that has only REALTOR_COUNTY ("Mesa") reads as
// that one county, and a deploy with neither reads as Mesa, which is what every
// realtor deploy did before the list existed. Unknown words are handed back,
// never guessed at, so the refresh can say "REALTOR_COUNTIES names X, which is
// not a county this CRM knows" instead of quietly reading less.

export interface RealtorCounties {
  counties: CountyKey[];
  unknown: string[];
  /** Which variable the list came from, for the run record. */
  from: 'REALTOR_COUNTIES' | 'REALTOR_COUNTY' | 'default';
}

/** Pure: the counties an env configures. GJC reads none. */
export function countiesFor(ed: Edition, env: (name: string) => string | undefined = readEnv): RealtorCounties {
  if (ed === 'gjc') return { counties: [], unknown: [], from: 'default' };
  const list = (env('REALTOR_COUNTIES') ?? '').trim();
  if (list) {
    const p = parseCountyList(list);
    return { ...p, from: 'REALTOR_COUNTIES' };
  }
  const single = (env('REALTOR_COUNTY') ?? '').trim();
  if (single) {
    const p = parseCountyList(single);
    return { ...p, from: 'REALTOR_COUNTY' };
  }
  return { counties: ['mesa'], unknown: [], from: 'default' };
}

export function realtorCounties(): RealtorCounties {
  return countiesFor(edition());
}

/**
 * The first line of a GJC-only scheduled job. vercel.json is shared, so a
 * realtor deploy calls every GJC cron on its schedule; on any edition but gjc
 * the job answers `200 {skipped:'edition'}` and touches nothing. The middleware
 * already answers these paths the same way; this is the second lock, in the
 * handler itself, so the job stays inert even if it is ever reached some other way.
 */
export function gjcOnlyCronSkip(): Response | null {
  if (edition() === 'gjc') return null;
  return new Response(JSON.stringify({ ok: true, skipped: 'edition' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
