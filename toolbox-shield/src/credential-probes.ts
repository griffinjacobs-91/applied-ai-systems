// credential-probes.ts — this app's half of Mission Control's credential watch.
//
// Mission Control's credential-health cron (mission-control-hub,
// src/pages/api/cron/credential-health.ts) probes MC's own keys every 30
// minutes and pages on a transition. This app holds its OWN copies of several
// of the same providers, and until now nothing checked them. MC now calls
//
//   GET /api/health/credentials   Authorization: Bearer $HEALTH_PROBE_SECRET
//
// on each tick and stores these verdicts as `<app>:<key>` rows beside its own.
// Only verdicts leave this app. Key values never do, not even a prefix.
//
// The probe rules are MC's (src/lib/health/credentials.ts), each one paid for:
//   1. Read-only and cheap. The Anthropic probe is the one exception: one output
//      token, because it is the only call that catches an empty balance.
//   2. 'unknown' is not 'dead'. A timeout, a network blip or a vendor 5xx means
//      the PROBE failed. Only an authoritative rejection is 'dead'.
//   3. Balances, not just validity, where the vendor exposes one.
//   4. Probe the capability that matters (Resend: can it SEND, not can it read).
//
// Deliberately NOT probed here: metered APIs whose plan a 30-minute probe would
// eat (RapidAPI at 500 calls a month, Alpha Vantage at 25 a day), and anything
// that would mint or send for real.
//
// The same file ships in Legwork, Praxis and Tenfold; only the list each route
// passes in differs. Pure: env and fetch are injected, so the tests drive both
// sides of every probe.

import { createHash, timingSafeEqual } from 'node:crypto';

export type CredStatus = 'alive' | 'dead' | 'low' | 'unconfigured' | 'unknown';

export interface ProbeResult {
  status: CredStatus;
  detail: string;
  balance?: number | null;
  balance_unit?: string | null;
}

export type Env = (name: string) => string | undefined;
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface Ctx {
  env: Env;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

export interface CredentialProbe {
  key: string;
  name: string;
  critical: boolean;
  run: (ctx: Ctx) => Promise<ProbeResult>;
}

const DEFAULT_TIMEOUT_MS = 25_000;
const OPENROUTER_LOW_USD = 25;

const unconfigured = (vars: string): ProbeResult => ({ status: 'unconfigured', detail: `not set: ${vars}` });

function classify(res: Response, body: string): ProbeResult {
  if (res.ok) return { status: 'alive', detail: `HTTP ${res.status}` };
  if (res.status === 401 || res.status === 403) return { status: 'dead', detail: `HTTP ${res.status}: ${body.slice(0, 120)}` };
  return { status: 'unknown', detail: `HTTP ${res.status}: ${body.slice(0, 120)}` };
}

const textOf = async (res: Response) => await res.text().catch(() => '');

function first(env: Env, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = env(n)?.trim();
    if (v) return v;
  }
  return undefined;
}

// ---------------------------------------------------------------- the probes

export const anthropic: CredentialProbe = {
  key: 'anthropic',
  name: 'Anthropic',
  critical: true,
  async run({ env, fetch }) {
    const key = first(env, 'ANTHROPIC_API_KEY');
    if (!key) return unconfigured('ANTHROPIC_API_KEY');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
    });
    const body = await textOf(res);
    if (res.ok) return { status: 'alive', detail: 'messages reachable' };
    if (/credit balance is too low/i.test(body)) {
      return { status: 'dead', detail: 'CREDIT BALANCE EXHAUSTED', balance: 0, balance_unit: 'usd' };
    }
    return classify(res, body);
  },
};

