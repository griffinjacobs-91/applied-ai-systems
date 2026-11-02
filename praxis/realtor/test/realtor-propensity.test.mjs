// Likelihood to buy or sell, 1 to 5 (Session 21): the rubric's bands, the
// two-signal rule for a 5, the not-enough-data dash, the fair-housing line
// enforced by grepping the source readers, the wording filter, the free
// signals and the weekly recompute, and the likely_mover Today reason.
//
// Run: node --experimental-strip-types --test test/realtor-propensity.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(ROOT + p, 'utf8');

const { scorePropensity, effectiveWeight, hasIndependentRecentPair, WEIGHTS, SOFT_KINDS, RUBRIC_LINES, scoreText, RUBRIC_VERSION } = await import('../src/realtor/propensity/rubric.ts');
const { SIGNAL_KINDS, SIGNAL_SOURCES, SIGNAL_FAMILY, SIGNAL_LABELS } = await import('../src/realtor/propensity/types.ts');
const { protectedTermIn, FORBIDDEN_FIELD_WORDS, SOURCE_MODULES, PDL_FIELDS_USED } = await import('../src/realtor/propensity/fair-housing.ts');
const { crmSignals, notePlans, intentOf, dateInText } = await import('../src/realtor/propensity/crm-signals.ts');
const { deedSignals, indexSales, addressKey, partyNameKeys, contactNameKey } = await import('../src/realtor/propensity/deed-signals.ts');
const { sosSignals } = await import('../src/realtor/propensity/sos-signals.ts');
const { pdlEligible, pdlQuery, pdlKept, pdlSignals, isBusinessEmail } = await import('../src/realtor/propensity/pdl.ts');
const { checkWebEvents, isAllowedUrl, mayScrape } = await import('../src/realtor/propensity/web.ts');
const { reasonEvidence, validateReason } = await import('../src/realtor/propensity/wording.ts');
const { recomputeContact, mergeSignals, reband, isThrowaway, isScorable } = await import('../src/realtor/propensity/recompute.ts');
const { shouldRecompute, isPropensityDay, wordingEnabled } = await import('../src/realtor/propensity/sweep.ts');
const { cardView, researchLine } = await import('../src/realtor/propensity/card.ts');
const { reasonsFor, todayRows, REASON_ORDER, REASON_LABELS, reasonCounts } = await import('../src/realtor/today.ts');
const { reasonSentence, reasonTrace } = await import('../src/realtor/brief.ts');

const TODAY = '2026-09-23';
const sig = (kind, date, extra = {}) => ({ kind, source: extra.source ?? 'crm', date, ref: extra.ref ?? `${kind}:${date}`, url: null, detail: `${kind} on ${date}`, ...extra });

// ── The rubric ───────────────────────────────────────────────────────────────

test('every band is reachable, and the points decide it', () => {
  assert.equal(scorePropensity([sig('recent_purchase', '2025-06-01')], TODAY).score, 1);
  assert.equal(scorePropensity([sig('long_tenure', '2016-01-01')], TODAY).score, 2);
  assert.equal(scorePropensity([sig('active_file', TODAY)], TODAY).score, 3);
  assert.equal(scorePropensity([sig('mover_band', '2023-05-01'), sig('repeat_client', '2024-01-01')], TODAY).score, 3); // 3.5
  assert.equal(scorePropensity([sig('stated_intent', '2026-03-01')], TODAY).score, 4);
  const five = scorePropensity([sig('home_sold', '2026-02-01', { source: 'deed', ref: 'mesa rec. 1' }), sig('stated_intent', '2026-05-01')], TODAY);
  assert.equal(five.score, 5);
  assert.equal(five.points, 7);
});

test('1 is a past client who bought in the last two years and nothing else', () => {
  const r = scorePropensity([sig('recent_purchase', '2025-01-10'), sig('recent_contact', '2026-08-01')], TODAY);
  assert.equal(r.score, 1);
  assert.ok(r.points <= 0);
});

