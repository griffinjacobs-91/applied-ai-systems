// counties/registry — what the CRM knows about each county it can serve.
//
// Env chooses the counties (REALTOR_COUNTIES in edition.ts); code knows them.
// No realtor is named here: a county entry is public fact about a government,
// so the same registry serves any realtor deploy that lists the county.
//
// Every entry has every slot. A slot the county cannot fill says so in words
// (not_available, manual with its link, or a null the page reads as "not
// written yet"); it is never left out, so a page or a refresh can always ask
// "what does this county have for X" and get an answer instead of undefined.
// test/targets-counties.test.mjs holds that.
//
// Sources for every fact below: the Session 17 pre-work report,
// ~/Deliverables/2026-09-24-<the four-counties pre-work>/00-report.md, and its raw
// answers in evidence/ (23 Sep 2026). Town ZIPs were confirmed from Colorado
// SOS rows (principalstate 'CO', entities formed since 23 Sep 2024) on 23 Sep
// 2026, not from memory.
//
// Three counties ship. Delta County was ruled out by Griffin on 23 Sep 2026
// ("scratch Delta actually"), so it has no entry: adding it later is one more
// entry here plus its readers, and the CountyKey list widens with it.

import type { ProjectStage } from '../projects/stages.ts';

export const COUNTY_KEYS = ['mesa', 'montrose', 'ouray'] as const;
export type CountyKey = (typeof COUNTY_KEYS)[number];

export function isCountyKey(v: unknown): v is CountyKey {
  return typeof v === 'string' && (COUNTY_KEYS as readonly string[]).includes(v);
}

/**
 * The kinds of public record the research desk reads. The refresh asks each
 * configured county for every slot; a slot with no reader is reported as
 * "not available in <county>", never as zero rows.
 *   sales_named       sales with buyer and seller as data
 *   eagleweb_sales    the assessor's EagleWeb sale search (dated, priced, no names)
 *   parcels           the county parcel layer (owner, mailing address)
 *   plats             recorded subdivision plats
 *   permits           building permits naming the applicant
 *   applications      planning applications as data
 *   sos_new_entities  Colorado SOS entities formed in the county's towns
 */
export const READER_SLOTS = ['sales_named', 'eagleweb_sales', 'parcels', 'plats', 'permits', 'applications', 'sos_new_entities'] as const;
export type ReaderSlot = (typeof READER_SLOTS)[number];

export type ReaderAvailability =
  | { status: 'feed'; reader: string; note: string }
  | { status: 'manual'; url: string; note: string }
  | { status: 'not_available'; note: string };

export interface ManualLink {
  key: string;
  label: string;
  url: string;
  why: string;
}

/** How one deed-type spelling reads: the canonical deed, and whether it is an arm's-length sale. */
export interface DeedType {
  canonical: string;
  armsLength: 'yes' | 'no' | 'unknown';
}

export interface EagleWebSite {
  /** Bare host, no scheme. */
  host: string;
  /** App root: the login is `${appPath}/web`, content `${appPath}/taxweb` (a sibling, not a child). */
  appPath: string;
  /** saleSearch accountTypeID values, per county: they differ (Montrose residential is 02, Ouray's is 10). */
  classes: { vacant: string; residential: string };
  /** The county's own sale search, for the manual link. */
  searchUrl: string;
}

/**
 * One plain sentence or two per slot, the same facts the county's cheat
 * sheets are drafted from (src/lib/resources/county-sheets.ts), so a project
 * board's stage note can read them. Null means not written yet, never "none".
 * No dollar figure appears here: a fee is pointed at, with who publishes it.
 * Session 17B filled these from the pre-work report of 23 Sep 2026.
 */
export interface CountyFacts {
  fees: string | null;
  utilities: string | null;
  licensing: string | null;
  codes: string | null;
}