export const openrouter: CredentialProbe = {
  key: 'openrouter',
  name: 'OpenRouter',
  critical: true,
  async run({ env, fetch }) {
    // PERPLEXITY_API_KEY holds an OpenRouter key on this fleet; accept it only
    // when it looks like one.
    const legacy = first(env, 'PERPLEXITY_API_KEY');
    const key = first(env, 'OPENROUTER_API_KEY') ?? (legacy?.startsWith('sk-or-') ? legacy : undefined);
    if (!key) return unconfigured('OPENROUTER_API_KEY');
    const res = await fetch('https://openrouter.ai/api/v1/credits', { headers: { authorization: `Bearer ${key}` } });
    const body = await textOf(res);
    if (!res.ok) return classify(res, body);
    const data = JSON.parse(body) as { data?: { total_credits?: number; total_usage?: number } };
    const remaining = Number((Number(data?.data?.total_credits ?? 0) - Number(data?.data?.total_usage ?? 0)).toFixed(2));
    if (remaining <= 0) return { status: 'dead', detail: 'balance exhausted', balance: remaining, balance_unit: 'usd' };
    if (remaining < OPENROUTER_LOW_USD) return { status: 'low', detail: `$${remaining} left`, balance: remaining, balance_unit: 'usd' };
    return { status: 'alive', detail: `$${remaining} left`, balance: remaining, balance_unit: 'usd' };
  },
};