test('a 5 needs two independent dated signals in 12 months, one property or business; otherwise it is held at 4', () => {
  // Six points, all CRM: no property or business signal in the pair.
  const crmOnly = scorePropensity([sig('stated_intent', '2026-04-01'), sig('active_file', TODAY)], TODAY);
  assert.equal(crmOnly.points, 7);
  assert.equal(crmOnly.score, 4);
  assert.match(crmOnly.heldAtFour, /Held at 4/);
  // Six points, but the property signal is old (2 years): not recent.
  const stale = scorePropensity([sig('home_sold', '2024-06-01', { source: 'deed', ref: 'r1' }), sig('stated_intent', '2026-04-01'), sig('active_file', TODAY)], TODAY);
  assert.ok(stale.points >= 6);
  assert.equal(stale.score, 4);
  // The same fact twice is one fact, not two.
  const twice = [sig('lot_bought', '2026-01-01', { source: 'deed', ref: 'mesa rec. 9' }), sig('lot_bought', '2026-01-01', { source: 'deed', ref: 'mesa rec. 9' })];
  assert.equal(hasIndependentRecentPair(twice, TODAY), false);
  // A home sale and 'repeat client' read off the same closing row are one fact (24 Sep: her one 5 stood on this).
  const oneClosing = scorePropensity([
    sig('home_sold', '2026-03-31', { source: 'crm', ref: 'transactions:t-1' }),
    sig('repeat_client', '2026-03-31', { source: 'crm', ref: 'transactions:t-1,t-0' }),
    sig('entity_formed', '2025-05-20', { source: 'sos', ref: 'sos entity 1' }),
  ], TODAY);
  assert.equal(oneClosing.points, 6);
  assert.equal(oneClosing.score, 4);
  assert.match(oneClosing.heldAtFour, /Held at 4/);
  // Two different closings are two rows.
  assert.equal(hasIndependentRecentPair([
    sig('home_sold', '2026-03-31', { source: 'crm', ref: 'transactions:t-1' }),
    sig('repeat_client', '2026-03-31', { source: 'crm', ref: 'transactions:t-2,t-0' }),
  ], TODAY), true);
  // Property plus business, both this year: a 5.
  const pair = scorePropensity([sig('lot_bought', '2026-01-01', { source: 'deed', ref: 'mesa rec. 9' }), sig('entity_formed', '2026-02-01', { source: 'sos', ref: 'sos 1' }), sig('employer_change', '2026-03-01', { source: 'pdl', ref: 'pdl' })], TODAY);
  assert.equal(pair.points, 6);
  assert.equal(pair.score, 5);
});

test('not enough data is a dash, never a 1', () => {
  assert.equal(scorePropensity([], TODAY).score, null);
  assert.equal(scorePropensity([sig('referral_source', '2020-01-01'), sig('recent_contact', '2026-09-01')], TODAY).score, null);
  assert.equal(scoreText(null), '—');
  assert.equal(scoreText(1), '1');
  for (const k of SOFT_KINDS) assert.ok(WEIGHTS[k] > 0 && WEIGHTS[k] < 1, k);
});

test('signals age: half after 24 months, gone after 36; ownership states and a repeat client do not age', () => {
  assert.equal(effectiveWeight(sig('entity_formed', '2026-01-01'), TODAY), 1.5);
  assert.equal(effectiveWeight(sig('entity_formed', '2024-08-01'), TODAY), 0.75);
  assert.equal(effectiveWeight(sig('entity_formed', '2023-08-01'), TODAY), 0);
  assert.equal(effectiveWeight(sig('mover_band', '2012-01-01'), TODAY), 2);
  assert.equal(effectiveWeight(sig('repeat_client', '2015-01-01'), TODAY), 1.5);
  assert.equal(effectiveWeight(sig('stated_intent', '2027-01-01'), TODAY), 0, 'a date in the future counts for nothing');
});

test('top three are the heaviest, newest first on a tie', () => {
  const r = scorePropensity([sig('recent_contact', '2026-09-01'), sig('stated_intent', '2026-05-01'), sig('mover_band', '2025-01-01'), sig('repeat_client', '2025-06-01'), sig('lot_bought', '2026-06-01', { source: 'deed' })], TODAY);
  assert.deepEqual(r.top.map((x) => x.signal.kind), ['stated_intent', 'lot_bought', 'mover_band']);
});

test('the published rubric is five lines and says the dash is never a 1', () => {
  assert.equal(RUBRIC_LINES.length, 5);
  assert.ok(RUBRIC_LINES.some((l) => /never shown as a 1/.test(l)));
});

// ── The vocabulary and the migration agree ───────────────────────────────────

