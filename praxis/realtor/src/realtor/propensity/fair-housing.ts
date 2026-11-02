// realtor/propensity/fair-housing — the hard line, in code.
//
// The Fair Housing Act (and Colorado's wider list) protects race, colour,
// religion, national origin, sex, familial status and disability; Colorado
// adds age among others. A likelihood score that leans on any of them, or on
// anything that stands in for them, steers who an agent calls. So:
//
//   1. No signal may be built from a protected trait or a proxy for one:
//      neighbourhood demographics, names read as ethnicity, school data, the
//      number of children, birth year, marital events, health. The signal
//      KINDS in types.ts are the whole vocabulary, and none of them is one.
//   2. No reader asks a provider for such a field. PDL is asked for the job
//      and location fields listed in PDL_FIELDS_USED and nothing else, so a
//      demographic field is never even received (pdl.ts).
//   3. A note sentence that mentions a protected trait is NOT turned into a
//      signal, even when it also states a plan ("moving because the baby is
//      coming"): the plan is left for her to read, not scored. The count of
//      sentences refused is reported, never their text.
//   4. The model's one-line reason is refused if it names one.
//
// Matching a contact to a public record by their name is identity matching,
// not a signal: the name is never scored and never read for what it might
// say about the person.
//
// test/realtor-propensity.test.mjs greps every file in this folder that reads
// a source (the SOURCE_MODULES below) for FORBIDDEN_FIELD_WORDS and fails if
// one appears outside this file.

/** Words that mark a sentence as touching a protected trait or a proxy. Whole words, case-insensitive. */
export const PROTECTED_TERMS: readonly string[] = [
  // familial status
  'baby', 'babies', 'pregnant', 'pregnancy', 'expecting', 'newborn', 'kids', 'kid', 'children', 'child', 'son', 'daughter',
  'twins', 'toddler', 'teen', 'teenager', 'nursery', 'empty nest', 'empty nester', 'empty nesters', 'family size',
  'married', 'marriage', 'wedding', 'engaged', 'fiance', 'fiancee', 'divorce', 'divorced', 'divorcing', 'separated',
  'widow', 'widowed', 'widower', 'custody',
  // marital status and family members (Colorado protects marital status; a
  // plan told in terms of a spouse, a parent or a child is left for her to read)
  'husband', 'wife', 'spouse', 'boyfriend', 'girlfriend', 'mom', 'dad', 'mother', 'father', 'parents',
  'aunt', 'uncle', 'grandma', 'grandpa', 'grandmother', 'grandfather', 'grandkids', 'grandchildren', 'sil', 'mil',
  'in-laws', 'in-law',
  // age
  'retire', 'retired', 'retiring', 'retirement', 'elderly', 'senior', 'seniors', 'aging', 'age', 'aged', 'old age',
  'birthday', 'years old', 'nursing home', 'assisted living', 'downsize', 'downsizing', 'upsize', 'upsizing',
  // disability and health
  'disabled', 'disability', 'wheelchair', 'handicap', 'handicapped', 'accessible', 'ada', 'illness', 'ill', 'sick',
  'cancer', 'dementia', 'alzheimer', 'alzheimers', 'stroke', 'surgery', 'hospital', 'hospice', 'health', 'medical',
  'passed away', 'died', 'death', 'deceased', 'funeral', 'estate sale',
  // religion
  'church', 'mosque', 'synagogue', 'temple', 'religion', 'religious', 'christian', 'catholic', 'jewish', 'muslim',
  'mormon', 'lds', 'bishop', 'pastor', 'mission',
  // race, colour, national origin
  'race', 'racial', 'ethnic', 'ethnicity', 'hispanic', 'latino', 'latina', 'black', 'white', 'asian', 'native',
  'immigrant', 'immigration', 'visa', 'citizenship', 'deported', 'accent', 'spanish speaking',
  // sex
  'gender', 'sex', 'pregnancy',
  // proxies
  'school', 'schools', 'school district', 'neighborhood demographics', 'demographics', 'census',
];

const PROTECTED_RE = new RegExp(
  `\\b(${[...new Set(PROTECTED_TERMS)].sort((a, b) => b.length - a.length).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')).join('|')})\\b`,
  'i',
);

/** The line every model prompt in this folder carries (web.ts, wording.ts). */
export const PROMPT_PROHIBITION =
  'Never mention or guess family, children, marriage, age, health, religion, race or national origin.';

/** The protected term a text names, or null. */
export function protectedTermIn(text: string | null | undefined): string | null {
  const m = PROTECTED_RE.exec(text ?? '');
  return m ? m[1].toLowerCase() : null;
}

/**
 * Field and column words no source reader may ask for or store. The test
 * greps the reader modules for these as identifiers. (This file is exempt:
 * it is where the list lives.)
 */
export const FORBIDDEN_FIELD_WORDS: readonly string[] = [
  'birth_year', 'birth_date', 'birthday', 'sex', 'gender', 'race', 'ethnicity', 'religion', 'marital',
  'children', 'num_children', 'education', 'school', 'schools', 'disability', 'age', 'demographic', 'census',
  'median_income', 'household_size', 'nationality', 'language', 'languages', 'interests',
];

/** The modules in this folder that read a source or a contact's rows. Their text is grepped by the test. */
export const SOURCE_MODULES: readonly string[] = ['crm-signals.ts', 'deed-signals.ts', 'sos-signals.ts', 'pdl.ts', 'web.ts'];

/**
 * The only PDL person fields this CRM requests (data_include) or keeps.
 * Job and location, each with the date PDL puts on its change.
 */
export const PDL_FIELDS_USED: readonly string[] = [
  'job_title',
  'job_company_name',
  'job_start_date',
  'job_last_changed',
  'location_locality',
  'location_region',
  'location_last_updated',
];