export const gemini: CredentialProbe = {
  key: 'gemini',
  name: 'Gemini',
  critical: false,
  async run({ env, fetch }) {
    const key = first(env, 'GEMINI_API_KEY');
    if (!key) return unconfigured('GEMINI_API_KEY');
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`);
    const body = await textOf(res);
    // Google answers a bad key with 400 INVALID_ARGUMENT, not 401.
    if (!res.ok && /API key not valid|API_KEY_INVALID/i.test(body)) return { status: 'dead', detail: 'Google rejects the key' };
    return classify(res, body);
  },
};

export const stripe: CredentialProbe = {
  key: 'stripe',
  name: 'Stripe',
  critical: true,
  async run({ env, fetch }) {
    const key = first(env, 'STRIPE_SECRET_KEY', 'STRIPE_API_KEY_SECRET_2');
    if (!key) return unconfigured('STRIPE_SECRET_KEY');
    const res = await fetch('https://api.stripe.com/v1/balance', { headers: { authorization: `Bearer ${key}` } });
    const out = classify(res, await textOf(res));
    if (out.status !== 'alive') return out;
    // A live key with no webhook secret still cannot confirm a payment.
    return first(env, 'STRIPE_WEBHOOK_SECRET')
      ? { status: 'alive', detail: 'key + webhook secret both set' }
      : { status: 'low', detail: 'key is live but STRIPE_WEBHOOK_SECRET is empty' };
  },
};

export const apify: CredentialProbe = {
  key: 'apify',
  name: 'Apify',
  critical: false,
  async run({ env, fetch }) {
    const token = first(env, 'APIFY_TOKEN', 'APIFY_API_TOKEN');
    if (!token) return unconfigured('APIFY_TOKEN');
    const res = await fetch('https://api.apify.com/v2/users/me', { headers: { authorization: `Bearer ${token}` } });
    return classify(res, await textOf(res));
  },
};

export const slack: CredentialProbe = {
  key: 'slack',
  name: 'Slack',
  critical: false,
  async run({ env, fetch }) {
    const token = first(env, 'SLACK_BOT_TOKEN');
    if (!token) return unconfigured('SLACK_BOT_TOKEN');
    const res = await fetch('https://slack.com/api/auth.test', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    const body = await textOf(res);
    if (!res.ok) return classify(res, body);
    // Slack answers 200 with { ok: false } on a bad token; only the envelope tells.
    const data = JSON.parse(body) as { ok?: boolean; team?: string; error?: string };
    if (data?.ok) return { status: 'alive', detail: `team ${data.team ?? '?'}` };
    if (/invalid_auth|not_authed|token_revoked|account_inactive/.test(data?.error ?? '')) return { status: 'dead', detail: `Slack: ${data?.error}` };
    return { status: 'unknown', detail: `Slack: ${data?.error ?? 'unknown'}` };
  },
};

/**
 * Resend, probed for SEND authority, not read access: a well-formed send to a
 * recipient that fails validation. Resend checks auth before payload, so the
 * error says which one it refused. Nothing can be delivered to "not-an-email".
 */
export function resend(fromVar: string, fallbackFrom?: string): CredentialProbe {
  return {
    key: 'resend',
    name: 'Resend',
    critical: true,
    async run({ env, fetch }) {
      const key = first(env, 'RESEND_API_KEY');
      if (!key) return unconfigured('RESEND_API_KEY');
      const from = first(env, fromVar) ?? fallbackFrom;
      if (!from) return { status: 'low', detail: `${fromVar} unset, so send authority is NOT verified` };
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: ['not-an-email'], subject: 'credential probe', text: 'credential probe' }),
      });
      const body = await textOf(res);
      if (res.ok) return { status: 'unknown', detail: 'Resend ACCEPTED an invalid recipient. Fix this probe.' };
      if (res.status === 401 || /api key is invalid|invalid api key|restricted/i.test(body)) return { status: 'dead', detail: 'Resend rejects the key' };
      if (/not verified|domain_not_found/i.test(body)) return { status: 'dead', detail: 'key is valid but the from-domain is NOT verified' };
      if (res.status === 429) return { status: 'unknown', detail: 'rate limited by Resend' };
      if (/to|recipient|email address|validation/i.test(body)) return { status: 'alive', detail: 'send authority confirmed' };
      return { status: 'unknown', detail: `unrecognised Resend reply: HTTP ${res.status} ${body.slice(0, 90)}` };
    },
  };
}

export const twilio: CredentialProbe = {
  key: 'twilio',
  name: 'Twilio',
  critical: false,
  async run({ env, fetch }) {
    const sid = first(env, 'TWILIO_ACCOUNT_SID', 'TWILIO_ACCOUNT_ID');
    const token = first(env, 'TWILIO_AUTH_TOKEN');
    if (!sid || !token) return unconfigured('TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN');
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Balance.json`, {
      headers: { authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}` },
    });
    const body = await textOf(res);
    if (!res.ok) return classify(res, body);
    const data = JSON.parse(body) as { balance?: string; currency?: string };
    const balance = Number(data?.balance);
    if (!Number.isFinite(balance)) return { status: 'alive', detail: 'account readable' };
    if (balance <= 0) return { status: 'dead', detail: 'balance exhausted', balance, balance_unit: data.currency ?? 'usd' };
    if (balance < 5) return { status: 'low', detail: `${balance} ${data.currency ?? ''} left`.trim(), balance, balance_unit: data.currency ?? 'usd' };
    return { status: 'alive', detail: `${balance} ${data.currency ?? ''} left`.trim(), balance, balance_unit: data.currency ?? 'usd' };
  },
};

/**
 * A Google OAuth refresh token. These die quietly (revoked, unused for months,
 * the test-mode 7-day expiry), and the first sign is a send that fails. The
 * exchange mints a short-lived access token and nothing else.
 */
export function googleRefresh(key: string, name: string, vars: { id: string; secret: string; refresh: string }): CredentialProbe {
  return {
    key,
    name,
    critical: false,
    async run({ env, fetch }) {
      const id = first(env, vars.id);
      const secret = first(env, vars.secret);
      const refresh = first(env, vars.refresh);
      if (!id || !secret || !refresh) return unconfigured(`${vars.id} + ${vars.secret} + ${vars.refresh}`);
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: id, client_secret: secret, refresh_token: refresh }).toString(),
      });
      const body = await textOf(res);
      if (res.ok) return { status: 'alive', detail: 'refresh token exchanges' };
      if (/invalid_grant|invalid_client|unauthorized_client/.test(body)) return { status: 'dead', detail: `Google: ${body.match(/"error":\s*"([^"]+)"/)?.[1] ?? 'rejected'}` };
      return classify(res, body);
    },
  };
}

