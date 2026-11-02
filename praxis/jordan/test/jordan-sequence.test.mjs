// Jordan's follow-up schedule, the pure half (src/lib/jordan/sequence.ts).
//
// Run: node --experimental-strip-types --test test/jordan-sequence.test.mjs
//
// sequence.ts imports only time.ts, so it is loaded straight off disk. Every
// instant below is written as Mountain wall-clock time through time.ts
// denverInstant, so the tests say "Tuesday 9 AM" and mean it, across the
// November clock change too. The end-to-end run (the tick sending through the
// real pipeline) is in jordan-pipeline.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';

const Q = await import('../src/jordan/sequence.ts');
const { denverInstant, denverParts } = await import('../src/jordan/time.ts');

/** A Mountain wall-clock instant. */
const mt = (y, m, d, h = 0, min = 0) => denverInstant(y, m, d, h, min);
const iso = (d) => d.toISOString();
// Monday October 5 2026 .. Friday October 9: an ordinary week (MDT).
const MON = (h, m = 0) => mt(2026, 10, 5, h, m);
const TUE = (h, m = 0) => mt(2026, 10, 6, h, m);

function lead(over = {}) {
  return {
    status: 'new',
    do_not_contact: false,
    email: 'sam@example.com',
    phone: null,
    text_consent: null,
    sequence_step: 0,
    next_touch_at: iso(TUE(9)),
    sequence_channel: 'email',
    revived_at: null,
    ...over,
  };
}

// ── The day marks ───────────────────────────────────────────────────────────

test('scheduleAfter: day 3, 7, 14 and 90 from the first touch, at 9 AM Mountain', () => {
  const first = TUE(9);
  assert.equal(iso(Q.scheduleAfter(1, first, first)), iso(mt(2026, 10, 9, 9)), 'the bump on Friday (day 3)');
  assert.equal(iso(Q.scheduleAfter(2, mt(2026, 10, 9, 9), first)), iso(mt(2026, 10, 13, 9)), 'the value message the next Tuesday (day 7)');
  assert.equal(iso(Q.scheduleAfter(3, mt(2026, 10, 13, 9), first)), iso(mt(2026, 10, 20, 9)), 'the exit on day 14');
  // Day 90 is Monday January 4 2027, after the clocks went back: 9 AM MST.
  assert.equal(iso(Q.scheduleAfter(4, mt(2026, 10, 20, 9), first)), iso(mt(2027, 1, 4, 9)), 'the one revival on day 90');
  assert.equal(iso(Q.scheduleAfter(5, mt(2026, 10, 20, 9), first)), iso(mt(2027, 1, 4, 9)), 'dormant keeps the same revival date');
  assert.equal(mt(2027, 1, 4, 9).toISOString(), '2027-01-04T16:00:00.000Z', 'MST in January');
  assert.equal(Q.scheduleAfter(0, first, first), null, 'nothing sent, nothing scheduled after');
  assert.equal(Q.scheduleAfter(6, first, first), null, 'never anything after the revival');
});

test('scheduleAfter: a mark on a weekend moves to Monday; never on the same day as the message before', () => {
  const wed = mt(2026, 10, 7, 9);
  // Day 3 from a Wednesday is Saturday: Monday instead.
  assert.equal(iso(Q.scheduleAfter(1, wed, wed)), iso(mt(2026, 10, 12, 9)));
  // A bump that slipped to day 7 (a pause) pushes the value message a day, not a week.
  const first = TUE(9);
  const lateBump = mt(2026, 10, 13, 10);
  assert.equal(iso(Q.scheduleAfter(2, lateBump, first)), iso(mt(2026, 10, 14, 9)));
  // A late Friday bump: the next business morning is Monday.
  assert.equal(iso(Q.nextBusinessMorning(mt(2026, 10, 9, 16))), iso(mt(2026, 10, 12, 9)));
});

// ── The send window ─────────────────────────────────────────────────────────