export interface CountyEntry {
  key: CountyKey;
  name: string;
  seat: string;
  /** Every county here is in Colorado. Readers and reasons are gated on it (see inCounty). */
  state: 'CO';
  /** Principal-office ZIP prefixes of the county's towns: the SOS new-entity feed keeps only these. */
  zipPrefixes: readonly string[];
  /** Principal cities the SOS new-entity feed asks for (principalstate = 'CO' is always added). */
  towns: readonly string[];
  readers: Readonly<Record<ReaderSlot, ReaderAvailability>>;
  eagleweb: EagleWebSite | null;
  /** Deed-type spellings to one canonical deed. An unknown spelling reads 'unknown', never a guess. */
  deedTypes: Readonly<Record<string, DeedType>>;
  /** Class codes the readers filter on, with what they mean. */
  classCodes: Readonly<Record<string, string>>;
  /** The county's own name for each shared project rung; null where the county names no such step. */
  rungNames: Readonly<Record<ProjectStage, string | null>>;
  facts: CountyFacts;
  manual: readonly ManualLink[];
}

const LONG_FORMS: Record<string, DeedType> = {
  'WARRANTY DEED': { canonical: 'WD', armsLength: 'yes' },
  'WARRANTY DEED (JT)': { canonical: 'WDJT', armsLength: 'yes' },
  'WARRANTY DEED JOINT TENANTS': { canonical: 'WDJT', armsLength: 'yes' },
  'SPECIAL WARRANTY DEED': { canonical: 'SWD', armsLength: 'yes' },
  'SPECIAL WARRANTY DEED (JT)': { canonical: 'SWD', armsLength: 'yes' },
  'SPECIAL WARRANTY DEED JOINT TENANTS': { canonical: 'SWD', armsLength: 'yes' },
  'GENERAL WARRANTY DEED': { canonical: 'GWD', armsLength: 'yes' },
  'PERSONAL REPRESENTATIVES DEED': { canonical: 'PRD', armsLength: 'unknown' },
  "PERSONAL REPRESENTATIVE'S DEED": { canonical: 'PRD', armsLength: 'unknown' },
  'PERSONAL REPRESENTATIVES DEED (JT)': { canonical: 'PRDJ', armsLength: 'unknown' },
  'QUIT CLAIM DEED': { canonical: 'QCD', armsLength: 'no' },
  'QUITCLAIM DEED': { canonical: 'QCD', armsLength: 'no' },
  'QUIT CLAIM DEED (JT)': { canonical: 'QCDJ', armsLength: 'no' },
  'WARRANTY DEED TO TRUST': { canonical: 'WDT', armsLength: 'unknown' },
};

/**
 * Montrose's account pages switched to codes about 5 Aug 2026 while its sale
 * search still writes the long form (pre-work finding F). Both spellings are
 * one deed, both ways; Ouray writes long forms today and may switch too, so it
 * carries the same table.
 */
const EAGLEWEB_DEEDS: Record<string, DeedType> = {
  ...LONG_FORMS,
  WD: { canonical: 'WD', armsLength: 'yes' },
  WDJT: { canonical: 'WDJT', armsLength: 'yes' },
  GWD: { canonical: 'GWD', armsLength: 'yes' },
  SWD: { canonical: 'SWD', armsLength: 'yes' },
  PRD: { canonical: 'PRD', armsLength: 'unknown' },
  PRDJ: { canonical: 'PRDJ', armsLength: 'unknown' },
  QCD: { canonical: 'QCD', armsLength: 'no' },
  QCDJ: { canonical: 'QCDJ', armsLength: 'no' },
  WDT: { canonical: 'WDT', armsLength: 'unknown' },
};


