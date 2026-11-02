// Self-test for the route authorization check.
//
// Run: node scripts/check-route-auth-test.mjs
//
// WHY THIS SUITE EXISTS
//   scripts/check-route-auth.mjs is what makes a new endpoint's default posture
//   DENY-or-declare instead of ALLOW. It had three ways to pass over a route it
//   had not actually inspected, and its only empty-scan guard (`checked === 0`)
//   could see none of them, because in every case the other three dozen files
//   kept supplying 170-odd routes and a green line.
//
//   BYPASS A — A NEW DIRECTORY. The walk was a flat `readdirSync(ROUTES_DIR)`.
//   A subdirectory's name simply failed `.endsWith(".ts")` and was dropped.
//   `routes/` holds 37 files and 176 routes; splitting it into `routes/listings/` or
//   `routes/portal/` is the obvious next refactor for a directory that size,
//   and every route in the new subdirectory would ship UNCHECKED. Every other
//   tree-walking gate in scripts/ already recursed; this one did not.
//
//   BYPASS B — A GATE THAT IS ONLY A COMMENT. `body.includes(gate)` ran on raw
//   text, so `// TODO: this needs requireOwnerCode` inside a handler, or the
//   string "requireOwnerCode" in a log message, satisfied the gate test and the
//   route read as gated. Instrumented against the live tree: 0 of 176 routes
//   were gated only by a comment mention, so this was latent, not live.
//
//   BYPASS C — A REGISTRATION SHAPE THE RECOGNISER DID NOT KNOW. ROUTE_RE
//   demanded a quoted path on the SAME line as the paren, so
//   `router.get(["/a", "/b"], …)` and a registration whose path sits on the
//   next line were both invisible. Invisible means UNCOUNTED, and uncounted
//   means "all 179 routes are gated" was a claim about a subset. Measured
//   2026-09-15 against the live tree: SEVEN registrations sat in that blind
//   spot — five in portal.ts, one in portal-engage.ts, and POST /brief/start,
//   the most expensive route in the product. All seven were gated by hand, so
//   nothing was open; nothing would have noticed had one not been.
//
//   All three are covered below in both directions — the bypass must go red, and
//   the real shapes must still go green.
//
// OFFLINE
//   Every child is `node scripts/check-route-auth.mjs` against a temp directory.

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROUTES = "artifacts/api-server/src/routes";

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

const TMP = mkdtempSync(path.join(tmpdir(), "legwork-route-auth-"));