test('sendWindow: weekdays, 9 AM to 5 PM Mountain, email and text alike; weekends and evenings wait', () => {
  assert.equal(Q.sendWindow(MON(8, 59)).open, false);
  assert.equal(iso(Q.sendWindow(MON(8, 59)).opensAt), iso(MON(9)));
  assert.equal(Q.sendWindow(MON(9)).open, true);
  assert.equal(Q.sendWindow(mt(2026, 10, 9, 16, 59)).open, true, 'Friday 4:59 PM');
  const fri5 = Q.sendWindow(mt(2026, 10, 9, 17));
  assert.equal(fri5.open, false, 'Friday 5 PM');
  assert.equal(iso(fri5.opensAt), iso(mt(2026, 10, 12, 9)), 'Monday 9 AM');
  const sat = Q.sendWindow(mt(2026, 10, 10, 11));
  assert.equal(sat.open, false);
  assert.match(sat.reason, /weekdays only/);
  assert.equal(iso(sat.opensAt), iso(mt(2026, 10, 12, 9)));
  assert.equal(Q.sendWindow(TUE(12), 'text').open, true, 'a text inside the window is inside texting hours too');
  assert.equal(Q.sendWindow(TUE(20), 'text').open, false);
  // No holiday list, on purpose: Thanksgiving is a Thursday, so it is open.
  assert.equal(Q.sendWindow(mt(2026, 11, 26, 10)).open, true);
});

test('firstTouchAt: later today when admitted on a weekday before 3 PM, else the next business morning', () => {
  assert.equal(iso(Q.firstTouchAt(MON(10, 5))), iso(MON(11, 15)), 'an hour later, on the quarter hour');
  assert.equal(iso(Q.firstTouchAt(MON(7))), iso(MON(9)), 'not before the window opens');
  assert.equal(iso(Q.firstTouchAt(MON(14, 59))), iso(MON(16)), 'just before the cutoff');
  assert.equal(iso(Q.firstTouchAt(MON(16))), iso(TUE(9)), 'after 3 PM: Tuesday 9 AM');
  assert.equal(iso(Q.firstTouchAt(mt(2026, 10, 9, 15, 30))), iso(mt(2026, 10, 12, 9)), 'Friday afternoon: Monday');
  assert.equal(iso(Q.firstTouchAt(mt(2026, 10, 10, 10))), iso(mt(2026, 10, 12, 9)), 'Saturday: Monday');
});

// ── nextTouch ───────────────────────────────────────────────────────────────

test('nextTouch: every step maps to its message, due and inside the window', () => {
  const at = TUE(9, 5);
  assert.equal(Q.nextTouch(lead({ sequence_step: 0 }), at).action, 'first-touch');
  assert.equal(Q.nextTouch(lead({ sequence_step: 1, status: 'in_sequence' }), at).action, 'bump');
  assert.equal(Q.nextTouch(lead({ sequence_step: 2, status: 'in_sequence' }), at).action, 'value');
  assert.equal(Q.nextTouch(lead({ sequence_step: 3, status: 'in_sequence' }), at).action, 'exit');
  assert.equal(Q.nextTouch(lead({ sequence_step: 4, status: 'not_now' }), at).action, 'revive');
  assert.equal(Q.nextTouch(lead({ sequence_step: 5, status: 'dormant' }), at).action, 'revive');
  assert.equal(Q.nextTouch(lead({ sequence_step: 0, status: 'not_now' }), at).action, 'first-touch', 'a "not now" coming back on its date');
});

test('nextTouch: not due yet, or due outside the window, waits with the time it will go', () => {
  const early = Q.nextTouch(lead({ next_touch_at: iso(TUE(9)) }), MON(12));
  assert.equal(early.action, 'wait');
  assert.equal(iso(early.dueAt), iso(TUE(9)));
  const weekend = Q.nextTouch(lead({ next_touch_at: iso(mt(2026, 10, 9, 9)) }), mt(2026, 10, 10, 10));
  assert.equal(weekend.action, 'wait');
  assert.equal(iso(weekend.dueAt), iso(mt(2026, 10, 12, 9)), 'Saturday waits for Monday 9 AM');
  const evening = Q.nextTouch(lead(), TUE(18));
  assert.equal(evening.action, 'wait');
  assert.equal(iso(evening.dueAt), iso(mt(2026, 10, 7, 9)));
});

test('nextTouch: a reply, a booking, a hand-off, STOP and do not contact all take a lead out', () => {
  const at = TUE(10);
  for (const status of ['replied', 'booked', 'escalated', 'unsubscribed', 'do_not_contact']) {
    assert.equal(Q.nextTouch(lead({ status, sequence_step: 1 }), at).action, 'none', status);
  }
  const stop = Q.nextTouch(lead({ status: 'unsubscribed', do_not_contact: true, sequence_step: 2 }), at);
  assert.equal(stop.action, 'none');
  assert.match(stop.reason, /not to be contacted/);
  assert.equal(Q.nextTouch(lead({ do_not_contact: true }), at).action, 'none', 'the flag alone is enough');
  // A bump never goes to a lead who said not now (their date is the first touch, not a bump).
  assert.equal(Q.nextTouch(lead({ status: 'not_now', sequence_step: 1 }), at).action, 'none');
});

