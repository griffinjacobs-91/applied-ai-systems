// CREDENTIAL HEALTH PROBE — the daily watch on every app's API keys.
//
// ── WHAT IT ASKS ─────────────────────────────────────────────────────────────
// Legwork, Praxis and Tenfold each expose a credential endpoint
// (`/api/healthz/credentials` here, `/api/health/credentials` there) that runs
// a one-call probe per key against its OWN production env and answers verdicts
// only: { app, checked_at, probes: [{ key, name, critical, status, detail }] }.
// Key VALUES never leave the app that holds them. This script calls all three
// with the shared HEALTH_PROBE_SECRET and judges the answers.
//
// ── WHY HERE AND NOT MISSION CONTROL ─────────────────────────────────────────
// The first cut (2026-10-28) fanned these out from MCC's 30-minute cron. The
// operator ruled the same day that MCC is unused and the least-trusted repo, so
// it must not sit in the path of the apps that are used. This workflow is the
// daily watch; the Wednesday health routine reads its last seven runs.
//
// ── THE THREE OUTCOMES (same contract as the data-feed probe) ─────────────────
//   0 green         every endpoint answered and no key is dead.
//   1 RED           an endpoint answered and something is wrong: a key is dead,
//                   or the endpoint refused our secret (the secrets disagree, so
//                   every key in that app has gone unwatched).
//   2 INCONCLUSIVE  no observation: HEALTH_PROBE_SECRET unset here, or an
//                   endpoint unreachable / 5xx / not JSON. The MONITOR is down;
//                   this is not a detected key failure.
// A key reported `unknown` (vendor 5xx, timeout) is never red: a vendor having a
// bad day is not a dead key. `low` and `unconfigured` are printed, never red.
//
// Two-sided proof: FORCE_FAIL=true sends a deliberately wrong secret to the
// real endpoints, which must refuse it and exit 1. The self-test
// (credential-health-probe-test.mjs) drives every branch of judge() offline.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const EXIT = { green: 0, red: 1, inconclusive: 2 };

// Targets come from the environment, one per app: HEALTH_TARGETS is a
// comma-separated list of app=url pairs, set as a repository variable.
export function parseTargets(env = process.env) {
  return String(env.HEALTH_TARGETS || "")
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf("=");
      return { app: pair.slice(0, i), url: pair.slice(i + 1) };
    })
    .filter((t) => t.app && t.url);
}

const TIMEOUT_MS = 60_000;

/**
 * Ask one endpoint. Returns { app, http, probes } on an answer, or
 * { app, unreachable } when there was none. Never throws.
 */
export async function observe(target, secret, fetchImpl = fetch) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(target.url, { headers: { authorization: `Bearer ${secret}` }, signal: ctl.signal });
    const text = await res.text().catch(() => "");
    let probes = null;
    try {
      const body = JSON.parse(text);
      if (Array.isArray(body?.probes)) probes = body.probes;
    } catch {
      // not JSON; judged below
    }
    // Vercel Deployment Protection answers 401 with an HTML login page before
    // the app runs. That is not the app refusing our secret, so say which.
    const blockedUpstream = !probes && /<html/i.test(text);
    return { app: target.app, http: res.status, probes, blockedUpstream };
  } catch (e) {
    return { app: target.app, unreachable: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Pure: one observation in, a verdict out. */
export function judge(obs) {
  if (obs.unreachable) return { level: "inconclusive", lines: [`${obs.app}: unreachable (${obs.unreachable})`] };
  if ((obs.http === 401 || obs.http === 403) && obs.blockedUpstream) {
    return { level: "red", lines: [`${obs.app}: HTTP ${obs.http} HTML page, blocked before the app (Vercel deployment protection?); point HEALTH_URL_${obs.app.toUpperCase()} at a public domain`] };
  }
  if (obs.http === 401 || obs.http === 403) {
    return { level: "red", lines: [`${obs.app}: HTTP ${obs.http}, the endpoint rejects HEALTH_PROBE_SECRET (secrets differ, every key here is unwatched)`] };
  }
  if (obs.http === 404) {
    return { level: "red", lines: [`${obs.app}: HTTP 404, the credential endpoint is not deployed`] };
  }
  if (obs.http !== 200 || !obs.probes) {
    return { level: "inconclusive", lines: [`${obs.app}: HTTP ${obs.http}${obs.probes ? "" : ", no probes[] in the answer"}`] };
  }
  const lines = [];
  let level = "green";
  for (const p of obs.probes) {
    const tag = p.status === "dead" ? "DEAD" : p.status;
    lines.push(`${obs.app}:${p.key} ${tag}${p.detail ? ` (${String(p.detail).slice(0, 160)})` : ""}`);
    if (p.status === "dead") level = "red";
  }
  if (obs.probes.length === 0) lines.push(`${obs.app}: answered with zero probes`);
  return { level, lines };
}

/** Worst of a set of levels: red beats inconclusive beats green. */
export function worst(levels) {
  if (levels.includes("red")) return "red";
  if (levels.includes("inconclusive")) return "inconclusive";
  return "green";
}

export async function run(env = process.env, fetchImpl = fetch) {
  const forced = env.FORCE_FAIL === "true";
  const secret = forced ? "force-fail-deliberately-wrong-secret" : env.HEALTH_PROBE_SECRET;
  if (!secret) {
    console.log("INCONCLUSIVE: HEALTH_PROBE_SECRET is not set in this workflow, so no endpoint was asked.");
    return EXIT.inconclusive;
  }
  const targets = parseTargets(env).map((t) => ({ ...t, url: env[`HEALTH_URL_${t.app.toUpperCase()}`] || t.url }));
  if (!targets.length) {
    console.log("INCONCLUSIVE: HEALTH_TARGETS is empty, so there is nothing to ask.");
    return EXIT.inconclusive;
  }
  const verdicts = await Promise.all(targets.map(async (t) => judge(await observe(t, secret, fetchImpl))));
  for (const v of verdicts) for (const l of v.lines) console.log(`  ${v.level === "green" ? "·" : "!"} ${l}`);
  const level = worst(verdicts.map((v) => v.level));
  console.log(`\nverdict: ${level}`);
  return EXIT[level];
}

// Run when executed, stay inert when imported by the self-test. Biased toward
// RUNNING, same as mls-feed-probe.mjs.
function isRunningAsScript() {
  const entry = process.argv[1];
  if (!entry) return true;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return true;
  }
}

if (isRunningAsScript()) {
  const code = await run();
  if (code === EXIT.green && process.env.FORCE_FAIL === "true") {
    console.error("\nFORCE_FAIL sent a wrong secret and every endpoint accepted it. The gate is open; do not trust a green.");
    process.exit(1);
  }
  process.exit(code);
}