test('the migration lists exactly the kinds and sources in types.ts', () => {
  const sql = read('sql/propensity.sql');
  const kindBlock = /propensity_signals_kind_check\s+CHECK \(kind IN \(([\s\S]*?)\)\);/.exec(sql)[1];
  const kinds = [...kindBlock.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...kinds].sort(), [...SIGNAL_KINDS].sort());
  const srcBlock = /propensity_signals_source_check\s+CHECK \(source IN \(([^)]*)\)\)/.exec(sql)[1];
  assert.deepEqual([...srcBlock.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort(), [...SIGNAL_SOURCES].sort());
  assert.match(sql, /migrations-realtor refused/, 'the realtor-only guard is in the file');
  assert.match(sql, /'likely_mover'/, 'contact_briefs accepts the new Today reason');
  for (const k of SIGNAL_KINDS) {
    assert.ok(k in WEIGHTS && k in SIGNAL_FAMILY && k in SIGNAL_LABELS, k);
  }
});

// ── Fair housing ─────────────────────────────────────────────────────────────

test('no signal kind names a protected trait or a proxy', () => {
  for (const k of SIGNAL_KINDS) {
    assert.equal(protectedTermIn(k.replace(/_/g, ' ')), null, k);
    assert.equal(protectedTermIn(SIGNAL_LABELS[k]), null, SIGNAL_LABELS[k]);
  }
});

test('the source readers never ask for or keep a demographic field (grep)', () => {
  for (const f of SOURCE_MODULES) {
    const text = read(`src/realtor/propensity/${f}`);
    for (const w of FORBIDDEN_FIELD_WORDS) {
      const re = new RegExp(`\\b${w}\\b`, 'i');
      assert.equal(re.test(text), false, `${f} mentions "${w}"`);
    }
  }
  // PDL is asked for the job and location fields, and nothing else.
  for (const f of PDL_FIELDS_USED) assert.match(f, /^(job_|location_)/);
  const q = new URL(pdlQuery({ id: 'x', first_name: 'Ann', last_name: 'Lee', email: 'ann@acme-dental.com', company: 'Acme Dental', title: null, city: null }));
  assert.deepEqual(q.searchParams.get('data_include').split(','), [...PDL_FIELDS_USED]);
  assert.equal(q.searchParams.get('api_key'), null, 'the key is never in the URL');
});

test('a plan sentence that names a protected trait is not scored, and its words go nowhere', () => {
  const r = notePlans('03/02/2026 - Want to sell in spring because the baby is coming.\n03/02/2026 - Thinking about selling next spring.', null);
  assert.equal(r.refusedProtected, 1);
  assert.equal(r.plans.length, 1);
  assert.deepEqual(r.plans[0], { intent: 'sell', date: '2026-03-02', dateFrom: 'written' });
  for (const t of ['retiring next year, want to move', 'divorce, will sell', 'wants a bigger place for the kids, looking to buy', 'near the church, want to buy']) {
    assert.ok(protectedTermIn(t), t);
  }
});

// ── Free signals from her CRM ────────────────────────────────────────────────

test('plans need a verb of buying, selling or moving AND a word that points ahead, and a date', () => {
  assert.equal(intentOf('Sold their house in 2020.'), null);
  assert.equal(intentOf('Want to sell in the spring'), 'sell');
  assert.equal(intentOf('Planning to relocate to Denver'), 'move');
  assert.equal(intentOf('Looking for land to build on'), 'buy');
  assert.equal(dateInText('Called Aug 27, 2026 about it'), '2026-08-27');
  assert.equal(dateInText('04/14/2022 - funded'), '2022-04-14');
  const undated = notePlans('Thinking about selling next spring.', null);
  assert.equal(undated.plans.length, 0);
  assert.equal(undated.undated, 1);
});

test('crm signals: active file, repeat client, referral, recent contact, a dated plan from a touch', () => {
  const r = crmSignals({
    contact: { id: 'L1', stage: 'active', source: 'referral', created_at: '2021-02-01T00:00:00Z', last_touch_at: '2026-07-01T16:00:00Z', notes: null },
    touches: [
      { id: 'T1', channel: 'call', status: 'logged', subject: null, body: 'Talked. Want to list the house next spring.', created_at: '2026-06-10T17:00:00Z' },
      { id: 'T2', channel: 'email', status: 'drafted', subject: 'x', body: 'We will sell soon', created_at: '2026-06-11T17:00:00Z' },
    ],
    deals: [
      { id: 'D1', ours: true, close_date: '2019-05-01', fell_through_date: null },
      { id: 'D2', ours: true, close_date: '2023-05-01', fell_through_date: null },
    ],
    today: TODAY,
  });
  const kinds = r.signals.map((s) => s.kind).sort();
  assert.deepEqual(kinds, ['active_file', 'recent_contact', 'referral_source', 'repeat_client', 'stated_intent']);
  const plan = r.signals.find((s) => s.kind === 'stated_intent');
  assert.equal(plan.date, '2026-06-10');
  assert.equal(plan.ref, 'lead_touches:T1');
  assert.doesNotMatch(plan.detail, /next spring/, 'her words are not copied into the signal');
  for (const s of r.signals) assert.ok(s.ref || s.url, s.kind);
});

