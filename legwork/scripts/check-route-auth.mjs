// Mechanical authorization check: every HTTP route must be gated, or explicitly
// declared public with a reason.
//
// WHY THIS EXISTS
//   Authorization in this API is enforced INLINE, per handler: a route calls
//   requireOwnerCode() (or resolveGenerationOwner, or verifies a portal token, or
//   checks the internal secret) as its first act. That is the right shape — it is
//   server-side, it is re-evaluated on every request, and it never trusts the UI.
//
//   Its weakness is structural: the enforcement is a line of code someone has to
//   remember to write. Add a route and forget the line, and the endpoint ships
//   OPEN. Nothing fails. No test goes red. The default posture of a new route is
//   ALLOW, and that is exactly backwards.
//
//   This check inverts it. A new route is a build failure until it either carries
//   a recognised gate or is deliberately declared public with a stated reason. The
//   default becomes DENY-or-declare.
//
// HOW A ROUTE SATISFIES THE CHECK
//   Its handler body mentions one of the GATES below. That is a lexical check, not
//   a proof: it confirms the gate was CALLED, not that its result was obeyed.
//   Obeying it is review's job (and the fail-closed return shapes in lib/owner.ts
//   make ignoring the result awkward). The value here is catching the route that
//   has no gate at all, which is the failure that actually happens.
//
// DELIBERATELY PUBLIC ROUTES
//   Several endpoints are public on purpose: the sign-in surface itself, a health
//   probe, the county coverage copy, address autocomplete (it must fire on
//   keystroke before any auth exists), the pilot feedback writes, and the OAuth
//   provider callbacks (the provider redirects a browser there with a signed
//   state — there is no bearer to present yet). Those carry
//   `// auth-ok: <reason>` within 4 lines above the route.
//
//   The reason is REQUIRED. An unexplained public route is the thing this exists
//   to prevent, so silence is never the answer.
//
// WHICH REGISTRATION SHAPES ARE RECOGNISED
//   Express takes a path three ways and this repo writes all three. The
//   recogniser used to be a single regex that demanded a quoted string on the
//   SAME line as the paren, so two of the three were invisible — and invisible
//   here means uncounted, which means "all routes are gated" was a claim about
//   a subset. Measured 2026-09-15 on the live tree: seven registrations sat in
//   that blind spot, including POST /brief/start, the most expensive route in
//   the product. All seven were gated by hand, so nothing was open — but the
//   check that exists to notice the NEXT missing gate could not have seen it
//   there. A blind spot in a gate is worth more attention than a live hole,
//   because the hole is one mistake and the blind spot is every future one.
//
//     · router.get("/x", handler)                  one path, one line
//     · router.get(["/x", "/y"], handler)          an array of aliases
//     · router.post(\n  "/x",\n  mw,\n  handler)   path on a following line
//
//   COUNTING: a REGISTRATION is one route, counted once, however many paths it
//   declares. One registration is one handler and therefore one gate, and the
//   gate is what is being counted. A multi-path registration prints all of its
//   paths on its line, so nothing is hidden by the choice.
//
//   A registration whose path cannot be read is an ERROR, not a skip. Skipping
//   is the entire bug above: the route the recogniser does not understand is
//   exactly the route nobody is checking.
//
// WHAT THIS DOES NOT DO
//   It does not check that the gate's verdict is respected, that the right OWNER
//   is compared, or that a by-id read was scoped — that is what
//   check-tenancy-scope.mjs and review cover. Two narrow checks that each hold
//   beat one broad claim that does not.
//
// Usage: node scripts/check-route-auth.mjs
//   exit 0 = every route is gated or explicitly declared public
//   exit 1 = at least one is neither
//
// ─────────────────────────────────────────────────────────────────────────────
// PROVENANCE, for whoever finds this file interesting enough to open:
//
// This did not come from a security prompt asking for a checker. It came from
// prompts 23 and 26 of the vibecoder security audit ("enforce authorization on
// the server", "apply a default-deny access policy"), applied to a codebase where
// the answer to both was already YES — all 119 routes were gated, correctly, by
// hand.
//
// Which is the interesting failure. A pass on those two prompts would have been
// truthful and would have left the actual weakness untouched: nothing in this
// repo could tell you when route 120 shipped without a gate. The control was
// perfect and unenforced.
//
// So the deliverable stopped being "check the routes" and became "make the check
// impossible to forget". That reframing is worth more than the fix was, and it is
// the reason two of the three audits ended with a CI gate instead of a diff.
//
// The 16 `// auth-ok:` declarations elsewhere in the route tree are the other half
// of it. Each one is a sentence a human wrote about why an endpoint is safe to
// expose. They are the part that goes stale, and the part worth re-reading.
// ─────────────────────────────────────────────────────────────────────────────

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { stripSource } from "./lib/strip-source.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROUTES_DIR = join(ROOT, "artifacts", "api-server", "src", "routes");