export const COUNTIES: Readonly<Record<CountyKey, CountyEntry>> = {
  mesa: {
    key: 'mesa',
    name: 'Mesa County',
    seat: 'Grand Junction',
    state: 'CO',
    // Grand Junction, Clifton, Fruita, Gateway, Glade Park, Loma, Mack, Palisade, Whitewater are 815xx; Collbran 81624, De Beque 81630, Mesa 81643.
    zipPrefixes: ['815', '81624', '81630', '81643'],
    towns: ['Grand Junction', 'Fruita', 'Palisade', 'Clifton', 'Loma', 'Mack', 'Whitewater', 'Mesa', 'Collbran', 'De Beque', 'Gateway', 'Glade Park'],
    readers: {
      sales_named: { status: 'feed', reader: 'sources/sales.ts', note: 'Assessor sales JSON, buyer and seller, improved parcels only.' },
      eagleweb_sales: { status: 'not_available', note: 'Mesa does not run EagleWeb; its own sales feed names both parties.' },
      parcels: { status: 'feed', reader: 'sources/parcels.ts', note: 'GIS Tax Parcels layer 55, vacant parcels with their last sale.' },
      plats: { status: 'feed', reader: 'sources/plats.ts', note: 'GIS layer 63, dated, joined to the owners inside.' },
      permits: { status: 'manual', url: 'https://h9.maintstar.co/MesaCounty/Portal/#/', note: 'MaintStar needs a login, one address at a time, no export.' },
      applications: { status: 'manual', url: 'https://www.mesacounty.us/departments-and-services/community-development/planning', note: 'No reader built; the county planning layer runs months behind.' },
      sos_new_entities: { status: 'feed', reader: 'sources/sos.ts', note: 'Colorado only (principalstate CO), Mesa County towns.' },
    },
    eagleweb: null,
    // Mesa's sales feed carries a qualification code (field 10), not a deed type.
    deedTypes: {},
    classCodes: { 'IMPVALCUR = 0': 'vacant (no improvement value) on layer 55' },
    rungNames: {
      raw_land: null,
      due_diligence: null,
      concept: 'Pre-Application Meeting (optional) and Concept Plan (optional)',
      entitlements: 'Outline Development Plan and Rezoning',
      subdivision_plan: 'Final Plan (county); Major Preliminary (City of Grand Junction)',
      improvements: 'Development Improvements Agreement',
      final_plat: 'Final Plat',
      lots: null,
      build: null,
      sale: null,
    },
    facts: {
      codes: 'Mesa County Building Department: 2024 IRC and IBC, 2021 IECC, 2023 NEC; it permits and inspects for the county and for the City of Grand Junction.',
      licensing: 'A contractor licence is required only inside Grand Junction city limits, and the Mesa County Building Department runs it for the city. Electricians and plumbers are licensed by the state (DORA).',
      utilities: 'Water: Ute Water (taps by meter size), or a city system. Irrigation: Grand Valley Irrigation Company, Grand Valley Water Users and other providers. Power: Grand Valley Power, Xcel Energy. Septic: Mesa County (OWTS). Wells: Colorado Division of Water Resources.',
      fees: 'Published with dates: Grand Junction impact fees (gjcity.org/1527, the 1 Jul 2026 step) and Ute Water tap fees (Exhibit II, adopted June 2026). The Resources fee estimator reads those two schedules.',
    },
    manual: [
      { key: 'county_permits', label: 'Mesa County building permits', url: 'https://h9.maintstar.co/MesaCounty/Portal/#/', why: 'Login required, one address at a time, no export. Inside Grand Junction the city case layer carries residential planning clearances instead.' },
      { key: 'city_agendas', label: 'Grand Junction planning commission agendas', url: 'https://www.gjcity.org/AgendaCenter', why: 'Agenda Center pages and PDF minutes only; its RSS returned an empty channel.' },
      { key: 'county_agendas', label: 'Mesa County planning commission agendas', url: 'https://www.mesacounty.us/departments-and-services/community-development/planning', why: 'Pages on the county site; the cases themselves are in the county planning layer.' },
    ],
  },

  montrose: {
    key: 'montrose',
    name: 'Montrose County',
    seat: 'Montrose',
    state: 'CO',
    // Montrose 81401-81404, Bedrock 81411, Cimarron 81220, Naturita 81422, Nucla 81424, Olathe 81425, Paradox 81429, Redvale 81431.
    zipPrefixes: ['8140', '81411', '81220', '81422', '81424', '81425', '81429', '81431'],
    towns: ['Montrose', 'Olathe', 'Naturita', 'Nucla', 'Redvale', 'Paradox', 'Bedrock', 'Cimarron'],
    readers: {
      sales_named: { status: 'not_available', note: 'No sale with buyer and seller is published as data; only the Tyler recorder search shows both parties.' },
      eagleweb_sales: { status: 'feed', reader: 'sources/eagleweb.ts', note: 'Vacant-land sales (class 01): date, reception, deed type, assessor-adjusted price. No names; the buyer is the current owner on layer 47.' },
      parcels: { status: 'feed', reader: 'sources/montrose-parcels.ts', note: 'Parcel Line layer 47: owner and mailing address by account. No sale, no value.' },
      plats: { status: 'feed', reader: 'sources/montrose-plats.ts', note: 'Subdivisions layer 22 has no record date: a new plat is dated the day the refresh first saw it.' },
      permits: { status: 'feed', reader: 'sources/montrose-city-permits.ts', note: 'City of Montrose monthly permit PDF, applicant named. County permits are SmartGov, login only.' },
      applications: { status: 'manual', url: 'https://co-montrose-co.smartgovcommunity.com/', note: 'SmartGov needs a login; Planning Commission agendas are PDFs.' },
      sos_new_entities: { status: 'feed', reader: 'sources/sos.ts', note: 'Colorado only, Montrose County towns and ZIPs.' },
    },
    eagleweb: {
      host: 'eagleweb.montrosecounty.net',
      appPath: '/eagleassessor',
      classes: { vacant: '01', residential: '02' },
      searchUrl: 'https://eagleweb.montrosecounty.net/eagleassessor/web/',
    },
    deedTypes: EAGLEWEB_DEEDS,
    classCodes: {
      '01': 'EagleWeb sale class: VACANT LAND',
      '02': 'EagleWeb sale class: RESIDENTIAL',
      VLRES: 'layer 47 accttype: vacant residential',
      VLRAW: 'layer 47 accttype: vacant raw land',
      VLCOM: 'layer 47 accttype: vacant commercial',
      VAC: 'layer 47 accttype: vacant',
    },
    rungNames: {
      raw_land: null,
      due_diligence: null,
      // The 2024 Subdivision Regulations have no pre-application or concept step.
      concept: null,
      entitlements: null,
      subdivision_plan: 'Preliminary Plan (4 or more lots; a Minor Subdivision of up to 3 lots is one review)',
      improvements: 'Subdivision Improvements Agreement (SIA)',
      final_plat: 'Final Plat',
      lots: null,
      build: null,
      sale: null,
    },
    facts: {
      codes: 'Montrose County Building Division: 2018 IRC and 2018 IECC. City of Montrose: 2018 IBC, 2018 IRC and 2023 NEC (Municipal Code 4-1-1). Electrical and plumbing permits are the state\'s.',
      licensing: 'The City of Montrose licenses plumbing contractors through Building Services (Municipal Code 4-1-4(B)). No county contractor licence was found; confirm with the county. Electricians and plumbers are licensed by the state (DORA).',
      utilities: 'Water: City of Montrose, Menoken Water, Tri-County Water Conservancy District, all treated by Project 7 Water Authority. Irrigation: Uncompahgre Valley Water Users Association. Power: DMEA, and San Miguel Power in the west end. Gas: Black Hills Energy. Septic: Montrose County Planning and Development (OWTS). Wells: Colorado Division of Water Resources.',
      fees: 'No county impact fee schedule was found. The City of Montrose puts water and sewer tap and capacity fees in its Municipal Code (3-5-12(D) and (G)); call the city. The county planning fee schedule is a recorded resolution. Not in the Resources estimator.',
    },
    manual: [
      { key: 'eagleweb_sales', label: 'Montrose County assessor sale search (EagleWeb)', url: 'https://eagleweb.montrosecounty.net/eagleassessor/web/', why: 'Guest entry; every sale by class. No buyer or seller names.' },
      { key: 'recorder', label: 'Montrose County recorded documents', url: 'https://montrosecountyco-web.tylerhost.net/web/', why: 'The only place grantor and grantee both appear.' },
      { key: 'county_permits', label: 'Montrose County permits (SmartGov)', url: 'https://co-montrose-co.smartgovcommunity.com/', why: 'Login required; the issued-permits Excel opens only in a JavaScript report viewer.' },
      { key: 'county_agendas', label: 'Montrose County Planning Commission', url: 'https://www.montrosecounty.net/176/County-Planning-Commission', why: 'Agendas are PDFs; the RSS is empty.' },
      { key: 'city_planning', label: 'City of Montrose Community Development', url: 'https://www.cityofmontrose.org/321/Community-Development', why: 'Applications go by email; no case feed.' },
    ],
  },

  ouray: {
    key: 'ouray',
    name: 'Ouray County',
    seat: 'Ouray',
    state: 'CO',
    // Ouray 81427, Ridgway 81432 (Log Hill Mesa mails through Ridgway).
    zipPrefixes: ['81427', '81432'],
    towns: ['Ouray', 'Ridgway'],
    readers: {
      sales_named: { status: 'not_available', note: 'No sale with buyer and seller is published as data; only the Tyler recorder search shows the seller.' },
      eagleweb_sales: { status: 'feed', reader: 'sources/eagleweb.ts', note: 'Vacant-land sales (class 01), dated and priced, no names; used to confirm a parcel-layer sale was land.' },
      parcels: { status: 'feed', reader: 'sources/ouray-parcels.ts', note: 'OC_Parcel_Public: owner and last sale. About six months behind; every row carries the layer date as stale_as_of.' },
      plats: { status: 'not_available', note: 'No plat or subdivision layer among the county’s 80 ArcGIS services.' },
      permits: { status: 'feed', reader: 'sources/ouray-permits.ts', note: 'County year-to-date permit PDF, applicant named; the columns shift month to month, so each month’s header is checked.' },
      applications: { status: 'manual', url: 'https://ouraycountyco.gov/215/Land-Use-Application-Under-Review', note: 'One web page listing the cases under review.' },
      sos_new_entities: { status: 'feed', reader: 'sources/sos.ts', note: 'Colorado only, Ouray and Ridgway.' },
    },
    eagleweb: {
      host: 'ouraycountyco-assessor.tylerhost.net',
      appPath: '/assessor',
      classes: { vacant: '01', residential: '10' },
      searchUrl: 'https://ouraycountyco-assessor.tylerhost.net/assessor/web/',
    },
    deedTypes: EAGLEWEB_DEEDS,
    classCodes: {
      '01': 'EagleWeb sale class: VACANT LAND',
      '10': 'EagleWeb sale class: RESIDENTIAL',
      ACCTTYPE: 'parcel layer ACCTTYPE is numeric and mixed (code 1000 holds vacant lots and houses): never a vacant flag',
    },
    rungNames: {
      raw_land: null,
      due_diligence: null,
      concept: 'Pre-Application Meeting (required), then Sketch Plan',
      entitlements: 'Planned Unit Development (Limited, Regular or Resort)',
      subdivision_plan: 'Preliminary and Final Development Plans (PDP, FDP; may be combined)',
      improvements: null,
      final_plat: 'Final Plat',
      lots: null,
      build: null,
      sale: null,
    },
    facts: {
      codes: 'Three building departments, each on the 2018 International Codes: Ouray County, the Town of Ridgway (as amended in RMC 6-1) and the City of Ouray. Electrical and plumbing permits and inspections are the state\'s. The county requires engineer-performed foundation inspections (Resolution 2021-049).',
      licensing: 'No county contractor licence was found; confirm with the Land Use office. Ridgway and the City of Ouray each have their own building official. Electricians and plumbers are licensed by the state (DORA).',
      utilities: 'Water: Tri-County Water (north county), Dallas Creek Water, Town of Ridgway water, City of Ouray water. Power: San Miguel Power Association. Gas: Black Hills Energy. Septic: Ouray County Land Use (permits through CloudPermit). Wells: Colorado Division of Water Resources.',
      fees: 'No county impact or tap fee schedule was found. The county publishes a 2018 building fee schedule for estimating only; Ridgway puts tap fees in its Municipal Code (9-1-9). Call the provider. Not in the Resources estimator.',
    },
    manual: [
      { key: 'eagleweb_sales', label: 'Ouray County assessor sale search (EagleWeb)', url: 'https://ouraycountyco-assessor.tylerhost.net/assessor/web/', why: 'Guest entry; every sale by class. No buyer or seller names.' },
      { key: 'recorder', label: 'Ouray County recorded documents', url: 'https://ouraycountyco-web.tylerhost.net/web/search/DOCSEARCH422S1', why: 'Deeds and plats since 1995; the seller lives here.' },
      { key: 'applications', label: 'Ouray County land use applications under review', url: 'https://ouraycountyco.gov/215/Land-Use-Application-Under-Review', why: 'One page, current cases and their stage.' },
      { key: 'town_permits', label: 'Town of Ridgway building department', url: 'https://townofridgway.colorado.gov/i-want-to/building-department', why: 'Ridgway and the City of Ouray issue their own permits; no list is published.' },
    ],
  },
};