function run(dir, label) {
  const r = spawnSync(process.execPath, ["scripts/check-route-auth.mjs"], { cwd: dir, encoding: "utf8", timeout: 120_000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const ran = !r.error && r.status !== null;
  if (!ran) check(`the checker ran to completion (${label})`, false, `status=${r.status} error=${r.error?.message ?? "none"}`);
  return { code: r.status, out, ran };
}

let n = 0;
function tree(files) {
  const dir = path.join(TMP, `t${(n += 1)}`);
  mkdirSync(path.join(dir, "scripts", "lib"), { recursive: true });
  copyFileSync(path.join(REPO, "scripts", "check-route-auth.mjs"), path.join(dir, "scripts", "check-route-auth.mjs"));
  copyFileSync(path.join(REPO, "scripts", "lib", "strip-source.mjs"), path.join(dir, "scripts", "lib", "strip-source.mjs"));
  mkdirSync(path.join(dir, ROUTES), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, ROUTES, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

const GATED = `import { Router } from "express";
const router = Router();
router.get("/things", async (req, res) => {
  const owner = await requireOwnerCode(req);
  if (!owner.ok) return res.status(owner.status).json({ error: owner.message });
  res.json({ ok: true });
});
export default router;
`;
const UNGATED = `import { Router } from "express";
const router = Router();
router.get("/open", async (req, res) => {
  res.json({ ok: true });
});
export default router;
`;
// One healthy top-level file in every tree, so a case is never accidentally
// proving the `checked === 0` floor instead of the thing it names.
const BASE = { "top.ts": GATED };

// ── 1. BYPASS A: a route in a subdirectory is inspected ─────────────────────
console.log("a route in a routes/ subdirectory is checked");
{
  const r = run(tree({ ...BASE, "listings/enroll.ts": UNGATED }), "subdir-ungated");
  check("exits non-zero", r.ran && r.code !== 0, `exit=${r.code}\n${r.out}`);
  check("names the nested route", r.ran && /GET \/open\s+\(.*routes\/listings\/enroll\.ts/.test(r.out), r.out);
  check("does not report all routes as gated", r.ran && !/OK — all \d+ routes are gated/.test(r.out), r.out);
}
console.log("a GATED route in a subdirectory passes and is counted");
{
  const r = run(tree({ ...BASE, "portal/claim.ts": GATED }), "subdir-gated");
  check("exits 0", r.ran && r.code === 0, `exit=${r.code}\n${r.out}`);
  check("counts two route files, not one", r.ran && /in 2 route file\(s\)/.test(r.out), r.out);
  check("counts both routes as gated", r.ran && /2 gated/.test(r.out), r.out);
}
console.log("a nested index.ts is still skipped as the aggregator");
{
  const r = run(tree({ ...BASE, "listings/index.ts": UNGATED }), "nested-index");
  check("exits 0", r.ran && r.code === 0, `exit=${r.code}\n${r.out}`);
  check("counts only the real route file", r.ran && /in 1 route file\(s\)/.test(r.out), r.out);
}

// ── 2. BYPASS B: a gate that exists only as prose is not a gate ─────────────
console.log("a gate named only in a comment does not count");
{
  const commented = `import { Router } from "express";
const router = Router();
router.get("/open", async (req, res) => {
  // TODO: this needs requireOwnerCode before the beta opens up
  res.json({ ok: true });
});
export default router;
`;
  const r = run(tree({ ...BASE, "commented.ts": commented }), "comment-gate");
  check("exits non-zero", r.ran && r.code !== 0, `exit=${r.code}\n${r.out}`);
  check("names the route as ungated", r.ran && /GET \/open/.test(r.out), r.out);
}
console.log("a gate named only inside a string does not count");
{
  const logged = `import { Router } from "express";
const router = Router();
router.get("/open", async (req, res) => {
  console.log("skipping requireOwnerCode for the public catalog");
  res.json({ ok: true });
});
export default router;
`;
  const r = run(tree({ ...BASE, "logged.ts": logged }), "string-gate");
  check("exits non-zero", r.ran && r.code !== 0, `exit=${r.code}\n${r.out}`);
  check("names the route as ungated", r.ran && /GET \/open/.test(r.out), r.out);
}
console.log("a route commented OUT is not counted as a route");
{
  const commentedOut = `import { Router } from "express";
const router = Router();
// router.get("/retired", async (req, res) => res.json({}));
export default router;
`;
  const r = run(tree({ ...BASE, "retired.ts": commentedOut }), "commented-out-route");
  check("exits 0", r.ran && r.code === 0, `exit=${r.code}\n${r.out}`);
  check("counts one route, not two", r.ran && /checked 1 route\(s\)/.test(r.out), r.out);
}

// ── 3. A REGEX LITERAL DOES NOT SWALLOW THE HANDLER ────────────────────────
// The stripper has to know regexes: `/^https:\/\//i` contains the characters
// `//`, so a comment-stripper that does not would blank the rest of that line,
// lose its closing parens, and read on into the NEXT route — inheriting its
// gate. Measured on routes/brief.ts:1777, whose body ran to line 1881 correctly
// and to 2177 without regex handling, picking up the following route's
// requireOwnerCode. That is a route reading as gated because of its neighbour.
console.log("a regex literal in a handler does not leak the next route's gate");
{
  const withRegex = `import { Router } from "express";
const router = Router();
router.get("/redirect", async (req, res) => {
  const target = String(req.query.to);
  if (!/^https:\\/\\//i.test(target)) {
    res.status(502).json({ error: "bad scheme" });
    return;
  }
  res.redirect(302, target);
});
router.get("/owned", async (req, res) => {
  const owner = await requireOwnerCode(req);
  res.json({ ok: owner.ok });
});
export default router;
`;
  const r = run(tree({ ...BASE, "regex.ts": withRegex }), "regex-handler");
  check("exits non-zero", r.ran && r.code !== 0, `exit=${r.code}\n${r.out}`);
  check("the regex handler reads as ungated, not as its neighbour's", r.ran && /GET \/redirect/.test(r.out), r.out);
  check("and the neighbour is not also reported", r.ran && !/GET \/owned/.test(r.out), r.out);
}

// ── 4. The declaration mechanism still works ───────────────────────────────
console.log("an auth-ok declaration still declares");
{
  const declared = `import { Router } from "express";
const router = Router();
// auth-ok: the sign-in surface itself, there is no bearer to present yet
router.get("/open", async (req, res) => {
  res.json({ ok: true });
});
export default router;
`;
  const r = run(tree({ ...BASE, "declared.ts": declared }), "auth-ok");
  check("exits 0", r.ran && r.code === 0, `exit=${r.code}\n${r.out}`);
  check("counts it as deliberately public", r.ran && /1 declared public/.test(r.out), r.out);
  check("prints the written reason", r.ran && /there is no bearer to present yet/.test(r.out), r.out);
}

// ── 5. BYPASS C: every registration shape is read, or the build fails ──────
console.log("an array of alias paths is read and counted once");
{
  const arrayGated = `import { Router } from "express";
const router = Router();
router.get(["/buyers/:id/link", "/clients/:id/link"], async (req, res) => {
  const owner = await requireOwnerCode(req);
  if (!owner.ok) return res.status(owner.status).json({ error: owner.message });
  res.json({ ok: true });
});
export default router;
`;
  const r = run(tree({ ...BASE, "alias.ts": arrayGated }), "array-gated");
  check("exits 0", r.ran && r.code === 0, `exit=${r.code}\n${r.out}`);
  check("the array registration is SEEN (two routes, not one)", r.ran && /checked 2 route\(s\)/.test(r.out), r.out);
  check("and reads as gated", r.ran && /2 gated/.test(r.out), r.out);
  check("counted once per registration, not per alias", r.ran && /1 registration\(s\) declare more than one path/.test(r.out), r.out);
}
console.log("an UNGATED array registration is reported, with every alias named");
{
  const arrayUngated = `import { Router } from "express";
const router = Router();
router.get(["/open", "/open-alias"], async (req, res) => {
  res.json({ ok: true });
});
export default router;
`;
  const r = run(tree({ ...BASE, "alias-open.ts": arrayUngated }), "array-ungated");
  check("exits non-zero", r.ran && r.code !== 0, `exit=${r.code}\n${r.out}`);
  check("names both paths of the one registration", r.ran && /GET \/open, \/open-alias/.test(r.out), r.out);
}
console.log("an auth-ok declaration still declares an array registration");
{
  const arrayDeclared = `import { Router } from "express";
const router = Router();
// auth-ok: static covered-county copy, the same words for everyone, no tenant data
router.get(["/coverage", "/counties"], async (req, res) => {
  res.json({ counties: [] });
});
export default router;
`;
  const r = run(tree({ ...BASE, "alias-public.ts": arrayDeclared }), "array-auth-ok");
  check("exits 0", r.ran && r.code === 0, `exit=${r.code}\n${r.out}`);
  check("counts it as deliberately public", r.ran && /1 declared public/.test(r.out), r.out);
  check("prints both paths and the written reason", r.ran && /GET \/coverage, \/counties\b.*no tenant data/.test(r.out), r.out);
}
console.log("a path on the line BELOW the paren is read, past a comment that holds an apostrophe");
{
  // The comment is the trap, not decoration: it sits between the paren and the
  // path and contains a `'`, which a naive scan reads as the start of a string.
  const multilineGated = `import { Router } from "express";
const router = Router();
router.post(
  // multer stays so a stale cached SPA's multipart post still parses
  "/start",
  upload.single("image"),
  async (req, res) => {
    const owner = await resolveGenerationOwner(req, req.body.code);
    if (!owner.ok) return res.status(owner.status).json({ error: owner.message });
    res.json({ ok: true });
  },
);
export default router;
`;
  const r = run(tree({ ...BASE, "start.ts": multilineGated }), "multiline-gated");
  check("exits 0", r.ran && r.code === 0, `exit=${r.code}\n${r.out}`);
  check("the multi-line registration is SEEN (two routes, not one)", r.ran && /checked 2 route\(s\)/.test(r.out), r.out);
  check("and reads as gated", r.ran && /2 gated/.test(r.out), r.out);
}
console.log("an UNGATED multi-line registration is reported");
{
  const multilineUngated = `import { Router } from "express";
const router = Router();
router.post(
  "/open",
  upload.single("image"),
  async (req, res) => {
    res.json({ ok: true });
  },
);
export default router;
`;
  const r = run(tree({ ...BASE, "open-start.ts": multilineUngated }), "multiline-ungated");
  check("exits non-zero", r.ran && r.code !== 0, `exit=${r.code}\n${r.out}`);
  check("names the route", r.ran && /POST \/open/.test(r.out), r.out);
  check("does not report all routes as gated", r.ran && !/OK — all \d+ routes are gated/.test(r.out), r.out);
}
console.log("a registration whose path cannot be read is an ERROR, not a skip");
{
  // Gated on purpose. Skipping it would be "harmless" today and is exactly the
  // bug: the shape the recogniser does not understand is the shape nobody is
  // checking, and the next one written that way may have no gate at all.
  const computedPath = `import { Router } from "express";
const router = Router();
const PATHS = { start: "/start" };
router.get(PATHS.start, async (req, res) => {
  const owner = await requireOwnerCode(req);
  res.json({ ok: owner.ok });
});
export default router;
`;
  const r = run(tree({ ...BASE, "computed.ts": computedPath }), "unreadable-path");
  check("exits non-zero", r.ran && r.code !== 0, `exit=${r.code}\n${r.out}`);
  check("reports it as unreadable", r.ran && /1 registration\(s\) whose path could not be read/.test(r.out), r.out);
  check("names the file and line", r.ran && /computed\.ts:4/.test(r.out), r.out);
  check("does not claim every route is gated", r.ran && !/OK — all \d+ routes are gated/.test(r.out), r.out);
}
console.log("an array that never closes within the bound is an ERROR too");
{
  const runaway = `import { Router } from "express";
const router = Router();
router.get([
  "/a",
  "/b",
  "/c",
  "/d",
  "/e",
  "/f",
  "/g"
], async (req, res) => {
  const owner = await requireOwnerCode(req);
  res.json({ ok: owner.ok });
});
export default router;
`;
  const r = run(tree({ ...BASE, "runaway.ts": runaway }), "unclosed-array");
  check("exits non-zero", r.ran && r.code !== 0, `exit=${r.code}\n${r.out}`);
  check("says the path was not closed within the bound", r.ran && /not closed within 6 lines/.test(r.out), r.out);
}

// ── 6. An empty scan is still red ──────────────────────────────────────────
console.log("a checker that finds no routes still fails");
{
  const r = run(tree({}), "empty");
  check("exits non-zero", r.ran && r.code !== 0, `exit=${r.code}`);
  check("says zero routes were found", r.ran && /0 routes were found/.test(r.out), r.out);
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