/**
 * Identifiers that constitute a gate. Each one either returns a verified owner,
 * verifies a bearer, resolves a capability token to its owner, or checks a shared
 * machine secret.
 */
const GATES = [
  // ── Agent-side owner resolution ────────────────────────────────────────────
  "requireOwnerCode", // JWT or legacy code -> verified owner + RLS-scoped client
  "resolveGenerationOwner", // same, for the body-carried legacy code on /start
  // The composed licensed-data gate (lib/data-access.ts). Today it is reached only
  // THROUGH the two resolvers above, so no route mentions it by name and this
  // entry changes nothing. It is listed anyway, per route-auth-declare.md: the
  // rule is that a gate helper goes in this list in the commit that introduces
  // it, because the alternative is remembering to add it on the day some future
  // route calls it directly — at which point that route reads as ungated.
  "checkDataAccess",
  "requireJwtAccount", // integrations.ts: bearer -> verified account id
  "verifyAccessToken", // direct bearer verification
  "readBearerToken", // always paired with verifyAccessToken in this codebase
  // routes/brief.ts photo manifest (2026-10-19): owner Bearer or valid legacy
  // code, or a portal token / buyer claim whose share covers the brief; null
  // means the route answers the unknown-job 404.
  "resolvePhotoActor",
  // ── Shared per-file loaders that gate before returning a row ───────────────
  // These are the reason the check reads handler BODIES rather than requiring the
  // gate call to be literally inline: several files factor "resolve the caller,
  // then load the row they own, or 404" into one helper, and a route that calls
  // the helper and returns on falsy IS gated.
  "loadOwnedJob", // cma.ts   -> requireOwnerCode + owner-scoped job read
  "loadOwnedRun", // integrations.ts -> requireJwtAccount + owner-scoped run read
  "loadOwnedCtx", // brief.ts
  "requireBuyerUser", // portal-claim.ts -> verified buyer JWT
  "requireLicensingAccount", // licensing.ts -> readBearerToken + verifyAccessToken -> verified account id
  "buyerFromToken", // portal-engage.ts -> capability token -> buyer
  "buyerFromClaim", // portal-engage.ts -> verified buyer JWT -> claim
  "resolveActiveClaim", // portal-claim.ts
  "resolveActiveLink", // portal.ts -> capability token -> owner + buyer
  // ── Machine-to-machine / webhook gates ─────────────────────────────────────
  "authorizeInternal", // entitlements.ts INTERNAL_API_SECRET
  "cronAuthOk", // integrations.ts cron shared secret (constant-time)
  "bearerEquals",
  "verifySignedPayload", // billing.ts Apple JWS
  "verifyNotification",
  "readSignedTransaction",
  "verifyStripeSignature", // billing.ts Stripe webhook HMAC over the raw body
  "cronSecrets",
  "credentialHealthReport", // lib/credential-probes.ts HEALTH_PROBE_SECRET (constant-time), refuses before any probe runs
  // ── Capability-token gates ─────────────────────────────────────────────────
  "gateBriefOwner", // annotations.ts -> requireOwnerCode + job-owner compare
  "getCmaShare", // cma.ts   -> share token is the capability
  "getBriefShare", // brief-share.ts -> hashed share token is the capability

  "checkBriefShared",
  "verifyHubspotState", // integrations.ts -> signed OAuth state + nonce cookie
  "hashInboundSecret", // integrations.ts -> path secret hashed and matched
];

const AUTH_OK_RE = /\/\/\s*auth-ok:\s*(\S.*)$/;

/**
 * A registration STARTS here. The path is read separately, because demanding it
 * on this line is what created the blind spot described at the top of the file.
 */