// ── Deeds ────────────────────────────────────────────────────────────────────

const PROPS = new Map([
  ['P1', { id: 'P1', address_line1: '2461 Elm Avenue', city: 'Grand Junction', county: 'Mesa', parcel_id: '2945-011-00-001' }],
  ['P2', { id: 'P2', address_line1: '88 Puma Lane', city: 'Ridgway', county: 'Ouray', parcel_id: null }],
]);
const ME = { id: 'L1', household_id: null, first_name: 'Russell', last_name: 'Crawford' };

test('names and addresses key the way the county writes them', () => {
  assert.equal(addressKey('2461 Elm Avenue, Grand Junction'), '2461 ELM AVE');
  assert.equal(addressKey('2461 ELM AVE #4'), '2461 ELM AVE');
  assert.deepEqual(partyNameKeys('CRAWFORD RUSSELL W & CRAWFORD ANN'), ['CRAWFORD|RUSSELL', 'CRAWFORD|ANN']);
  assert.equal(contactNameKey(ME), 'CRAWFORD|RUSSELL');
});

test('her closing 7 years ago, not sold: the mover band, dated the day year 5 began', () => {
  const s = deedSignals({ contact: ME, txs: [{ id: 'T1', property_id: 'P1', lead_id: 'L1', household_id: null, ours: true, side: 'buy', close_date: '2019-05-03', fell_through_date: null }], properties: PROPS, links: [], sales: indexSales([]), today: TODAY });
  assert.equal(s.length, 1);
  assert.equal(s[0].kind, 'mover_band');
  assert.equal(s[0].date, '2024-05-03');
  assert.equal(s[0].payload.bought_on, '2019-05-03');
});

test('the county sold the home since: home_sold from the deed, no band', () => {
  const sales = indexSales([{ source: 'deed', county: 'mesa', parcel: '294501100001', reception: '3167007', date: '2026-08-05', address: '2461 ELM AVE', buyer: 'MCALLISTER STEVEN J', seller: 'CRAWFORD RUSSELL W', vacant: false }]);
  const s = deedSignals({ contact: ME, txs: [{ id: 'T1', property_id: 'P1', lead_id: 'L1', household_id: null, ours: true, side: 'buy', close_date: '2019-05-03', fell_through_date: null }], properties: PROPS, links: [], sales, today: TODAY });
  assert.deepEqual(s.map((x) => x.kind), ['home_sold']);
  assert.equal(s[0].ref, 'mesa rec. 3167007');
});

test('by name: land in the last 36 months is lot_bought; another house after the home is second_property', () => {
  const sales = indexSales([
    { source: 'parcel', county: 'mesa', parcel: '270100000999', reception: null, date: '2025-10-01', address: '0 BOOKCLIFF RD', buyer: 'CRAWFORD RUSSELL', seller: 'X', vacant: true },
    { source: 'deed', county: 'mesa', parcel: '270100000888', reception: '3100000', date: '2024-02-01', address: '10 MAIN ST', buyer: 'CRAWFORD RUSSELL W', seller: 'Y', vacant: false },
    { source: 'deed', county: 'mesa', parcel: '270100000777', reception: '3000000', date: '2012-02-01', address: '11 MAIN ST', buyer: 'CRAWFORD RUSSELL W', seller: 'Z', vacant: false },
  ]);
  const s = deedSignals({ contact: ME, txs: [{ id: 'T1', property_id: 'P1', lead_id: 'L1', household_id: null, ours: true, side: 'buy', close_date: '2019-05-03', fell_through_date: null }], properties: PROPS, links: [], sales, today: TODAY });
  const kinds = s.map((x) => x.kind).sort();
  assert.deepEqual(kinds, ['lot_bought', 'mover_band', 'second_property']);
  assert.ok(s.filter((x) => x.kind !== 'mover_band').every((x) => /matched by name/.test(x.detail)));
});

