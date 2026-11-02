// Scheduling tests for src/lib/research/plan.ts.
//
// Run: node --experimental-strip-types --test test/research-plan.test.mjs
//
// The rules these tests exist to hold:
//   1. A pair we already hold complete answers for is never probed again. That
//      is the whole point of sharing probe runs across leads in a town.
//   2. A 'failed' row is a hole, not an answer. The pair gets asked again.
//   3. A trade with no emergency costs four runs, not eight. If that ever
//      quietly becomes eight, every batch doubles in price with no notice.
//   4. Nothing spends past the cap, and nothing runs at all on a cap of zero.

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  PROBE_BAR,
  deadlinePassed,
  expectedRuns,
  lockExpired,
  pairsNeedingProbe,
  pickStage,
  withinBudget,
} = await import('../src/research/plan.ts');

const { ENGINE_KEYS } = await import('../src/research/types.ts');
const { tradeBySlug } = await import('../src/research/trades.ts');

const lookup = (slug) => tradeBySlug(slug);

// Every expected row for a pair, marked answered. The shape the DB hands back.
const answered = (trade, city, state = 'CO') =>
  expectedRuns(tradeBySlug(trade)).map((run) => ({
    trade,
    city,
    state,
    question_id: run.question_id,
    engine: run.engine,
    status: 'answered',
  }));

// -- Stage order -------------------------------------------------------------

test('pickStage takes the first stage in order with work waiting', () => {
  const none = { classify: 0, probe: 0, gbp: 0, reviews: 0, site: 0, grade: 0, profile: 0, owner: 0 };
  assert.equal(pickStage(none), null);
  assert.equal(pickStage({ ...none, profile: 3 }), 'profile');
  assert.equal(pickStage({ ...none, site: 1, profile: 3 }), 'site');
  assert.equal(pickStage({ ...none, probe: 2, site: 1, profile: 3 }), 'site', 'grade first: the site is read before the engines are asked');
  assert.equal(pickStage({ ...none, probe: 2, grade: 4, profile: 3 }), 'grade');
  assert.equal(pickStage({ ...none, classify: 1, probe: 2, profile: 3 }), 'classify');
  assert.equal(pickStage({ ...none, reviews: 373 }), null, 'reviews is never walked: the whole-pond read stays ruled out');
});

test('pairsNeedingProbe with a bar: a pair is owed only once a lead in it grades at or above the bar', () => {
  const trades = (slug) => (slug === 'roofing' ? { urgent: 'leak' } : slug === 'salon' ? { urgent: null } : null);
  const leads = [
    { trade: 'roofing', city: 'Montrose', state: 'CO', grade_score: 30 },
    { trade: 'roofing', city: 'Montrose', state: 'CO', grade_score: PROBE_BAR },
    { trade: 'salon', city: 'Delta', state: 'CO', grade_score: PROBE_BAR - 1 },
    { trade: 'salon', city: 'Montrose', state: 'CO', grade_score: null },
  ];
  const key = (p) => `${p.trade}|${p.city.toLowerCase()}`;
  assert.deepEqual(pairsNeedingProbe(leads, [], trades, PROBE_BAR).map(key), ['roofing|montrose']);
  assert.equal(pairsNeedingProbe(leads, [], trades).length, 3, 'no bar: every pair, as before');
  assert.equal(PROBE_BAR, 45);
});

// -- Budget ------------------------------------------------------------------

test('withinBudget allows spending exactly to the cap and no further', () => {
  assert.equal(withinBudget(0, 1, 0.25), true);
  assert.equal(withinBudget(0.75, 1, 0.25), true);
  assert.equal(withinBudget(0.76, 1, 0.25), false);
  assert.equal(withinBudget(1, 1, 0), true);
  assert.equal(withinBudget(1, 1, 0.01), false);
});

test('a cap of zero or less is no budget, not unlimited', () => {
  assert.equal(withinBudget(0, 0, 0), false);
  assert.equal(withinBudget(0, 0, 0.25), false);
  assert.equal(withinBudget(0, -5, 0.25), false);
});

// -- Deadline and locks ------------------------------------------------------

test('deadlinePassed fires at the cap, not after it', () => {
  assert.equal(deadlinePassed(1_000, 1_000), false);
  assert.equal(deadlinePassed(1_000, 1_000 + 539_999), false);
  assert.equal(deadlinePassed(1_000, 1_000 + 540_000), true);
  assert.equal(deadlinePassed(1_000, 1_000 + 5_000, 5_000), true);
  assert.equal(deadlinePassed(1_000, 1_000 + 4_999, 5_000), false);
});

test('lockExpired frees a lock past its TTL, and frees a broken one', () => {
  const now = Date.parse('2026-09-03T12:00:00.000Z');
  assert.equal(lockExpired('2026-09-03T11:50:00.000Z', now), false);
  assert.equal(lockExpired('2026-09-03T11:45:00.000Z', now), true);
  assert.equal(lockExpired('2026-09-03T11:44:00.000Z', now), true);
  assert.equal(lockExpired('2026-09-03T11:59:00.000Z', now, 30_000), true);
  // An unparseable timestamp must not hold a batch forever.
  assert.equal(lockExpired('not a date', now), true);
});

// -- Expected runs -----------------------------------------------------------