const ROUTE_START_RE = /^\s*router\.(get|post|put|patch|delete)\(/;

/**
 * How far past the `router.` line the path may sit. Six lines covers every
 * multi-line registration in the tree with room to spare; past that the reader
 * is guessing, and guessing wrong here means silently un-checking a route.
 */
const MAX_REGISTRATION_LINES = 6;

/**
 * The handler has begun. Nothing after this point is the path argument, so if
 * the path has not been read by now it is not going to be, and the registration
 * is reported unreadable rather than dropped.
 */
const HANDLER_TOKEN_RE = /=>|\basync\b|\bfunction\b/;

/**
 * Read the path argument of a registration out of `text`, which begins
 * immediately after `router.<verb>(`.
 *
 * Three answers, and the difference between the last two is the whole point:
 *   { paths }      the argument was read
 *   { need: true } the argument is not finished yet; feed another line
 *   { bad }        the argument is NOT a quoted path or an array of them
 *
 * Trivia-aware because the argument list can carry comments between its
 * entries, and a `'` inside one of those comments would otherwise read as the
 * start of a path string.
 */
function readPathArg(text) {
  let i = 0;

  /** Advance past whitespace and comments. False = ran out of text. */
  function skipTrivia() {
    while (i < text.length) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\r" || c === "\n") {
        i += 1;
        continue;
      }
      if (c === "/" && text[i + 1] === "/") {
        const nl = text.indexOf("\n", i);
        if (nl < 0) {
          i = text.length;
          return false;
        }
        i = nl + 1;
        continue;
      }
      if (c === "/" && text[i + 1] === "*") {
        const end = text.indexOf("*/", i + 2);
        if (end < 0) {
          i = text.length;
          return false;
        }
        i = end + 2;
        continue;
      }
      return true;
    }
    return false;
  }

  /** Read one quoted string, leaving `i` after its closing quote. */
  function readString() {
    const quote = text[i];
    let j = i + 1;
    let value = "";
    while (j < text.length) {
      const c = text[j];
      if (c === "\\") {
        value += text[j + 1] ?? "";
        j += 2;
        continue;
      }
      if (c === quote) {
        i = j + 1;
        return { value };
      }
      if (c === "\n" && quote !== "`") {
        return { bad: "a path string is not closed on its own line" };
      }
      value += c;
      j += 1;
    }
    return { need: true };
  }

  if (!skipTrivia()) return { need: true };

  const first = text[i];
  if (first === '"' || first === "'" || first === "`") {
    const r = readString();
    if (r.value === undefined) return r;
    return { paths: [r.value] };
  }
  if (first !== "[") {
    return { bad: `the path is neither a quoted string nor an array of them (starts with \`${preview(text, i)}\`)` };
  }

  i += 1;
  const paths = [];
  for (;;) {
    if (!skipTrivia()) return { need: true };
    const c = text[i];
    if (c === "]") {
      if (paths.length === 0) return { bad: "the path array is empty" };
      return { paths };
    }
    if (c === ",") {
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const r = readString();
      if (r.value === undefined) return r;
      paths.push(r.value);
      continue;
    }
    return { bad: `an array path element is not a quoted string (at \`${preview(text, i)}\`)` };
  }
}

function preview(text, at) {
  return text.slice(at, at + 32).split("\n")[0].trim();
}

if (!existsSync(ROUTES_DIR) || !statSync(ROUTES_DIR).isDirectory()) {
  console.error(`[route-auth] routes directory not found: ${ROUTES_DIR}`);
  process.exit(1);
}

/**
 * WALK THE ROUTE TREE, INCLUDING SUBDIRECTORIES.
 *
 * This was a flat `readdirSync(ROUTES_DIR)`, and a subdirectory simply failed
 * `.endsWith(".ts")` and was dropped — silently, because `checked === 0` cannot
 * see a partial loss. `routes/` holds 37 files and 176 routes; splitting it into
 * `routes/listings/` or `routes/portal/` is the obvious next refactor for a directory
 * that size, and every route in the new subdirectory would have shipped
 * unchecked while the other 36 files kept supplying 170-odd routes and a green
 * gate. Every other tree-walking gate in scripts/ already recurses
 * (check-tenancy-scope, check-field-class, check-data-scope, check-hook-order,
 * check-source-anchors); this one did not.
 *
 * `index.ts` is skipped at every level: it is the aggregator that mounts the
 * other files, not a place routes are declared.
 */