test('no closing and no owned address: the county is not asked to guess a home from a name', () => {
  const sales = indexSales([{ source: 'deed', county: 'mesa', parcel: '1', reception: '2', date: '2019-01-01', address: '5 A ST', buyer: 'CRAWFORD RUSSELL', seller: 'Q', vacant: false }]);
  const s = deedSignals({ contact: ME, txs: [], properties: PROPS, links: [], sales, today: TODAY });
  assert.deepEqual(s, []);
});

// ── SOS, PDL, web ────────────────────────────────────────────────────────────

test('SOS: a company formed with them as agent, a dissolution, a trade name at a new address, in her towns only', () => {
  const towns = new Set(['GRAND JUNCTION', 'FRUITA']);
  const s = sosSignals({
    contact: { first_name: 'Russell', last_name: 'Crawford' },
    addresses: ['2461 Elm Ave'],
    entities: [
      { entityid: 'E1', entityname: 'Crawford Dental LLC', entityformdate: '2026-02-01T00:00:00.000', principalcity: 'Grand Junction', principalstate: 'CO', agentfirstname: 'Russell', agentlastname: 'Crawford' },
      { entityid: 'E2', entityname: 'Old Co LLC', entityformdate: '2015-02-01T00:00:00.000', principalcity: 'Fruita', principalstate: 'CO', agentfirstname: 'Russell', agentlastname: 'Crawford' },
      { entityid: 'E3', entityname: 'Denver Crawford LLC', entityformdate: '2026-02-01T00:00:00.000', principalcity: 'Denver', principalstate: 'CO', agentfirstname: 'Russell', agentlastname: 'Crawford' },
    ],
    history: [
      { entityid: 'E2', historydes: 'Dissolve a Limited Liability Company', effectivedate: '2026-04-01T00:00:00.000' },
      { entityid: 'E1', historydes: 'Statement of Trade Name Renewal of a Dissolved or Delinquent Reporting Entity', effectivedate: '2026-04-01T00:00:00.000' },
    ],
    tradeNames: [
      { mastertradenameid: 'T1', tradenamedescription: 'Crawford Smiles', firstname: 'Russell', lastname: 'Crawford', address1: '100 Main St', city: 'Grand Junction', state: 'CO', effectivedate: '2026-03-01T00:00:00.000' },
      { mastertradenameid: 'T2', tradenamedescription: 'Home Biz', firstname: 'Russell', lastname: 'Crawford', address1: '2461 Elm Avenue', city: 'Grand Junction', state: 'CO', effectivedate: '2026-03-01T00:00:00.000' },
    ],
    towns,
    today: TODAY,
  });
  assert.deepEqual(s.map((x) => x.kind).sort(), ['entity_dissolved', 'entity_formed', 'trade_name_new_address']);
  assert.ok(s.every((x) => x.url && x.url.startsWith('https://data.colorado.gov/')));
});

test('PDL: only business contacts are sent; only job and location, dated by PDL, become signals', () => {
  assert.equal(isBusinessEmail('ann@gmail.com'), false);
  assert.equal(isBusinessEmail('ann@acme-dental.com'), true);
  assert.equal(pdlEligible({ id: 'x', first_name: 'Ann', last_name: 'Lee', email: 'ann@gmail.com', company: null, title: null, city: null }), false);
  assert.equal(pdlEligible({ id: 'x', first_name: 'Ann', last_name: 'Lee', email: 'ann@gmail.com', company: 'Acme', title: null, city: null }), true);
  const kept = pdlKept({ data: { job_title: 'Owner', job_company_name: 'Lee Dental', job_start_date: '2026-01', location_locality: 'Denver', location_region: 'colorado', location_last_updated: '2026-05-01', birth_year: 1970, sex: 'female' } });
  assert.equal('birth_year' in kept, false);
  assert.equal('sex' in kept, false);
  const s = pdlSignals({ contact: { id: 'x', first_name: 'Ann', last_name: 'Lee', email: null, company: 'Acme Dental', title: null, city: 'Grand Junction' }, kept, likelihood: 8, towns: new Set(['GRAND JUNCTION']), today: TODAY });
  assert.deepEqual(s.map((x) => [x.kind, x.date]), [['employer_change', '2026-01-01'], ['location_change', '2026-05-01']]);
  for (const x of s) assert.deepEqual(Object.keys(x.payload).every((k) => PDL_FIELDS_USED.includes(k)), true);
});

