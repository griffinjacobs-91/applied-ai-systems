// Jordan's text channel: STOP means the whole message is STOP, the voice
// forward shows Griffin the real caller, and the webhook signature check
// matches Twilio's own published example.
//
// Run: node --experimental-strip-types --test test/jordan-twilio.test.mjs
//
// twilio.ts imports nothing but node:crypto, so it is loaded straight.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const T = await import('../src/jordan/channels/twilio.ts');

// ── STOP ────────────────────────────────────────────────────────────────────

test('carrier stop words, whole message, any case, trailing punctuation', () => {
  for (const s of ['STOP', 'stop', ' Stop. ', 'STOPALL', 'unsubscribe', 'Cancel', 'END', 'quit!', 'REVOKE', 'optout', '"stop"']) {
    assert.equal(T.isStopCommand(s), true, s);
  }
});

test('plain requests to stop', () => {
  for (const s of ['please stop', 'Stop texting me.', 'remove me', 'Remove me from your list', 'take me off your list', 'Unsubscribe me please', 'stop please', 'Please stop!!', 'don\u2019t text me']) {
    assert.equal(T.isStopCommand(s), true, s);
  }
});

test('real opt-outs the whole-message rule missed', () => {
  for (const s of [
    'STOP \u{1F6D1}',
    'STOP. Who is this?',
    'Stop texting me, thanks',
    'Not interested, stop',
    'opt-out',
    'opt out',
    'stop all',
    'STOP\u200B',
    '\uFF33\uFF34\uFF2F\uFF30',
  ]) {
    assert.equal(T.isStopCommand(s), true, JSON.stringify(s));
  }
});

test('ordinary sentences are NOT opt-outs', () => {
  for (const s of [
    'Cancel my Thursday slot, can we do Friday',
    'End of the month works',
    "I can't stop thinking about that idea you mentioned for our dispatch board",
    'We stop taking calls at 5',
    'Quit worrying, Thursday is fine',
    'Quit calling it a lead, I am a customer',
    'stop, actually wait, is it 1:30 or 2?',
    'Please stop by',
    '',
    '   ',
    '\u{1F6D1}',
  ]) {
    assert.equal(T.isStopCommand(s), false, JSON.stringify(s));
  }
});

// ── Voice ───────────────────────────────────────────────────────────────────

test('voice forward: no callerId, so Griffin sees the real caller; the number is escaped', () => {
  const saved = process.env.JORDAN_FORWARD_TO;
  process.env.JORDAN_FORWARD_TO = '+19705550101';
  try {
    const xml = T.voiceForwardTwiML();
    assert.doesNotMatch(xml, /callerId/i);
    assert.match(xml, /<Dial>\+19705550101<\/Dial>/);
    process.env.JORDAN_FORWARD_TO = '+1970<Hangup/>&';
    assert.match(T.voiceForwardTwiML(), /<Dial>\+1970&lt;Hangup\/&gt;&amp;<\/Dial>/);
  } finally {
    if (saved === undefined) delete process.env.JORDAN_FORWARD_TO;
    else process.env.JORDAN_FORWARD_TO = saved;
  }
});

test('voice with no forwarding number tells the caller to text instead', () => {
  const saved = process.env.JORDAN_FORWARD_TO;
  delete process.env.JORDAN_FORWARD_TO;
  try {
    const xml = T.voiceForwardTwiML();
    assert.doesNotMatch(xml, /<Dial/);
    assert.match(xml, /<Say[^>]*>[^<]*send a text to this number[^<]*<\/Say>/);
    assert.doesNotMatch(xml, /[—–]/);
  } finally {
    if (saved !== undefined) process.env.JORDAN_FORWARD_TO = saved;
  }
});

test('escapeXml escapes all five', () => {
  assert.equal(T.escapeXml(`a&b<c>d"e'f`), 'a&amp;b&lt;c&gt;d&quot;e&apos;f');
});

// ── Signature ───────────────────────────────────────────────────────────────

// Twilio's published example, https://www.twilio.com/docs/usage/security
// (read 2026-09-30): this URL, these POST params, auth token 12345.
const DOC_URL = 'https://example.com/myapp.php?foo=1&bar=2';
const DOC_PARAMS = {
  CallSid: 'CA1234567890ABCDE',
  Caller: '+14158675310',
  Digits: '1234',
  From: '+14158675310',
  To: '+18005551212',
};
const DOC_TOKEN = '12345';
const DOC_SIGNATURE = 'L/OH5YylLD5NRKLltdqwSvS0BnU=';

test('reproduces Twilio\'s published signature example', () => {
  assert.equal(T.twilioSignature(DOC_URL, DOC_PARAMS, DOC_TOKEN), DOC_SIGNATURE);
  assert.equal(T.verifyTwilioSignature(DOC_URL, DOC_PARAMS, DOC_SIGNATURE, DOC_TOKEN), true);
  // Same params as a form body, in a different order.
  const form = new URLSearchParams([['To', '+18005551212'], ['Digits', '1234'], ['From', '+14158675310'], ['Caller', '+14158675310'], ['CallSid', 'CA1234567890ABCDE']]);
  assert.equal(T.verifyTwilioSignature(DOC_URL, form, DOC_SIGNATURE, DOC_TOKEN), true);
});

