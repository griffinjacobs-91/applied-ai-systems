'use strict';
// Runs the handler in-process with a fake fetch. `node --test test/` from the repo root.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeHandler, _test } = require('../api/ask.js');

function fakeReq({ method = 'POST', body, ip = '203.0.113.9', headers = {} } = {}) {
  return { method, body, headers: { 'x-forwarded-for': ip, ...headers }, socket: { remoteAddress: ip } };
}
function fakeRes() {
  const r = { statusCode: 200, headers: {}, body: '' };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.end = (b) => { r.body = b || ''; r.ended = true; };
  return r;
}
// A fetch stub: /key answers with the given usage, /chat/completions answers with a fixed text.
function fakeFetch({ usage = 0.01, keyStatus = 200, answer = 'A commit is a saved snapshot. It is like the photo you take of the whiteboard. The glossary word is Commit.', cost = 0.0004, chatStatus = 200 } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/key')) return { ok: keyStatus === 200, status: keyStatus, json: async () => ({ data: { usage_monthly: usage, usage } }) };
    if (url.endsWith('/chat/completions')) {
      return { ok: chatStatus === 200, status: chatStatus, json: async () => ({ model: _test.MODEL, choices: [{ message: { content: answer } }], usage: { prompt_tokens: 900, completion_tokens: 60, cost } }) };
    }
    throw new Error('unexpected url ' + url);
  };
  fn.calls = calls;
  return fn;
}
const goodBody = { lesson: 'commits', title: 'Commits', question: 'What is a commit?', project: 'Daily Dog', context: 'A commit is a saved snapshot of your files.', terms: ['Commit', 'Repository'] };

function reset() { _test.state.ipDay.clear(); _test.state.spentUsd = 0; }

test('HEAD answers 204 so the page detects the endpoint', async () => {
  const h = makeHandler({ fetch: fakeFetch(), env: {}, log: () => {} });
  const res = fakeRes(); await h(fakeReq({ method: 'HEAD' }), res);
  assert.equal(res.statusCode, 204);
});

test('GET answers 405 with a plain-text hint', async () => {
  const h = makeHandler({ fetch: fakeFetch(), env: {}, log: () => {} });
  const res = fakeRes(); await h(fakeReq({ method: 'GET' }), res);
  assert.equal(res.statusCode, 405);
  assert.match(res.body, /POST a JSON body/);
});

test('bad bodies answer 400', async () => {
  const h = makeHandler({ fetch: fakeFetch(), env: { OPENROUTER_API_KEY: 'k' }, log: () => {} });
  for (const body of [undefined, 'not json', {}, { question: '' }, { question: 'x'.repeat(201) }, [1]]) {
    const res = fakeRes(); await h(fakeReq({ body }), res);
    assert.equal(res.statusCode, 400, `body ${JSON.stringify(body)}`);
  }
});