test('web: portals refused, the quote must be on the page, the date on the page, fsbo only on their own site', () => {
  assert.equal(isAllowedUrl('https://www.zillow.com/homedetails/x'), false);
  assert.equal(isAllowedUrl('https://acme.com/idx/search'), false);
  assert.equal(isAllowedUrl('https://www.gjsentinel.com/news/x'), true);
  assert.equal(mayScrape('https://www.facebook.com/acme'), false);
  const pages = [
    { url: 'https://www.gjsentinel.com/a', title: 'Acme Dental opens second office', text: 'Acme Dental opened its new office on Main Street in March 2026, owner Ann Lee said.' },
    { url: 'https://annlee.com/', title: 'Ann Lee', text: 'Our home at 5 A St is coming soon, for sale by owner, as of June 2026.' },
    { url: 'https://news.example.com/b', title: 'x', text: 'Ann Lee house for sale by owner June 2026' },
    { url: 'https://www.zillow.com/c', title: 'x', text: 'Ann Lee moved March 2026' },
  ];
  const out = checkWebEvents({
    claims: [
      { kind: 'business_opened', url: pages[0].url, quote: 'opened its new office on Main Street in March 2026' },
      { kind: 'business_moved', url: pages[0].url, quote: 'Acme moved to Denver in April 2026' },
      { kind: 'fsbo_own_page', url: pages[1].url, quote: 'coming soon, for sale by owner, as of June 2026' },
      { kind: 'fsbo_own_page', url: pages[2].url, quote: 'Ann Lee house for sale by owner June 2026' },
      { kind: 'relocation_public', url: pages[3].url, quote: 'Ann Lee moved March 2026' },
      { kind: 'job_change', url: pages[0].url, quote: 'owner Ann Lee said' },
    ],
    pages,
    ownDomains: ['annlee.com'],
    today: TODAY,
  });
  assert.deepEqual(out.signals.map((s) => s.kind), ['business_opened', 'fsbo_own_page']);
  assert.deepEqual(out.refused.map((r) => r.why), ['quote not on page', 'sale note not on their own site', 'site not allowed', 'no date on page in the last 36 months']);
});

// ── The wording filter ───────────────────────────────────────────────────────

const EV = reasonEvidence('Russell', [
  { kind: 'mover_band', date: '2024-05-03', detail: 'Bought 2461 Elm Avenue on 3 May 2019 (your closing); 7 years owned, in the 5 to 9 year band.' },
  { kind: 'stated_intent', date: '2026-06-10', detail: 'Your note logged 10 Jun 2026 records a plan to sell.' },
]);

test('the wording filter keeps a line made of the signals', () => {
  const v = validateReason('{"reason": "Russell has owned on Elm Avenue for 7 years and told you in June he plans to sell."}', EV.evidenceText);
  assert.equal(v.ok, true);
});

test('the wording filter refuses invented numbers, money, promises, protected traits, dashes and length', () => {
  const bad = [
    ['{"reason": "Russell has owned for 8 years and plans to sell."}', /Numbers not in the signals: 8/],
    ['{"reason": "Russell has owned for eight years."}', /eight/],
    ['{"reason": "His home is worth more now, so he may sell."}', /money/],
    ['{"reason": "Russell will sell this year."}', /promises/],
    ['{"reason": "Russell is retiring and plans to sell."}', /protected trait \(retiring\)/],
    ['{"reason": "Russell plans to sell - call him."}', /dash/],
    ['{"reason": "Russell plans to sell. Call him soon."}', /one only/],
    ['not json', /JSON/],
  ];
  for (const [raw, re] of bad) {
    const v = validateReason(raw, EV.evidenceText);
    assert.equal(v.ok, false, raw);
    assert.match(v.error, re, raw);
  }
  const declined = validateReason('{"error": "nothing to say"}', EV.evidenceText);
  assert.equal(declined.ok, false);
  assert.equal(declined.declined, true);
});

test('the evidence the model sees holds the top signals only, never the score', () => {
  const o = JSON.parse(EV.evidenceText);
  assert.deepEqual(Object.keys(o), ['contact_first_name', 'signals']);
  assert.equal(o.signals.length, 2);
});

// ── Recompute (the weekly sweep and the profile button) ──────────────────────