function walkRoutes(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      walkRoutes(full, out);
    } else if (name.endsWith(".ts") && !/-test\.ts$/.test(name) && name !== "index.ts") {
      out.push(full);
    }
  }
  return out;
}

const files = walkRoutes(ROUTES_DIR);

/** Return the source of the handler starting at `router.` on `startLine`. */
function handlerBody(lines, startLine) {
  let depth = 0;
  let started = false;
  const out = [];
  for (let i = startLine; i < lines.length; i += 1) {
    const line = lines[i];
    out.push(line);
    for (const ch of line) {
      if (ch === "(") {
        depth += 1;
        started = true;
      } else if (ch === ")") {
        depth -= 1;
      }
    }
    if (started && depth <= 0) break;
    // A handler longer than this is not a handler; bail rather than read the file.
    if (out.length > 400) break;
  }
  return out.join("\n");
}

/**
 * Return the source of a named function declaration starting on `startLine`.
 *
 * Brace-matched, not paren-matched: handlerBody() balances parentheses because a
 * route registration IS one call expression, but a `function foo(a, b) { … }`
 * closes its parens on the signature line, so paren-matching would return the
 * signature and nothing else — which is how the two cron routes read as ungated
 * even though cronAuthOk sits three lines into the handler.
 */
function functionBody(lines, startLine) {
  let depth = 0;
  let started = false;
  const out = [];
  for (let i = startLine; i < lines.length; i += 1) {
    out.push(lines[i]);
    for (const ch of lines[i]) {
      if (ch === "{") {
        depth += 1;
        started = true;
      } else if (ch === "}") {
        depth -= 1;
      }
    }
    if (started && depth <= 0) break;
    if (out.length > 400) break;
  }
  return out.join("\n");
}

const gated = [];
const declaredPublic = [];
const findings = [];
const unreadable = [];
let checked = 0;
let multiPath = 0;