test('with no key Pip is offline: 403 and the email message, no network call', async () => {
  reset();
  const f = fakeFetch();
  const h = makeHandler({ fetch: f, env: {}, log: () => {} });
  const res = fakeRes(); await h(fakeReq({ body: goodBody }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body, _test.OFFLINE_TEXT);
  assert.equal(f.calls.length, 0);
});

test('happy path: 200 JSON {text}, the model is pinned, cost is logged', async () => {
  reset();
  const f = fakeFetch();
  const lines = [];
  const h = makeHandler({ fetch: f, env: { OPENROUTER_API_KEY: 'k' }, log: (l) => lines.push(l) });
  const res = fakeRes(); await h(fakeReq({ body: goodBody }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.match(JSON.parse(res.body).text, /^A commit is a saved snapshot/);
  const chat = f.calls.find((c) => c.url.endsWith('/chat/completions'));
  const sent = JSON.parse(chat.init.body);
  assert.equal(sent.model, 'anthropic/claude-haiku-5.5');
  assert.equal(sent.max_tokens, 220);
  assert.equal(sent.messages[0].content, _test.SYSTEM_PROMPT);
  assert.match(sent.messages[1].content, /Reader's question: What is a commit\?/);
  assert.match(sent.messages[1].content, /Commit, Repository/);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].outcome, 'answered');
  assert.equal(lines[0].costUsd, 0.0004);
  assert.equal(lines[0].ip.length, 12);
  assert.ok(!JSON.stringify(lines[0]).includes('203.0.113.9'), 'raw IP must not be logged');
});

test(`per-IP limit: request ${_test.DAILY_PER_IP + 1} in a day answers 429, another IP still answers`, async () => {
  reset();
  const f = fakeFetch();
  const h = makeHandler({ fetch: f, env: { OPENROUTER_API_KEY: 'k' }, log: () => {} });
  for (let i = 1; i <= _test.DAILY_PER_IP; i++) {
    const res = fakeRes(); await h(fakeReq({ body: goodBody }), res);
    assert.equal(res.statusCode, 200, `request ${i}`);
  }
  const modelCallsBefore = f.calls.filter((c) => c.url.endsWith('/chat/completions')).length;
  const over = fakeRes(); await h(fakeReq({ body: goodBody }), over);
  assert.equal(over.statusCode, 429);
  assert.equal(over.body, _test.LIMIT_TEXT);
  assert.equal(f.calls.filter((c) => c.url.endsWith('/chat/completions')).length, modelCallsBefore, 'no model call when limited');
  const other = fakeRes(); await h(fakeReq({ body: goodBody, ip: '198.51.100.4' }), other);
  assert.equal(other.statusCode, 200);
});

test('per-IP limit resets on the next UTC day', async () => {
  reset();
  let t = Date.parse('2026-10-26T23:59:00Z');
  const h = makeHandler({ fetch: fakeFetch(), env: { OPENROUTER_API_KEY: 'k' }, log: () => {}, now: () => t });
  for (let i = 0; i < _test.DAILY_PER_IP; i++) { const r = fakeRes(); await h(fakeReq({ body: goodBody }), r); }
  let r = fakeRes(); await h(fakeReq({ body: goodBody }), r); assert.equal(r.statusCode, 429);
  t = Date.parse('2026-10-27T00:01:00Z');
  r = fakeRes(); await h(fakeReq({ body: goodBody }), r); assert.equal(r.statusCode, 200);
});

test('spend ceiling: OpenRouter reports usage at the ceiling, answer is 403 and no model call', async () => {
  reset();
  const f = fakeFetch({ usage: _test.MONTHLY_CEILING_USD });
  const lines = [];
  const h = makeHandler({ fetch: f, env: { OPENROUTER_API_KEY: 'k' }, log: (l) => lines.push(l) });
  const res = fakeRes(); await h(fakeReq({ body: goodBody }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body, _test.CEILING_TEXT);
  assert.equal(f.calls.filter((c) => c.url.endsWith('/chat/completions')).length, 0);
  assert.equal(lines[0].outcome, 'ceiling');
});

test('spend ceiling: this instance\'s own accumulated cost trips it even if the report lags', async () => {
  reset();
  const f = fakeFetch({ usage: 0, cost: _test.MONTHLY_CEILING_USD / 2 });
  const h = makeHandler({ fetch: f, env: { OPENROUTER_API_KEY: 'k' }, log: () => {} });
  let r = fakeRes(); await h(fakeReq({ body: goodBody, ip: '10.0.0.1' }), r); assert.equal(r.statusCode, 200);
  r = fakeRes(); await h(fakeReq({ body: goodBody, ip: '10.0.0.2' }), r); assert.equal(r.statusCode, 200);
  r = fakeRes(); await h(fakeReq({ body: goodBody, ip: '10.0.0.3' }), r); assert.equal(r.statusCode, 403);
});

test('usage report unreadable: fail closed with the offline text', async () => {
  reset();
  const f = fakeFetch({ keyStatus: 401 });
  const h = makeHandler({ fetch: f, env: { OPENROUTER_API_KEY: 'k' }, log: () => {} });
  const res = fakeRes(); await h(fakeReq({ body: goodBody }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body, _test.OFFLINE_TEXT);
  assert.equal(f.calls.filter((c) => c.url.endsWith('/chat/completions')).length, 0);
});

test('model error answers 502 plain text', async () => {
  reset();
  const h = makeHandler({ fetch: fakeFetch({ chatStatus: 500 }), env: { OPENROUTER_API_KEY: 'k' }, log: () => {} });
  const res = fakeRes(); await h(fakeReq({ body: goodBody }), res);
  assert.equal(res.statusCode, 502);
});