test('nextTouch: revived once, never again; nothing after step 6', () => {
  const at = TUE(10);
  const six = Q.nextTouch(lead({ sequence_step: 6, status: 'in_sequence' }), at);
  assert.equal(six.action, 'none');
  assert.match(six.reason, /never writes to them again/);
  assert.equal(Q.nextTouch(lead({ sequence_step: 5, status: 'dormant', revived_at: iso(MON(9)) }), at).action, 'none');
  assert.equal(Q.nextTouch(lead({ sequence_step: 6, status: 'dormant', next_touch_at: iso(MON(9)) }), at).action, 'none');
});

test('nextTouch and sequenceChannelFor: text only with consent and a phone; else email; neither never enters', () => {
  assert.equal(Q.sequenceChannelFor({ email: 'a@b.co', phone: '+19705550101', text_consent: 'verbal' }), 'text');
  assert.equal(Q.sequenceChannelFor({ email: 'a@b.co', phone: '+19705550101', text_consent: null }), 'email', 'no consent goes by email');
  assert.equal(Q.sequenceChannelFor({ email: null, phone: '+19705550101', text_consent: null }), null);
  assert.equal(Q.sequenceChannelFor({ email: null, phone: null, text_consent: 'written' }), null);
  const at = TUE(10);
  assert.equal(Q.nextTouch(lead({ sequence_channel: null }), at).action, 'none', 'no channel, no schedule');
  assert.equal(Q.nextTouch(lead({ sequence_channel: 'text', phone: '+19705550101', text_consent: null }), at).action, 'none', 'never a text without consent');
  assert.equal(Q.nextTouch(lead({ sequence_channel: 'text', phone: '+19705550101', text_consent: 'written' }), at).action, 'first-touch');
  assert.equal(Q.nextTouch(lead({ next_touch_at: null }), at).action, 'none', 'nothing scheduled');
});

test('touchedToday: one message per channel per day, and never two unanswered on one day across channels', () => {
  assert.equal(Q.touchedToday([], 'email'), null);
  assert.match(Q.touchedToday([{ channel: 'email' }], 'email'), /by email today/);
  assert.match(Q.touchedToday([{ channel: 'text' }], 'email'), /other channel/);
});

test('mountainDayStart is Mountain midnight, not the server\'s', () => {
  const start = Q.mountainDayStart(TUE(23, 30));
  const p = denverParts(start);
  assert.deepEqual([p.month, p.day, p.hour, p.minute], [10, 6, 0, 0]);
});

// ── "Not now, try me in November" ───────────────────────────────────────────

test('deferDate: a month is its first business day at 9 AM Mountain; a date is that date', () => {
  const now = TUE(10);
  // November 1 2026 is a Sunday (and the day the clocks change): Monday the 2nd, MST.
  assert.equal(iso(Q.deferDate('Can you reach out in November? Swamped until then.', now)), iso(mt(2026, 11, 2, 9)));
  assert.equal(iso(Q.deferDate('try me November 12', now)), iso(mt(2026, 11, 12, 9)));
  assert.equal(iso(Q.deferDate('after the 12th of Nov works', now)), iso(mt(2026, 11, 12, 9)));
  assert.equal(iso(Q.deferDate('ping me 11/14', now)), iso(mt(2026, 11, 16, 9)), 'a Saturday date moves to Monday');
  assert.equal(iso(Q.deferDate('next month please', now)), iso(mt(2026, 11, 2, 9)));
  // Next quarter from October is January. January 1 2027 is a Friday but New
  // Year's Day: the first workday is Monday the 4th. (This line used to pin
  // January 1, the holiday.)
  assert.equal(iso(Q.deferDate('Call me next quarter.', now)), iso(mt(2027, 1, 4, 9)));
  assert.equal(iso(Q.deferDate('Try me in March', now)), iso(mt(2027, 3, 1, 9)), 'a month already past this year is next year');
  assert.equal(iso(Q.deferDate('early May is better', now)), iso(mt(2027, 5, 3, 9)));
});

test('deferDate: nothing to read, or the current month with no day, is left to Griffin', () => {
  const now = TUE(10);
  assert.equal(Q.deferDate('Not right now, thanks.', now), null);
  assert.equal(Q.deferDate('Maybe later in October', now), null, 'this month, no day: ambiguous');
  assert.equal(Q.deferDate('you may reach me later', now), null, '"may" the verb is not May');
  assert.equal(Q.deferDate('we are open 24/7', now), null, 'not a date');
});