test('a stored deed band re-bands itself as the years pass; a home sale drops the bands', () => {
  const band = { kind: 'mover_band', source: 'deed', date: '2022-01-10', ref: 'mesa rec. 1', url: null, detail: 'Bought 5 A St on 10 Jan 2017 (deed, mesa rec. 1); 9 years owned, in the 5 to 9 year band.', payload: { bought_on: '2017-01-10' } };
  assert.equal(reband(band, TODAY).kind, 'mover_band');
  const later = reband(band, '2027-01-10');
  assert.equal(later.kind, 'long_tenure');
  assert.equal(later.date, '2027-01-10');
  const sold = { kind: 'home_sold', source: 'crm', date: '2026-02-01', ref: 'transactions:T9', url: null, detail: 'sold' };
  assert.deepEqual(mergeSignals([sold], [band], TODAY).map((s) => s.kind), ['home_sold']);
});

test('recomputeContact: free signals plus stored research, one band, one score', () => {
  const rows = {
    crm: { id: 'L1', stage: 'past_client', source: 'referral', created_at: '2019-01-01T00:00:00Z', last_touch_at: null, notes: '06/01/2026 - Said they want to sell next spring.' },
    deed: ME,
    touches: [],
    txs: [{ id: 'T1', property_id: 'P1', lead_id: 'L1', household_id: null, ours: true, side: 'buy', close_date: '2019-05-03', fell_through_date: null }],
    properties: PROPS,
    links: [],
  };
  const stored = [
    { kind: 'entity_formed', source: 'sos', date: '2026-02-01', ref: 'sos entity E1', url: 'https://data.colorado.gov/resource/4ykn-tg5h.json?entityid=E1', detail: 'x' },
    { kind: 'stated_intent', source: 'crm', date: '2020-01-01', ref: 'stale', url: null, detail: 'old crm row is replaced, never carried' },
  ];
  const r = recomputeContact(rows, stored, TODAY);
  assert.deepEqual(r.signals.map((s) => s.kind).sort(), ['entity_formed', 'mover_band', 'referral_source', 'stated_intent']);
  assert.equal(r.signals.filter((s) => s.kind === 'stated_intent').length, 1);
  assert.equal(r.score.points, 8);
  assert.equal(r.score.score, 5, 'plan (June 2026) and a company (Feb 2026), one of them business');
});

test('the sweep recomputes weekly on Monday, or when a score is from an older rubric, and never words', () => {
  assert.equal(isPropensityDay('2026-09-21'), true); // a Monday
  assert.equal(isPropensityDay(TODAY), false);
  assert.deepEqual(shouldRecompute('2026-09-21', [RUBRIC_VERSION]), { run: true, why: 'weekly' });
  assert.equal(shouldRecompute(TODAY, [RUBRIC_VERSION]).run, false);
  assert.equal(shouldRecompute(TODAY, [RUBRIC_VERSION - 1]).run, true, 'a score from the previous rubric is recomputed on the next sweep');
  assert.equal(shouldRecompute(TODAY, []).run, true);
  assert.equal(shouldRecompute(TODAY, [0]).run, true);
  assert.equal(wordingEnabled(undefined), false);
  assert.equal(wordingEnabled('on'), true);
});

test('throwaway rows and companies are never scored', () => {
  assert.equal(isThrowaway('ZZ Test Person'), true);
  assert.equal(isThrowaway('Jane delete me'), true);
  assert.equal(isThrowaway('Zane Grey'), false);
  assert.equal(isScorable({ kind: 'entity', name: 'Acme LLC' }), false);
  assert.equal(isScorable({ kind: 'household', name: 'The Lees' }), true);
});

test('the card says which research has not run', () => {
  assert.match(researchLine(['crm']), /has not run/);
  assert.match(researchLine(['crm', 'deed', 'sos']), /Not run: Public web, People Data Labs/);
  const v = cardView(null, [], TODAY);
  assert.equal(v.score, '—');
  assert.equal(v.scored, false);
});

// ── Today: likely_mover ──────────────────────────────────────────────────────

const base = { id: 'L1', name: 'Russell Crawford', first_name: 'Russell', kind: 'person', stage: 'past_client', source: null, birthday: null, last_touch_at: null, next_follow_up_at: null, follow_up_note: null, created_at: '2020-01-01T00:00:00Z' };
const ctx = { today: TODAY, now: new Date('2026-09-23T15:00:00Z') };
const LK = (score) => ({ score, top: [{ label: 'Told you their plans', date: '2026-06-10' }], reason: null });