test('expectedRuns is four for a trade with no emergency, eight for one with', () => {
  assert.equal(expectedRuns({ urgent: null }).length, ENGINE_KEYS.length);
  assert.equal(expectedRuns({ urgent: 'My roof is leaking' }).length, ENGINE_KEYS.length * 2);
  assert.equal(expectedRuns(tradeBySlug('salon')).length, 4);
  assert.equal(expectedRuns(tradeBySlug('roofing')).length, 8);
});

test('expectedRuns is deterministic: best across every engine, then urgent', () => {
  const runs = expectedRuns(tradeBySlug('roofing'));
  assert.deepEqual(
    runs.slice(0, 4).map((r) => r.question_id),
    ['best', 'best', 'best', 'best'],
  );
  assert.deepEqual(runs.slice(0, 4).map((r) => r.engine), [...ENGINE_KEYS]);
  assert.deepEqual(runs.slice(4).map((r) => r.question_id), ['urgent', 'urgent', 'urgent', 'urgent']);
  assert.deepEqual(expectedRuns(tradeBySlug('roofing')), runs);
});

// -- Which pairs still owe probe runs ----------------------------------------

test('a fully answered pair is not probed again', () => {
  const leads = [{ trade: 'roofing', city: 'Fruita', state: 'CO' }];
  assert.deepEqual(pairsNeedingProbe(leads, answered('roofing', 'Fruita'), lookup), []);
});

test('a pair with nothing held owes runs', () => {
  const leads = [{ trade: 'roofing', city: 'Fruita', state: 'CO' }];
  assert.deepEqual(pairsNeedingProbe(leads, [], lookup), [
    { trade: 'roofing', city: 'Fruita', state: 'CO' },
  ]);
});

test('one failed engine puts the whole pair back in the queue', () => {
  const leads = [{ trade: 'roofing', city: 'Fruita', state: 'CO' }];
  const rows = answered('roofing', 'Fruita');
  rows[2] = { ...rows[2], status: 'failed' };
  assert.deepEqual(pairsNeedingProbe(leads, rows, lookup), [
    { trade: 'roofing', city: 'Fruita', state: 'CO' },
  ]);
});

test('a missing engine row puts the pair back in the queue', () => {
  const leads = [{ trade: 'roofing', city: 'Fruita', state: 'CO' }];
  const rows = answered('roofing', 'Fruita').slice(0, 7);
  assert.equal(pairsNeedingProbe(leads, rows, lookup).length, 1);
});

test('a salon pair is satisfied by four rows, where a roofing pair needs eight', () => {
  const salon = [{ trade: 'salon', city: 'Montrose', state: 'CO' }];
  const rows = answered('salon', 'Montrose');
  assert.equal(rows.length, 4);
  assert.deepEqual(pairsNeedingProbe(salon, rows, lookup), []);

  // The same four rows, relabelled onto a trade that has an emergency, are not
  // enough: the urgent question is still unasked.
  const roofing = [{ trade: 'roofing', city: 'Montrose', state: 'CO' }];
  const four = rows.map((r) => ({ ...r, trade: 'roofing' }));
  assert.equal(pairsNeedingProbe(roofing, four, lookup).length, 1);
});

test('leads with no city or no trade are skipped, never guessed at', () => {
  const leads = [
    { trade: 'roofing', city: null, state: 'CO' },
    { trade: 'roofing', city: '   ', state: 'CO' },
    { trade: null, city: 'Fruita', state: 'CO' },
    { trade: '', city: 'Fruita', state: 'CO' },
  ];
  assert.deepEqual(pairsNeedingProbe(leads, [], lookup), []);
});

test('a trade slug with no rule is skipped rather than probed blind', () => {
  const leads = [{ trade: 'llama_farming', city: 'Fruita', state: 'CO' }];
  assert.deepEqual(pairsNeedingProbe(leads, [], lookup), []);
});

test('many leads in one town collapse to one pair', () => {
  const leads = [
    { trade: 'roofing', city: 'Fruita', state: 'CO' },
    { trade: 'Roofing', city: 'fruita', state: 'co' },
    { trade: 'roofing', city: '  FRUITA ', state: null },
    { trade: 'roofing', city: 'Fruita', state: 'CO' },
  ];
  assert.deepEqual(pairsNeedingProbe(leads, [], lookup), [
    { trade: 'roofing', city: 'Fruita', state: 'CO' },
  ]);
});

test('pairs come back ordered by trade then city', () => {
  const leads = [
    { trade: 'roofing', city: 'Rifle', state: 'CO' },
    { trade: 'hvac', city: 'Palisade', state: 'CO' },
    { trade: 'roofing', city: 'Fruita', state: 'CO' },
    { trade: 'hvac', city: 'De Beque', state: 'CO' },
  ];
  assert.deepEqual(
    pairsNeedingProbe(leads, [], lookup).map((p) => `${p.trade}/${p.city}`),
    ['hvac/De Beque', 'hvac/Palisade', 'roofing/Fruita', 'roofing/Rifle'],
  );
});

test('answers held for one town do not satisfy another', () => {
  const leads = [{ trade: 'roofing', city: 'Rifle', state: 'CO' }];
  assert.equal(pairsNeedingProbe(leads, answered('roofing', 'Fruita'), lookup).length, 1);
});