// ── Red-team findings, 30 Sep 2026: read the sentence, not the month list ────
// Each of these was written straight into next_touch_at by the pipeline.

const SEP30 = mt(2026, 9, 30, 10); // Wednesday September 30 2026, 10 AM Mountain

test('deferDate: a negated or "through" month is a bound, not the date', () => {
  // Was October 1 (tomorrow): October came first in the month list.
  assert.equal(iso(Q.deferDate('not October, try me in November', SEP30)), iso(mt(2026, 11, 2, 9)));
  // Was November 2: "through November" is how long they are busy.
  assert.equal(iso(Q.deferDate('slammed through November, reach out in December', SEP30)), iso(mt(2026, 12, 1, 9)));
  // Only a bound, nothing after it: Griffin decides.
  assert.equal(Q.deferDate('not until November', SEP30), null);
});

test('deferDate: two different months still standing is a question, not a date', () => {
  assert.equal(Q.deferDate('November or December, whichever', SEP30), null);
  assert.equal(Q.deferDate('try me in December, or maybe January', SEP30), null);
  // The same month twice is one month; the named day wins.
  assert.equal(iso(Q.deferDate('November works, say Nov 12', SEP30)), iso(mt(2026, 11, 12, 9)));
});

test('deferDate: month words that are names only count as months with a cue', () => {
  // Was January 1: "Jan" is the partner.
  assert.equal(Q.deferDate('my partner Jan handles this, she is out this week', SEP30), null);
  // Was June 2027: "June" is the person.
  assert.equal(Q.deferDate('talk to June about it next week', SEP30), null);
  // With a cue or a day, they are months.
  assert.equal(iso(Q.deferDate('early June works', SEP30)), iso(mt(2027, 6, 1, 9)));
  assert.equal(iso(Q.deferDate('try me June 14', SEP30)), iso(mt(2027, 6, 14, 9)));
  assert.equal(iso(Q.deferDate('reach out in Jan', SEP30)), iso(mt(2027, 1, 4, 9)), 'January 1 is New Year\'s Day');
});

test('deferDate: "after the holidays" is early January, relative to when it was said', () => {
  // Was Friday January 1 2027, New Year's Day. January 2 is a Saturday: Monday the 4th.
  assert.equal(iso(Q.deferDate('after the holidays', SEP30)), iso(mt(2027, 1, 4, 9)));
  // Said on Monday January 4 2027: was January 3 2028, a year late. The coming Monday.
  assert.equal(iso(Q.deferDate('after the holidays', mt(2027, 1, 4, 10))), iso(mt(2027, 1, 11, 9)));
  // Said on Wednesday January 6 2027: the coming Monday, January 11.
  assert.equal(iso(Q.deferDate('try me after the holidays', mt(2027, 1, 6, 10))), iso(mt(2027, 1, 11, 9)));
});

test('deferDate: never a fixed federal holiday or its observed weekday', () => {
  // July 4 2027 is a Sunday, observed Monday July 5: Tuesday the 6th.
  assert.equal(iso(Q.deferDate('try me July 4', SEP30)), iso(mt(2027, 7, 6, 9)));
  // Christmas 2026 is a Friday: Monday the 28th.
  assert.equal(iso(Q.deferDate('ping me 12/25', SEP30)), iso(mt(2026, 12, 28, 9)));
  // New Year's 2028 is a Saturday, observed Friday December 31 2027: Monday January 3 2028.
  assert.equal(iso(Q.deferDate('ping me 12/31/27', SEP30)), iso(mt(2028, 1, 3, 9)));
});

test('deferDate: quarters, "Q1" to "Q4" and "first quarter", land on the first workday', () => {
  // "Q1" was null. January 1 2027 is New Year's Day: Monday the 4th.
  assert.equal(iso(Q.deferDate('Q1', SEP30)), iso(mt(2027, 1, 4, 9)));
  assert.equal(iso(Q.deferDate('let us talk in the first quarter', SEP30)), iso(mt(2027, 1, 4, 9)));
  assert.equal(iso(Q.deferDate('Q2 is better', SEP30)), iso(mt(2027, 4, 1, 9)));
  assert.equal(iso(Q.deferDate('try me in Q4', SEP30)), iso(mt(2026, 10, 1, 9)), 'Q4 starts tomorrow, Thursday October 1');
  assert.equal(iso(Q.deferDate('next quarter', SEP30)), iso(mt(2026, 10, 1, 9)));
  // The quarter they are already in says nothing about when: Griffin decides.
  assert.equal(Q.deferDate('sometime in Q3', SEP30), null);
});
