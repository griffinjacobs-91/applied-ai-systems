// Run: node --experimental-strip-types --test test/credential-probes.test.mjs
// The credential endpoint Mission Control's watchdog calls.
//
// Two-sided proof: every probe is driven green on a good answer AND red on a
// bad one, because a probe that cannot go red is a false positive that kills
// its alarm. The gate is proven to refuse before any probe runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  anthropic, openrouter, gemini, stripe, apify, slack, resend, twilio, googleRefresh, alpacaPaper, supabase,
  runProbes, probeAuthorized, credentialHealthReport,
} from '../src/credential-probes.ts';

const envOf = (o) => (n) => o[n];
const reply = (status, body) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const one = async (probe, env, fetchImpl) => (await runProbes([probe], envOf(env), { fetchImpl }))[0];

const cases = [
  ['anthropic', anthropic, { ANTHROPIC_API_KEY: 'k' }, reply(200, {}), reply(400, { error: { message: 'Your credit balance is too low' } })],
  ['openrouter', openrouter, { OPENROUTER_API_KEY: 'k' }, reply(200, { data: { total_credits: 100, total_usage: 10 } }), reply(401, 'no')],
  ['gemini', gemini, { GEMINI_API_KEY: 'k' }, reply(200, {}), reply(400, 'API key not valid')],
  ['stripe', stripe, { STRIPE_SECRET_KEY: 'k', STRIPE_WEBHOOK_SECRET: 'w' }, reply(200, {}), reply(401, 'bad')],
  ['apify', apify, { APIFY_TOKEN: 'k' }, reply(200, {}), reply(401, 'bad')],
  ['slack', slack, { SLACK_BOT_TOKEN: 'k' }, reply(200, { ok: true, team: 't' }), reply(200, { ok: false, error: 'invalid_auth' })],
  ['resend', resend('FROM', undefined), { RESEND_API_KEY: 'k', FROM: 'a@b.co' }, reply(422, { message: 'Invalid `to` field' }), reply(401, 'API key is invalid')],
  ['twilio', twilio, { TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't' }, reply(200, { balance: '40.1', currency: 'USD' }), reply(401, 'bad')],
  ['google', googleRefresh('gmail', 'Gmail', { id: 'I', secret: 'S', refresh: 'R' }), { I: 'i', S: 's', R: 'r' }, reply(200, {}), reply(400, { error: 'invalid_grant' })],
  ['alpaca', alpacaPaper, { ALPACA_PAPER_KEY: 'k', ALPACA_PAPER_SECRET: 's' }, reply(200, { status: 'ACTIVE' }), reply(403, 'forbidden')],
  ['supabase', supabase, { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_x' }, reply(200, {}), reply(401, 'bad')],
];

for (const [label, probe, env, good, bad] of cases) {
  test(`${label}: green on a good answer, red on a bad one, unconfigured with nothing set`, async () => {
    assert.equal((await one(probe, env, good)).status, 'alive');
    assert.equal((await one(probe, env, bad)).status, 'dead');
    assert.equal((await one(probe, {}, good)).status, 'unconfigured');
  });
}

test('a vendor 5xx or a network failure is unknown, never dead', async () => {
  assert.equal((await one(stripe, { STRIPE_SECRET_KEY: 'k' }, reply(503, 'down'))).status, 'unknown');
  assert.equal((await one(stripe, { STRIPE_SECRET_KEY: 'k' }, async () => { throw new Error('ECONNRESET'); })).status, 'unknown');
});

test('balances warn early: OpenRouter low, Stripe without webhook secret low, Twilio low', async () => {
  const or = await one(openrouter, { OPENROUTER_API_KEY: 'k' }, reply(200, { data: { total_credits: 30, total_usage: 20 } }));
  assert.equal(or.status, 'low');
  assert.equal(or.balance, 10);
  assert.equal((await one(stripe, { STRIPE_SECRET_KEY: 'k' }, reply(200, {}))).status, 'low');
  assert.equal((await one(twilio, { TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't' }, reply(200, { balance: '2.00', currency: 'USD' }))).status, 'low');
});

test('OpenRouter accepts the legacy PERPLEXITY_API_KEY only when it is an sk-or- key', async () => {
  const ok = reply(200, { data: { total_credits: 100, total_usage: 0 } });
  assert.equal((await one(openrouter, { PERPLEXITY_API_KEY: 'sk-or-abc' }, ok)).status, 'alive');
  assert.equal((await one(openrouter, { PERPLEXITY_API_KEY: 'pplx-abc' }, ok)).status, 'unconfigured');
});

test('Resend never reports green when send authority was not exercised', async () => {
  assert.equal((await one(resend('FROM'), { RESEND_API_KEY: 'k' }, reply(422, 'to'))).status, 'low');
  assert.equal((await one(resend('FROM', 'x@y.co'), { RESEND_API_KEY: 'k' }, reply(403, 'The domain is not verified'))).status, 'dead');
  assert.equal((await one(resend('FROM', 'x@y.co'), { RESEND_API_KEY: 'k' }, reply(200, { id: 'e' }))).status, 'unknown');
});

test('Supabase: a new secret key never rides Authorization; a legacy JWT does', async () => {
  let seen;
  const capture = async (_u, init) => { seen = init.headers; return new Response('{}'); };
  await one(supabase, { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_x' }, capture);
  assert.equal(seen.authorization, undefined);
  await one(supabase, { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'eyJabc' }, capture);
  assert.equal(seen.authorization, 'Bearer eyJabc');
});

test('a hung vendor times out as unknown', async () => {
  const hang = (_u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
  const [r] = await runProbes([apify], envOf({ APIFY_TOKEN: 'k' }), { fetchImpl: hang, timeoutMs: 20 });
  assert.equal(r.status, 'unknown');
});

test('the gate: refuses a wrong, missing or unconfigured secret before any probe runs', async () => {
  let called = 0;
  const fetchImpl = async () => { called++; return new Response('{}'); };
  const opts = (env) => ({ app: 'x', probes: [apify], env: envOf({ APIFY_TOKEN: 'k', ...env }), fetchImpl });
  assert.equal((await credentialHealthReport('Bearer nope', opts({ HEALTH_PROBE_SECRET: 's' }))).status, 401);
  assert.equal((await credentialHealthReport(null, opts({ HEALTH_PROBE_SECRET: 's' }))).status, 401);
  assert.equal((await credentialHealthReport('Bearer ', opts({}))).status, 401);
  assert.equal(called, 0);
  const ok = await credentialHealthReport('Bearer s', opts({ HEALTH_PROBE_SECRET: 's' }));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.app, 'x');
  assert.equal(ok.body.probes[0].key, 'apify');
  assert.equal(probeAuthorized('Bearer s', 's'), true);
});

test('no key value ever appears in the report', async () => {
  const secret = 'sk-live-SHOULD-NOT-LEAK';
  const r = await credentialHealthReport('Bearer s', {
    app: 'x', probes: [stripe], env: envOf({ HEALTH_PROBE_SECRET: 's', STRIPE_SECRET_KEY: secret }),
    fetchImpl: reply(401, `Invalid API Key provided: ${secret}`),
  });
  // Vendors echo keys in error bodies; the detail must not carry it through.
  assert.ok(!JSON.stringify(r.body).includes(secret));
});
