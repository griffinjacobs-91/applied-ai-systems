import test from 'node:test';
import assert from 'node:assert/strict';

import { observations } from '../observations.ts';
import { STOP_FAST_DAYS } from '../constants.ts';
import { set25Trades, set3Trades, setCrash } from './fixtures.ts';

function byId(set: ReturnType<typeof observations>, id: string) {
  const o = set.observations.find((x) => x.id === id);
  assert.ok(o, `missing observation ${id}`);
  return o!;
}

test('observations never propose a change', () => {
  const s = set25Trades();
  const set = observations(s.input.trades, s.window, s.input.signalCounts);
  assert.match(set.note, /^Observations only\./);
  assert.match(set.note, /Griffin edits the profile by hand/);
  for (const o of set.observations) {
    assert.doesNotMatch(o.sentence, /should|recommend|widen|tighten|raise|lower|suggest/i);
  }
});

test('stops hit inside five days: the too tight read, with its n', () => {
  const s = set25Trades();
  const o = byId(observations(s.input.trades, s.window, s.input.signalCounts), 'stops-hit-fast');
  assert.equal(STOP_FAST_DAYS, 5);
  assert.equal(o.count, 4);
  assert.equal(o.sample.n, 6);
  assert.equal(o.sharePct, 66.67);
  // Six stops is under the floor, and the sentence says so rather than letting
  // 66.67% read as a finding.
  assert.equal(o.sample.withinNoise, true);
  assert.match(o.sentence, /4 of 6 stops fired inside 5 days \(66\.67%\)\./);
  assert.match(o.sentence, /Within noise: 6 stops is under the 20 needed/);
});

test('the fast stop clock is configurable and changes the count', () => {
  const s = set25Trades();
  const o = byId(observations(s.input.trades, s.window, undefined, { stopFastDays: 12 }), 'stops-hit-fast');
  assert.equal(o.count, 5);
  assert.match(o.parameter, /12 day clock/);
});

test('targets never reached: the too far read, on a big enough sample to speak', () => {
  const s = set25Trades();
  const o = byId(observations(s.input.trades, s.window, s.input.signalCounts), 'targets-never-reached');
  assert.equal(o.count, 17);
  assert.equal(o.sample.n, 25);
  assert.equal(o.sharePct, 68);
  assert.equal(o.sample.withinNoise, false);
  assert.doesNotMatch(o.sentence, /Within noise/);
  assert.match(o.sentence, /17 of 25 closed trades never reached their target \(68%\); 8 did\./);
});

test('expired calls: the limit too low read', () => {
  const s = set25Trades();
  const o = byId(observations(s.input.trades, s.window, s.input.signalCounts), 'calls-expired');
  assert.equal(o.count, 1);
  assert.equal(o.sharePct, 4);
  assert.match(o.sentence, /1 of 25 closed trades expired \(4%\)\./);
});

test('signals fired against signals taken, when the counts are given', () => {
  const s = set25Trades();
  const o = byId(observations(s.input.trades, s.window, s.input.signalCounts), 'signals-taken');
  assert.equal(o.count, 25);
  assert.equal(o.sample.n, 40);
  assert.equal(o.sharePct, 62.5);
  assert.match(o.sentence, /25 of 40 signals were taken \(62\.5%\)\./);
});

test('without signal counts the take rate is omitted, never invented', () => {
  const s = set25Trades();
  const set = observations(s.input.trades, s.window);
  assert.equal(set.observations.find((o) => o.id === 'signals-taken'), undefined);
  assert.equal(set.observations.length, 3);
});

test('an empty window says there is nothing to say', () => {
  const s = set25Trades();
  const set = observations(s.input.trades, { start: '2027-01-01', end: '2027-01-31' });
  assert.match(byId(set, 'stops-hit-fast').sentence, /No stops were hit in this window/);
  assert.match(byId(set, 'targets-never-reached').sentence, /No trades closed in this window/);
  assert.equal(byId(set, 'targets-never-reached').sharePct, null);
});

test('the crash set shows half its stops firing fast, still under the floor', () => {
  const s = setCrash();
  const o = byId(observations(s.input.trades, s.window, s.input.signalCounts), 'stops-hit-fast');
  assert.equal(o.count, 6);
  assert.equal(o.sample.n, 12);
  assert.equal(o.sharePct, 50);
  assert.equal(o.sample.withinNoise, true);
});

test('three trades: every observation carries the noise label', () => {
  const s = set3Trades();
  const set = observations(s.input.trades, s.window, s.input.signalCounts);
  for (const o of set.observations) {
    assert.equal(o.sample.withinNoise, true, `${o.id} should be within noise`);
    assert.match(o.sentence, /Within noise/);
  }
});