export const alpacaPaper: CredentialProbe = {
  key: 'alpaca',
  name: 'Alpaca paper account',
  critical: true,
  async run({ env, fetch }) {
    const id = first(env, 'ALPACA_PAPER_KEY');
    const secret = first(env, 'ALPACA_PAPER_SECRET');
    if (!id || !secret) return unconfigured('ALPACA_PAPER_KEY + ALPACA_PAPER_SECRET');
    const res = await fetch('https://paper-api.alpaca.markets/v2/account', {
      headers: { 'APCA-API-KEY-ID': id, 'APCA-API-SECRET-KEY': secret },
    });
    const body = await textOf(res);
    if (!res.ok) return classify(res, body);
    const data = JSON.parse(body) as { status?: string };
    return data?.status === 'ACTIVE'
      ? { status: 'alive', detail: 'account ACTIVE' }
      : { status: 'dead', detail: `account status ${data?.status ?? 'missing'}` };
  },
};

export const supabase: CredentialProbe = {
  key: 'supabase',
  name: 'Supabase (server key)',
  critical: true,
  async run({ env, fetch }) {
    const url = first(env, 'SUPABASE_URL', 'PUBLIC_SUPABASE_URL');
    const key = first(env, 'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_KEY');
    if (!url || !key) return unconfigured('SUPABASE_URL + SUPABASE_SECRET_KEY');
    // Auth admin list with one row: only a server key may call it, so a
    // publishable key pasted into the secret slot reads as dead, not alive.
    const res = await fetch(`${url.replace(/\/$/, '')}/auth/v1/admin/users?per_page=1`, {
      // The new sb_secret_ keys go in `apikey` alone; only a legacy JWT
      // service_role key also rides Authorization.
      headers: key.startsWith('eyJ') ? { apikey: key, authorization: `Bearer ${key}` } : { apikey: key },
    });
    return classify(res, await textOf(res));
  },
};

// ---------------------------------------------------------------- the sweep

export async function runProbes(
  probes: CredentialProbe[],
  env: Env,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<Array<{ key: string; name: string; critical: boolean } & ProbeResult>> {
  const base = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return await Promise.all(
    probes.map(async (p) => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      // Every value a probe reads is remembered and scrubbed from its detail:
      // vendors echo the key they rejected in the error body, and that body is
      // what classify() quotes.
      const read: string[] = [];
      const tracked: Env = (n) => {
        const v = env(n);
        if (v && v.trim().length >= 6) read.push(v.trim());
        return v;
      };
      const scrub = (s: string) => read.reduce((acc, v) => acc.split(v).join('[redacted]'), s);
      const ctx: Ctx = { env: tracked, fetch: (u, i) => base(u, { ...i, signal: ctl.signal }) };
      try {
        const r = await p.run(ctx);
        return { key: p.key, name: p.name, critical: p.critical, balance: null, balance_unit: null, ...r, detail: scrub(r.detail) };
      } catch (e) {
        // A thrown probe is 'unknown' (the probe broke), never 'dead'.
        return {
          key: p.key, name: p.name, critical: p.critical,
          status: 'unknown' as const, detail: scrub(`probe failed: ${e instanceof Error ? e.message : String(e)}`),
          balance: null, balance_unit: null,
        };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}

/** Constant-time Bearer check. No secret configured means nobody gets in. */
export function probeAuthorized(header: string | null | undefined, secret: string | undefined): boolean {
  if (!secret || !header) return false;
  const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

/**
 * The whole endpoint, framework-free. Astro and Express routes both wrap this.
 * Refuses before any probe runs, so an unauthenticated caller can never spend
 * the Anthropic token or learn which keys are set.
 */
export async function credentialHealthReport(
  authHeader: string | null | undefined,
  opts: { app: string; probes: CredentialProbe[]; env: Env; fetchImpl?: FetchLike; timeoutMs?: number },
): Promise<{ status: number; body: unknown }> {
  if (!probeAuthorized(authHeader, opts.env('HEALTH_PROBE_SECRET'))) {
    return { status: 401, body: { error: 'unauthorized' } };
  }
  const probes = await runProbes(opts.probes, opts.env, opts);
  return { status: 200, body: { app: opts.app, checked_at: new Date().toISOString(), probes } };
}