test('likely_mover: a 4 or 5 with no touch in 60 days and nothing planned', () => {
  const r4 = reasonsFor({ ...base, likelihood: LK(4) }, [], [], ctx);
  assert.deepEqual(r4.map((r) => r.kind), ['likely_mover']);
  assert.equal(reasonsFor({ ...base, likelihood: LK(3) }, [], [], ctx).length, 0);
  assert.equal(reasonsFor({ ...base, likelihood: LK(null) }, [], [], ctx).length, 0, 'a dash is not a mover');
  assert.equal(reasonsFor({ ...base, likelihood: LK(5), last_touch_at: '2026-08-20T16:00:00Z' }, [], [], ctx).length, 0, 'talked 34 days ago');
  assert.equal(reasonsFor({ ...base, likelihood: LK(5), last_touch_at: '2026-07-20T16:00:00Z' }, [], [], ctx)[0].kind, 'likely_mover');
  assert.equal(reasonsFor({ ...base, likelihood: LK(5), next_follow_up_at: '2026-10-01' }, [], [], ctx).length, 0, 'a plan silences it');
  assert.equal(reasonsFor({ ...base, stage: 'dnc', likelihood: LK(5) }, [], [], ctx).length, 0);
});

test('likely_mover is last in the order, labelled, counted, sentenced and traced', () => {
  assert.equal(REASON_ORDER[REASON_ORDER.length - 1], 'likely_mover');
  assert.equal(REASON_LABELS.likely_mover, 'Likely to buy or sell');
  const rows = todayRows([{ contact: { ...base, likelihood: LK(5) }, touches: [], closings: [] }], ctx);
  assert.equal(reasonCounts(rows).likely_mover, 1);
  const line = reasonSentence(rows[0].reason, () => '');
  assert.match(line, /^Likelihood 5 of 5 to buy or sell: told you their plans \(10 Jun 2026\)\. No contact logged\.$/);
  assert.ok(reasonTrace(rows[0].reason, 'L1').some((t) => t.from.startsWith('propensity_scores.score')));
});

// ── Sizing (Griffin, 23 Sep: size the book before any research runs) ───────

const { sizeBook, COST } = await import('../src/realtor/propensity/sizing.ts');

test('sizing counts each tier from her rows and prices it from the published rates', () => {
  const rowsFor = (id, over = {}) => ({
    crm: { id, stage: 'past_client', source: null, created_at: '2020-01-01T00:00:00Z', last_touch_at: null, notes: null, ...(over.crm ?? {}) },
    deed: { id, household_id: null, first_name: 'A', last_name: 'B' },
    touches: [],
    txs: over.txs ?? [],
    properties: PROPS,
    links: over.links ?? [],
  });
  const tx = (id, date) => [{ id: `T${id}`, property_id: 'P1', lead_id: id, household_id: null, ours: true, side: 'buy', close_date: date, fell_through_date: null }];
  const s = sizeBook([
    { rows: rowsFor('a', { txs: tx('a', '2019-05-01') }), kind: 'person', email: 'a@gmail.com', emails: [], company: null, scorable: true },
    { rows: rowsFor('b', { txs: tx('b', '2025-05-01') }), kind: 'person', email: 'b@acme.com', emails: [], company: null, scorable: true },
    { rows: rowsFor('c', { crm: { notes: '05/01/2026 - want to sell next spring' } }), kind: 'person', email: null, emails: [], company: 'Acme', scorable: true },
    { rows: rowsFor('d', { links: [{ property_id: 'P2', relation: 'owns' }] }), kind: 'person', email: null, emails: [], company: null, scorable: true },
    { rows: rowsFor('z'), kind: 'person', email: null, emails: [], company: null, scorable: false },
  ], TODAY);
  assert.equal(s.contacts, 5);
  assert.equal(s.scorable, 4);
  assert.equal(s.pastClientsWithClosing, 2);
  assert.equal(s.businessEmailOrCompany, 2);
  assert.equal(s.propertyWithPurchaseDate, 2);
  assert.equal(s.ownedAddressNoDate, 1);
  assert.equal(s.homeBought4to10, 1);
  assert.equal(s.datedPlanNotes, 1);
  const first = s.tiers.find((t) => t.key === 'first_batch');
  assert.equal(first.count, 2);
  const biz = s.tiers.find((t) => t.key === 'first_batch_business');
  assert.equal(biz.count, 1);
  assert.equal(biz.firecrawlCredits, COST.firecrawlCreditsPerSearch + COST.firecrawlCreditsPerScrape);
  assert.equal(biz.pdlUsdIfAllMatch, 0.28);
  assert.equal(s.tiers.find((t) => t.key === 'free').firecrawlCredits, 0);
});