export function county(key: CountyKey): CountyEntry {
  return COUNTIES[key];
}

/** "Montrose" from "montrose"; the page's chip text. */
export function countyShortName(key: CountyKey): string {
  return COUNTIES[key].name.replace(/\s+County$/, '');
}

/**
 * Keys from an env value. Accepts keys or names in any case ("mesa",
 * "Mesa", "Mesa County"), comma or space separated. Unknown words are
 * returned separately so the caller can say so; they are never guessed at.
 */
export function parseCountyList(raw: string | null | undefined): { counties: CountyKey[]; unknown: string[] } {
  const counties: CountyKey[] = [];
  const unknown: string[] = [];
  for (const part of String(raw ?? '').split(',')) {
    const word = part.trim().toLowerCase().replace(/\s+county$/, '').trim();
    if (!word) continue;
    if (isCountyKey(word)) {
      if (!counties.includes(word)) counties.push(word);
    } else unknown.push(part.trim());
  }
  return { counties, unknown };
}

/**
 * Is an address in the county: Colorado, and a ZIP that starts with one of the
 * county's prefixes. A missing ZIP is not in the county: the gate is proof, not
 * the absence of disproof.
 */
export function inCounty(key: CountyKey, place: { state?: string | null; zip?: string | null }): boolean {
  const c = COUNTIES[key];
  if ((place.state ?? '').trim().toUpperCase() !== c.state) return false;
  const zip = (place.zip ?? '').trim();
  if (!/^\d{5}/.test(zip)) return false;
  return c.zipPrefixes.some((p) => zip.startsWith(p));
}

/** The county an address falls in, or null. */
export function countyOfPlace(place: { state?: string | null; zip?: string | null }): CountyKey | null {
  return COUNTY_KEYS.find((k) => inCounty(k, place)) ?? null;
}

/** One deed-type spelling read against the county's table. Unknown is 'unknown', never a guess. */
export function deedTypeFor(key: CountyKey, raw: string | null | undefined): DeedType & { raw: string } {
  const r = String(raw ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
  const hit = COUNTIES[key].deedTypes[r];
  return hit ? { ...hit, raw: r } : { canonical: r || 'UNKNOWN', armsLength: 'unknown', raw: r };
}