test('sorts keys in code-unit order (capitals first), matching a self-computed HMAC', () => {
  const url = 'https://app.example.com/api/sms/inbound';
  const params = { body: 'lower', Body: 'Upper', To: '+19705550101', From: '+19705550102' };
  // Code-unit order: Body, From, To, body. localeCompare would put body first.
  const expected = createHmac('sha1', 'tok').update(`${url}BodyUpperFrom+19705550102To+19705550101bodylower`).digest('base64');
  assert.equal(T.twilioSignature(url, params, 'tok'), expected);
  assert.equal(T.verifyTwilioSignature(url, params, expected, 'tok'), true);
});

test('negative cases: tampered param, wrong token, wrong URL, empty inputs', () => {
  assert.equal(T.verifyTwilioSignature(DOC_URL, { ...DOC_PARAMS, Digits: '1235' }, DOC_SIGNATURE, DOC_TOKEN), false);
  assert.equal(T.verifyTwilioSignature(DOC_URL, { ...DOC_PARAMS, Extra: 'x' }, DOC_SIGNATURE, DOC_TOKEN), false);
  assert.equal(T.verifyTwilioSignature(DOC_URL, DOC_PARAMS, DOC_SIGNATURE, '54321'), false);
  assert.equal(T.verifyTwilioSignature('https://example.com/myapp.php?foo=1&bar=3', DOC_PARAMS, DOC_SIGNATURE, DOC_TOKEN), false);
  assert.equal(T.verifyTwilioSignature('http://example.com/myapp.php?foo=1&bar=2', DOC_PARAMS, DOC_SIGNATURE, DOC_TOKEN), false);
  assert.equal(T.verifyTwilioSignature(DOC_URL, DOC_PARAMS, '', DOC_TOKEN), false);
  assert.equal(T.verifyTwilioSignature(DOC_URL, DOC_PARAMS, DOC_SIGNATURE, ''), false);
  assert.equal(T.verifyTwilioSignature(DOC_URL, DOC_PARAMS, 'short', DOC_TOKEN), false);
});

test('isCarrierKeyword: only a message that IS a carrier opt-out keyword', () => {
  for (const t of ['STOP', 'stop.', 'Cancel', 'UNSUBSCRIBE', ' end! ', 'Quit', 'stopall', 'optout', 'revoke']) assert.equal(T.isCarrierKeyword(t), true, t);
  for (const t of ['please stop texting me', 'remove me', 'STOP. Who is this?', 'cancel my thursday slot', 'take me off your list']) {
    assert.equal(T.isCarrierKeyword(t), false, t);
  }
});

// ── Account SID env name ────────────────────────────────────────────────────
// Griffin stored the SID in Vercel as TWILIO_ACCOUNT_ID (30 Sep). The code
// reads TWILIO_ACCOUNT_SID first and falls back to TWILIO_ACCOUNT_ID.

async function withTwilioEnv(env, fn) {
  const keys = ['TWILIO_ACCOUNT_SID', 'TWILIO_ACCOUNT_ID', 'TWILIO_AUTH_TOKEN', 'TWILIO_JORDAN_NUMBER'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, env);
  try { return await fn(); } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

async function sentUrl() {
  const realFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, init) => { seen = { url: String(url), auth: init.headers.Authorization }; return new Response(JSON.stringify({ sid: 'SMx' }), { status: 201 }); };
  try { await T.sendSMS('+19705550199', 'hi'); } finally { globalThis.fetch = realFetch; }
  return seen;
}

test('account SID: TWILIO_ACCOUNT_ID alone is enough', async () => {
  await withTwilioEnv({ TWILIO_ACCOUNT_ID: 'ACfromid', TWILIO_AUTH_TOKEN: 'tok', TWILIO_JORDAN_NUMBER: '+19705550100' }, async () => {
    assert.equal(T.twilioAccountSid(), 'ACfromid');
    assert.equal(T.twilioConfigured(), true);
    const s = await sentUrl();
    assert.match(s.url, /\/Accounts\/ACfromid\/Messages\.json$/);
    assert.equal(s.auth, 'Basic ' + Buffer.from('ACfromid:tok').toString('base64'));
  });
});

test('account SID: TWILIO_ACCOUNT_SID wins when both are set', async () => {
  await withTwilioEnv({ TWILIO_ACCOUNT_SID: 'ACfromsid', TWILIO_ACCOUNT_ID: 'ACfromid', TWILIO_AUTH_TOKEN: 'tok' }, async () => {
    assert.equal(T.twilioAccountSid(), 'ACfromsid');
    assert.match((await sentUrl()).url, /\/Accounts\/ACfromsid\//);
  });
});

test('account SID: blank SID falls back to ID; neither set means not configured', async () => {
  await withTwilioEnv({ TWILIO_ACCOUNT_SID: '  ', TWILIO_ACCOUNT_ID: 'ACfromid', TWILIO_AUTH_TOKEN: 'tok' }, async () => {
    assert.equal(T.twilioAccountSid(), 'ACfromid');
  });
  await withTwilioEnv({ TWILIO_AUTH_TOKEN: 'tok' }, async () => {
    assert.equal(T.twilioAccountSid(), '');
    assert.equal(T.twilioConfigured(), false);
    await assert.rejects(T.sendSMS('+19705550199', 'hi'), /not configured/);
  });
  await withTwilioEnv({ TWILIO_ACCOUNT_ID: 'ACfromid' }, async () => {
    assert.equal(T.twilioConfigured(), false);
  });
});
