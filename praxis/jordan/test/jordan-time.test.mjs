// Jordan's clock. Mountain time, read from the zone database, never guessed.
//
// Run: node --experimental-strip-types --test test/jordan-time.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

const { denverParts, denverInstant, clockLabel, slotLabel, toSlot, withinTextingHours, nextTextingOpen } =
  await import('../src/jordan/time.ts');

test('a UTC instant reads as Mountain wall-clock time, in daylight and standard time', () => {
  // 8 Oct 2026 19:30 UTC is 1:30 PM MDT (UTC-6), a Thursday.
  const oct = denverParts(new Date('2026-10-08T19:30:00Z'));
  assert.deepEqual(oct, { year: 2026, month: 10, day: 8, hour: 13, minute: 30, weekday: 4 });
  // 10 Dec 2026 20:30 UTC is 1:30 PM MST (UTC-7), a Thursday.
  const dec = denverParts(new Date('2026-12-10T20:30:00Z'));
  assert.deepEqual(dec, { year: 2026, month: 12, day: 10, hour: 13, minute: 30, weekday: 4 });
});

test('a Mountain wall-clock reading maps back to the right instant on both sides of the clock change', () => {
  assert.equal(denverInstant(2026, 10, 8, 13, 30).toISOString(), '2026-10-08T19:30:00.000Z');
  assert.equal(denverInstant(2026, 12, 10, 13, 30).toISOString(), '2026-12-10T20:30:00.000Z');
  // Clocks fall back on Sunday 1 Nov 2026: Friday is UTC-6, Monday is UTC-7.
  assert.equal(denverInstant(2026, 10, 30, 10).toISOString(), '2026-10-30T16:00:00.000Z');
  assert.equal(denverInstant(2026, 11, 2, 10).toISOString(), '2026-11-02T17:00:00.000Z');
});

test('labels read the way Jordan says a time', () => {
  assert.equal(clockLabel(new Date('2026-10-08T19:30:00Z')), '1:30 PM');
  assert.equal(clockLabel(new Date('2026-10-09T16:00:00Z')), '10 AM');
  assert.equal(clockLabel(new Date('2026-10-09T18:00:00Z')), '12 PM');
  assert.equal(slotLabel(new Date('2026-10-08T19:30:00Z')), 'Thursday, October 8 at 1:30 PM');
  assert.deepEqual(toSlot(new Date('2026-10-09T16:00:00Z')), {
    startsAt: '2026-10-09T16:00:00.000Z',
    label: 'Friday, October 9 at 10 AM',
  });
});

test('texting hours are 8am to 8pm Mountain, not server time', () => {
  assert.equal(withinTextingHours(new Date('2026-10-08T14:00:00Z')), true); // 8:00 AM MDT
  assert.equal(withinTextingHours(new Date('2026-10-08T13:59:00Z')), false); // 7:59 AM MDT
  assert.equal(withinTextingHours(new Date('2026-10-09T01:59:00Z')), true); // 7:59 PM MDT
  assert.equal(withinTextingHours(new Date('2026-10-09T02:00:00Z')), false); // 8:00 PM MDT
  // 9am UTC is the middle of the night in Colorado, whatever the server thinks.
  assert.equal(withinTextingHours(new Date('2026-10-08T09:00:00Z')), false);
});

test('a held text is released at the next 8am Mountain', () => {
  const open = new Date('2026-10-08T18:00:00Z');
  assert.equal(nextTextingOpen(open).getTime(), open.getTime());
  // 9:30 PM MDT Thursday releases 8 AM MDT Friday.
  assert.equal(nextTextingOpen(new Date('2026-10-09T03:30:00Z')).toISOString(), '2026-10-09T14:00:00.000Z');
  // 5 AM MDT Friday releases 8 AM MDT the same day.
  assert.equal(nextTextingOpen(new Date('2026-10-09T11:00:00Z')).toISOString(), '2026-10-09T14:00:00.000Z');
  // Saturday night before the clocks fall back releases 8 AM MST Sunday.
  assert.equal(nextTextingOpen(new Date('2026-11-01T04:00:00Z')).toISOString(), '2026-11-01T15:00:00.000Z');
});

test('the clock-change days themselves: every morning hour lands on the right instant', () => {
  // Fall back, Sunday 1 Nov 2026 at 2 AM MDT: the day is MST (UTC-7) from then on.
  assert.equal(denverInstant(2026, 11, 1, 8).toISOString(), '2026-11-01T15:00:00.000Z');
  for (const h of [2, 3, 4, 5, 6, 7, 8, 9]) {
    assert.equal(denverInstant(2026, 11, 1, h).toISOString(), new Date(Date.UTC(2026, 10, 1, h + 7)).toISOString(), `1 Nov ${h}:00`);
  }
  // Spring forward, Sunday 14 Mar 2027 at 2 AM MST: the day is MDT (UTC-6) from 3 AM.
  assert.equal(denverInstant(2027, 3, 14, 8).toISOString(), '2027-03-14T14:00:00.000Z');
  for (const h of [3, 4, 5, 6, 7, 8, 9]) {
    assert.equal(denverInstant(2027, 3, 14, h).toISOString(), new Date(Date.UTC(2027, 2, 14, h + 6)).toISOString(), `14 Mar ${h}:00`);
  }
  // Every result reads back as the wall time asked for.
  for (const [y, m, d] of [[2026, 11, 1], [2027, 3, 14]]) {
    for (let h = 3; h < 24; h++) assert.equal(denverParts(denverInstant(y, m, d, h, 30)).hour, h, `${y}-${m}-${d} ${h}:30`);
  }
});

test('a text held over either clock-change night releases at 8 AM, not 9', () => {
  // 9 PM MDT Saturday 31 Oct 2026 releases 8 AM MST Sunday.
  assert.equal(nextTextingOpen(new Date('2026-11-01T03:00:00Z')).toISOString(), '2026-11-01T15:00:00.000Z');
  // 4 AM MST Sunday 1 Nov (after the change) releases the same morning.
  assert.equal(nextTextingOpen(new Date('2026-11-01T11:00:00Z')).toISOString(), '2026-11-01T15:00:00.000Z');
  // 9 PM MST Saturday 13 Mar 2027 releases 8 AM MDT Sunday.
  assert.equal(nextTextingOpen(new Date('2027-03-14T04:00:00Z')).toISOString(), '2027-03-14T14:00:00.000Z');
  // 1 AM MST Sunday 14 Mar (before the change) releases the same morning.
  assert.equal(nextTextingOpen(new Date('2027-03-14T08:00:00Z')).toISOString(), '2027-03-14T14:00:00.000Z');
});
