// The assessment engine and the rewards economy, tested on their own.
// The course repo tests these against the full lesson bank; here each rule is
// shown on a small hand-built item so the behaviour reads on its own.
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../src/assess.js');
const R = require('../src/rewards.js');

// Build an item the way the course build does: answers ship hashed, never plain.
const H = (id, v) => A.hashOf(id, v);

test('answers are graded against hashes, so the right answer never ships in the page', () => {
  const q = { id: 'q1', kind: 'choice', o: ['a', 'b', 'c'], a: H('q1', '2') };
  assert.equal(A.check(q, 2), true);
  assert.equal(A.check(q, 1), false);
  assert.ok(!JSON.stringify(q).includes('"2"'), 'the plain answer is not in the item');
});

test('short answers forgive case, quotes, a leading article and end punctuation', () => {
  const q = { id: 'q2', kind: 'short', h: [H('q2', A.norm('pull request'))] };
  assert.equal(A.check(q, 'The Pull Request.'), true);
  assert.equal(A.check(q, '  pull   request '), true);
  assert.equal(A.check(q, 'merge request'), false);
  assert.equal(A.check(q, ''), false);
});

test('a written line of code ignores spacing and quote style, but keeps case', () => {
  const q = { id: 'q3', kind: 'code', h: [H('q3', A.code("git checkout -b fix-login"))] };
  assert.equal(A.check(q, 'git checkout -b   fix-login'), true);
  assert.equal(A.check(q, 'GIT CHECKOUT -B FIX-LOGIN'), false);
});

test('spot, match and order items need the exact set or sequence', () => {
  const spot = { id: 's', kind: 'spot', s: H('s', '1,3') };
  assert.equal(A.check(spot, [3, 1]), true, 'order of picks does not matter');
  assert.equal(A.check(spot, [1]), false);
  const order = { id: 'o', kind: 'order', S: ['a', 'b', 'c'], k: H('o', '2,0,1') };
  assert.equal(A.check(order, [2, 0, 1]), true);
  assert.equal(A.check(order, [2, 2, 1]), false, 'a repeated step is refused');
});

test('evidence items check a pasted line from the learner\'s own app', () => {
  const q = { id: 'e', kind: 'evidence', re: '^https://[\\w.-]+\\.vercel\\.app' };
  assert.equal(A.check(q, 'https://my-app.vercel.app/login'), true);
  assert.equal(A.check(q, 'my app is on vercel'), false);
});

test('the pass mark is 90% everywhere, rounded up', () => {
  assert.equal(A.need(10), 9);
  assert.equal(A.need(25), 23);
  assert.equal(A.need(30), 27);
  assert.deepEqual(A.rule({ draw: 25 }), { draw: 25, need: 23, pct: 90, choiceMax: 3 });
});

test('a skip test asks every slot, puts the learner\'s own evidence first, and holds multiple choice down', () => {
  const slot = (n, take, kinds) => ({ take, q: kinds.map((k, i) => ({ id: `${n}${i}`, kind: k })) });
  const bank = { slots: [
    slot('a', ['L1'], ['evidence', 'choice', 'choice', 'short']),
    slot('b', ['L2'], ['evidence', 'choice', 'code', 'choice']),
    slot('c', ['L3'], ['choice', 'choice', 'order', 'fix']),
  ] };
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const ids = A.draw(bank, { draw: 9 }, [], rand);
  assert.equal(ids.length, 9);
  for (const s of bank.slots) assert.ok(s.q.some((q) => ids.includes(q.id)), 'every slot is asked');
  const kinds = bank.slots.flatMap((s) => s.q).filter((q) => ids.includes(q.id));
  assert.equal(kinds.filter((q) => q.kind === 'evidence').length, 2);
});

test('a skip test routes: a miss sends you to that lesson instead of failing the whole level', () => {
  const bank = { slots: [{ take: ['L1'], q: [{ id: 'x' }] }, { take: ['L2'], q: [{ id: 'y' }] }] };
  const r = A.score(bank, { draw: 2 }, ['x', 'y'], { x: true, y: false });
  assert.equal(r.pass, false);
  assert.deepEqual(r.take, ['L2']);
  assert.deepEqual(r.tested, ['L1'], 'the slot you got right is tested out');
});

test('tests are timed by item type and level, and cooldowns double per fail in a row up to a cap', () => {
  const sch = { item_seconds: { choice: 40, code: 120 }, level_time_factor: [1, 1.1, 1.2, 1.25, 1.3, 1.35, 1.4],
    check: { cooldown_minutes: [10, 15, 20, 30, 40, 60, 60], backoff: 2, backoff_cap: 4 } };
  assert.equal(A.timeLimitMs(sch, ['choice', 'code'], 1), 180000);
  assert.equal(A.cooldownMs(sch, 'check', 1, 1), 10 * 60000);
  assert.equal(A.cooldownMs(sch, 'check', 1, 2), 20 * 60000);
  assert.equal(A.cooldownMs(sch, 'check', 1, 9), 40 * 60000, 'capped at 4x');
});

test('the ledger only ever moves towards more tried and longer locked, so a reset cannot shorten a cooldown', () => {
  const g = { assess: { 'final-1': { tries: 1, fails: 1, until: 5000, seen: [] } } };
  const L = { c: 0, k: { 'final-1': { f: 2, u: 9000, t: 2, x: 0, p: 0 } } };
  assert.equal(A.ledgerMerge(g, L), true);
  assert.equal(g.assess['final-1'].until, 9000);
  const shorter = { c: 0, k: { 'final-1': { f: 1, u: 100, t: 1, x: 0, p: 0 } } };
  A.ledgerMerge(g, shorter);
  assert.equal(g.assess['final-1'].until, 9000, 'a stale store never shortens a lock');
});

test('hints are never allowed on a test that counts, or while any counting clock runs', () => {
  const sch = { extra: { hints: true }, check: { hints: true } };
  assert.equal(A.hintOk(sch, 'extra', false), true);
  assert.equal(A.hintOk(sch, 'check', false), false);
  assert.equal(A.hintOk(sch, 'extra', true), false);
});

test('rewards: points by minutes and kind, coins never stored as a balance, spending never lowers rank', () => {
  assert.equal(R.unitPoints(30, 'lesson'), 60);
  assert.equal(R.unitPoints(30, 'build'), 90);
  assert.equal(R.unitPoints(1, 'lesson'), 10, 'at least 10');
  const g = { pts: 2800 };
  assert.equal(R.rankOf(g.pts), 2);
  assert.equal(R.balance(g), 280);
  assert.equal(R.spend(g, 100), true);
  assert.equal(R.balance(g), 180);
  assert.equal(R.rankOf(g.pts), 2, 'rank unchanged');
  assert.equal(R.spend(g, 1000), false, 'cannot overspend');
});

test('rewards: a hint always costs more than a hinted right answer pays', () => {
  for (let level = 1; level <= 7; level++) assert.ok(R.hintPrice(level, 'nudge') > 2);
});