for (const file of files) {
  const rel = relative(ROOT, file);
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");
  // COMMENT- AND STRING-STRIPPED TWIN, byte-for-byte the same length per line,
  // so an index into one indexes the other. `body.includes(gate)` runs on this
  // copy: `// TODO: this needs requireOwnerCode` inside a handler, or the
  // literal "requireOwnerCode" in a log message, used to satisfy the gate test
  // and the route read as gated. A gate that exists only in a comment is not a
  // gate. Route paths and `// auth-ok:` declarations are still read off the RAW
  // lines, because both of those ARE a quoted string and a comment.
  const codeLines = stripSource(src).split("\n");

  for (let i = 0; i < lines.length; i += 1) {
    const m = ROUTE_START_RE.exec(lines[i]);
    if (!m) continue;
    // …but a `router.get("/x", …)` written inside a comment or a template
    // literal is not a route. The stripped twin blanks both, so requiring
    // `router.` to survive stripping is the cheap discriminator.
    if (!codeLines[i]?.includes("router.")) continue;
    checked += 1;
    const verb = m[1].toUpperCase();

    // READ THE PATH ACROSS LINES. The argument may be a quoted string, an array
    // of them, or either of those on a line below the paren. Reading stops at
    // the first line that has already begun the handler, because the path is
    // never after it.
    //
    // Paths come off the RAW lines, not the stripped twin: a path IS a string
    // literal and the twin has blanked it. The handler-token stop reads the
    // TWIN, so the word "async" in a comment above the path cannot cut the read
    // short.
    let text = lines[i].slice(m[0].length);
    let end = i;
    let arg = readPathArg(text);
    while (arg.need) {
      if (end - i + 1 >= MAX_REGISTRATION_LINES) break;
      const seen = codeLines[end] ?? "";
      if (HANDLER_TOKEN_RE.test(seen) || GATES.some((g) => seen.includes(g))) break;
      end += 1;
      if (end >= lines.length) break;
      text += `\n${lines[end]}`;
      arg = readPathArg(text);
    }

    if (!arg.paths) {
      // NOT A SKIP. A registration the recogniser cannot read is a route nobody
      // is checking, which is the exact failure this file exists to prevent, so
      // it fails the build and names itself.
      unreadable.push({
        file: rel,
        line: i + 1,
        verb,
        why: arg.bad ?? `the path was not closed within ${MAX_REGISTRATION_LINES} lines of the registration`,
      });
      continue;
    }

    // One registration is one route, however many aliases it declares: one
    // handler, one gate, one count.
    const path = arg.paths.join(", ");
    if (arg.paths.length > 1) multiPath += 1;
    let body = handlerBody(codeLines, i);

    // A route may be registered with a NAMED handler declared elsewhere in the
    // file — `router.get("/cron/reconcile", handleReconcileCron)`. The gate then
    // lives in that function, not at the registration line, so pull its body in
    // too. Without this, the two cron endpoints (whose gate is cronAuthOk inside
    // handleReconcileCron) read as ungated, and "fix" would mean either a bogus
    // auth-ok excuse on a genuinely gated route or duplicating the check.
    const named = /,\s*([A-Za-z_$][\w$]*)\s*\)\s*;?\s*$/.exec(body.trim());
    if (named) {
      const fnRe = new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${named[1]}\\b`);
      const at = codeLines.findIndex((l) => fnRe.test(l.trim()));
      if (at >= 0) body += "\n" + functionBody(codeLines, at);
    }

    if (GATES.some((g) => body.includes(g))) {
      gated.push({ file: rel, line: i + 1, verb, path });
      continue;
    }

    const excuse = [lines[i], lines[i - 1], lines[i - 2], lines[i - 3], lines[i - 4]]
      .filter((l) => typeof l === "string")
      .map((l) => AUTH_OK_RE.exec(l))
      .find(Boolean);
    if (excuse) {
      declaredPublic.push({ file: rel, line: i + 1, verb, path, reason: excuse[1].trim() });
      continue;
    }

    findings.push({ file: rel, line: i + 1, verb, path });
  }
}

console.log(
  `[route-auth] checked ${checked} route(s) in ${files.length} route file(s): ` +
    `${gated.length} gated, ${declaredPublic.length} declared public.\n`,
);

if (multiPath > 0) {
  console.log(
    `[route-auth] ${multiPath} registration(s) declare more than one path (alias arrays); ` +
      `each is counted once, and all of its paths are printed.\n`,
  );
}

// Zero routes found is not a pass, it is the absence of an examination.
if (checked === 0) {
  console.error(
    `[route-auth] 0 routes were found in ${files.length} file(s).\n` +
      `  The recogniser stopped recognising: verify that routes are still registered as\n` +
      `  \`router.<verb>("<path>", …)\` and that ROUTES_DIR still points at the route tree.`,
  );
  process.exit(1);
}

if (declaredPublic.length > 0) {
  console.log(`[route-auth] ${declaredPublic.length} deliberately public:`);
  for (const p of declaredPublic) {
    console.log(`  · ${p.verb} ${p.path}  (${p.file}:${p.line}) — ${p.reason}`);
  }
  console.log("");
}

if (unreadable.length > 0) {
  console.error(`[route-auth] ${unreadable.length} registration(s) whose path could not be read:\n`);
  for (const u of unreadable) {
    console.error(`  ❌ ${u.verb} ?  (${u.file}:${u.line}) — ${u.why}`);
  }
  console.error(
    "\nThis is a FAILURE, not a skip. A registration the recogniser cannot read is a\n" +
      "route it cannot check, and an unchecked route is how an ungated one ships. Write\n" +
      'the path as a quoted string or an array of quoted strings — `router.get("/x", …)`\n' +
      'or `router.get(["/x", "/y"], …)`, either on the registration line or within\n' +
      `${MAX_REGISTRATION_LINES} lines below it — or teach readPathArg() the new shape.`,
  );
  process.exit(1);
}

if (findings.length > 0) {
  console.error(`[route-auth] ${findings.length} route(s) with NO gate and NO declaration:\n`);
  for (const f of findings) {
    console.error(`  ❌ ${f.verb} ${f.path}  (${f.file}:${f.line})`);
  }
  console.error(
    "\nA route with neither is OPEN to the internet. Either call a gate\n" +
      `(${GATES.slice(0, 4).join(", ")}, …) in the handler, or add\n` +
      "`// auth-ok: <why this is safe to expose>` immediately above the route.",
  );
  process.exit(1);
}

console.log(
  `[route-auth] OK — all ${checked} routes are gated or explicitly declared public.`,
);
process.exit(0);
