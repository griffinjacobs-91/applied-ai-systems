// SELF-TEST FOR THE CREDENTIAL HEALTH PROBE'S CLASSIFIER.
//
// THIS TESTS THE CLASSIFIER, NOT THE KEYS. Every answer below is synthetic and
// served by a stub fetch; a green run says nothing about whether any key is
// alive. The live half is `gh workflow run credential-health.yml` (green) and
// the same with force_fail=true (must go red on a refused secret).
//
// OFFLINE: no network requests. The runner's network guard would throw on one.
//
// Run:  node scripts/credential-health-probe-test.mjs

import { EXIT, judge, observe, run, worst } from "./credential-health-probe.mjs";

let pass = 0;
let fail = 0;

function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const answer = (status, body) => async () =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
const probes = (...ps) => ({ app: "x", checked_at: "2026-10-28T00:00:00Z", probes: ps });
const T = { app: "x", url: "http://stub.invalid/api/health/credentials" };

console.log("1. every key alive is green; one dead key is red");
{
  const ok = judge(await observe(T, "s", answer(200, probes({ key: "anthropic", status: "alive" }))));
  check("all alive → green", ok.level === "green", JSON.stringify(ok));
  const dead = judge(await observe(T, "s", answer(200, probes({ key: "anthropic", status: "alive" }, { key: "stripe", status: "dead", detail: "HTTP 401" }))));
  check("one dead → red", dead.level === "red", JSON.stringify(dead));
  check("…and the line names the key", dead.lines.some((l) => l.includes("x:stripe DEAD")), dead.lines.join(" | "));
}

console.log("2. unknown, low and unconfigured never page");
{
  for (const status of ["unknown", "low", "unconfigured"]) {
    const v = judge(await observe(T, "s", answer(200, probes({ key: "k", status }))));
    check(`${status} → green`, v.level === "green", JSON.stringify(v));
  }
}

console.log("3. a refused secret or a missing endpoint is red; no answer is inconclusive");
{
  check("401 → red", judge(await observe(T, "s", answer(401, "no"))).level === "red");
  check("403 → red", judge(await observe(T, "s", answer(403, "no"))).level === "red");
  const sso = judge(await observe(T, "s", answer(401, "<!doctype html><html>Authentication Required</html>")));
  check("401 HTML page → red, named as blocked upstream", sso.level === "red" && sso.lines[0].includes("blocked before the app"), sso.lines[0]);
  check("404 → red", judge(await observe(T, "s", answer(404, "nf"))).level === "red");
  check("503 → inconclusive", judge(await observe(T, "s", answer(503, "down"))).level === "inconclusive");
  check("200 not JSON → inconclusive", judge(await observe(T, "s", answer(200, "<html>"))).level === "inconclusive");
  const net = judge(await observe(T, "s", async () => { throw new Error("ECONNRESET"); }));
  check("network failure → inconclusive", net.level === "inconclusive", JSON.stringify(net));
}

console.log("4. the secret travels as a bearer header");
{
  let seen;
  await observe(T, "sekret", async (_u, init) => { seen = init.headers.authorization; return new Response("{}"); });
  check("Authorization: Bearer <secret>", seen === "Bearer sekret", String(seen));
}

console.log("5. worst() and run()");
{
  check("red beats inconclusive", worst(["green", "inconclusive", "red"]) === "red");
  check("inconclusive beats green", worst(["green", "inconclusive"]) === "inconclusive");
  check("no secret → inconclusive exit", (await run({}, answer(200, probes()))) === EXIT.inconclusive);
  const allGreen = await run({ HEALTH_PROBE_SECRET: "s", HEALTH_TARGETS: "x=http://stub.invalid/api/health/credentials" }, answer(200, probes({ key: "k", status: "alive" })));
  check("all endpoints green → exit 0", allGreen === EXIT.green, String(allGreen));
  let sent;
  const forced = await run({ HEALTH_PROBE_SECRET: "s", FORCE_FAIL: "true", HEALTH_TARGETS: "x=http://stub.invalid/api/health/credentials" }, async (_u, init) => {
    sent = init.headers.authorization;
    return new Response("unauthorized", { status: 401 });
  });
  check("FORCE_FAIL sends a wrong secret, not the real one", sent !== "Bearer s", String(sent));
  check("FORCE_FAIL on a closed gate → exit 1", forced === EXIT.red, String(forced));
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);
