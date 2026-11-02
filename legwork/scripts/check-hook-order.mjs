#!/usr/bin/env node
/**
 * NO REACT HOOK MAY BE CALLED AFTER AN EARLY RETURN.
 *
 * Run: node scripts/check-hook-order.mjs
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Shipped to production in PR #413 and found by the operator, not by us:
 * `views/ClientProfile.tsx` grew a `useMemo` placed next to the values it fed,
 * which put it BELOW the component's two early returns (the loading skeleton
 * and the "client unavailable" card). A hook after a conditional return runs on
 * some renders and not others — the loading pass registered N hooks, the loaded
 * pass registered N+1, and React threw "Rendered more hooks than during the
 * previous render" the moment the profile arrived. Every client became
 * unopenable.
 *
 * NOTHING IN THE GATE COULD HAVE CAUGHT IT, and that is the real finding:
 *
 *   · `tsc` does not model hook order. The code typechecks perfectly.
 *   · The suites render ONE pass with data already present, so they never cross
 *     the loading→loaded boundary where the hook count changes. A component
 *     that can only crash on its SECOND render is invisible to a single
 *     synchronous render.
 *   · THERE IS NO ESLINT IN THIS REPO AT ALL. Not misconfigured — absent. The
 *     `// eslint-disable-next-line react-hooks/exhaustive-deps` comments
 *     scattered through the frontend reference a linter that has never run
 *     here, which is worse than having none: they read as evidence that the
 *     rule is enforced and suppressed deliberately.
 *
 * So this is the narrow mechanical stand-in for `react-hooks/rules-of-hooks`.
 * It is not a linter and does not pretend to be one; it catches the one shape
 * that actually cost us a production page.
 *
 * ── HOW IT DECIDES ──────────────────────────────────────────────────────────
 *
 * Per function body, tracked by brace depth:
 *   1. Find the first `return` that is NESTED (depth greater than the function
 *      body's own depth) — that is an early return, i.e. one inside an `if`.
 *   2. Flag any `useX(` call AFTER that line which sits at the function body's
 *      OWN depth (an unconditional hook call in the main body).
 *
 * A hook nested deeper than the body is not flagged: it is inside another
 * function (a callback, a nested component, a `.map`), which is a different
 * question this check does not try to answer.
 *
 * DELIBERATELY NARROW. A checker with false positives gets an ignore-list, and
 * an ignore-list is how a rule stops being a rule. It would rather miss an
 * exotic arrangement than cry wolf on a correct one.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { stripSource } from "./lib/strip-source.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SCAN_DIRS = [
  join(ROOT, "artifacts/buyer-brief/src"),
  join(ROOT, "artifacts/mockup-sandbox/src"),
];

/** Every hook the React runtime counts. `use` alone is the RSC hook; included. */
const HOOK_CALL = /(?<![A-Za-z0-9_$.])(use[A-Z][A-Za-z0-9_$]*|use)\s*\(/;

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(name)) {
      // `.ts` AS WELL AS `.tsx`, and the `?` is the whole finding.
      //
      // Components are `.tsx`; CUSTOM HOOKS are `.ts`. Walking only `.tsx`
      // meant the entire `src/hooks/` directory was outside this gate — 26 `.ts`
      // files holding hook calls, `use-portal.ts` alone exporting about twenty
      // hooks (usePortal, usePortalBrief, useMyPortals, useClaimStatus,
      // useBriefBuyerNotes, useBuyerNotesController, useClientLink, …), plus
      // use-showings.ts, use-annotations.ts, use-clients.ts, use-walkthrough.ts
      // and use-brief-generation.ts. A `useMemo` placed below an early return
      // inside `useBuyerNotesController` throws "Rendered more hooks than during
      // the previous render" in exactly the way #413 did in ClientProfile, and
      // this gate could not see it. Measured 2026-09-02: 98 files / 1172
      // function bodies before, 128 / 1482 after — 21% of the client's function
      // bodies and 100% of its shared hook logic had never been checked.
      //
      // The floor below moved with it, for the reason the floor exists at all:
      // the `.tsx` files alone clear 20/50 by such a margin that narrowing the
      // walk back to today's blind spot would not have gone red.
      out.push(full);
    }
  }
  return out;
}

/** Strip comments and string bodies so braces and keywords inside them do not
 *  move the depth counter or fake a `return`. Length is preserved per line so
 *  reported line numbers stay true. Lives in scripts/lib/strip-source.mjs
 *  because check-route-auth.mjs needs the identical thing for the identical
 *  reason — a gate named only in a comment is not a gate. */
const sanitize = stripSource;

const violations = [];
let filesScanned = 0;
let functionsScanned = 0;

for (const dir of SCAN_DIRS) {
  for (const file of walk(dir)) {
    const raw = readFileSync(file, "utf8");
    if (!HOOK_CALL.test(raw)) continue;
    filesScanned += 1;
    const lines = sanitize(raw).split("\n");
    const rawLines = raw.split("\n");

    // ONE pass, tracking a scope stack. Each `{` pushes; each `}` pops. A scope
    // is a FUNCTION scope when the line that opened it declared a function or
    // an arrow. For every line we then know its innermost enclosing function —
    // which is the whole point, because a `return` inside a useCallback body
    // belongs to that callback and says nothing about the component around it.
    // The first cut of this checker missed that and reported four false
    // positives in settings/; a checker that cries wolf earns an ignore-list,
    // and an ignore-list is how a rule stops being a rule.
    // A CONTROL BLOCK IS NOT A FUNCTION BODY. `if (x) {` ends in `) {` and so
    // matched the naive pattern, which made every if-block its own "function" —
    // and therefore made the early return inside it belong to that fake scope
    // instead of to the component. That is why the first two cuts of this
    // checker printed a clean bill of health over the exact bug they were
    // written for. Verified by reintroducing the shipped ClientProfile defect
    // and watching it stay green.
    const CONTROL_BLOCK = /^\s*\}?\s*(if|for|while|switch|catch|else|do|try|finally)\b/;
    const OPENS_BODY = /(function\s*[A-Za-z0-9_$]*\s*\(|=>\s*\{|\)\s*(:[^{]*)?\{\s*$)/;
    const opensFnBody = (line) => OPENS_BODY.test(line) && !CONTROL_BLOCK.test(line);
    /** fnId -> { bodyDepth, firstEarlyReturn, hooks: [{line, hook}] } */
    const fns = new Map();
    const stack = []; // { isFn, fnId }
    let nextFnId = 0;

    const innermostFn = () => {
      for (let k = stack.length - 1; k >= 0; k -= 1) if (stack[k].isFn) return stack[k].fnId;
      return -1;
    };

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const depthBefore = stack.length;
      const fnBefore = innermostFn();

      if (fnBefore !== -1) {
        const rec = fns.get(fnBefore);
        // An EARLY RETURN: a return belonging to THIS function, nested deeper
        // than its own body (i.e. inside an if/try/switch).
        if (
          rec.firstEarlyReturn === -1 &&
          depthBefore > rec.bodyDepth &&
          /(?<![A-Za-z0-9_$.])return(?![A-Za-z0-9_$])/.test(line)
        ) {
          rec.firstEarlyReturn = i;
        }
        // An UNCONDITIONAL hook call: at this function's own body depth.
        if (depthBefore === rec.bodyDepth) {
          const m = HOOK_CALL.exec(line);
          if (m) rec.hooks.push({ line: i, hook: m[1] });
        }
      }

      const willOpenFn = opensFnBody(line);
      // WHICH `{` ON THIS LINE IS THE FUNCTION BODY? The LAST one still
      // unclosed at end of line. The first cut marked the FIRST `{`, which on a
      // single-line destructured signature — `function Foo({ a }: Props) {` —
      // is the destructure: it closes on the same line, the real body brace is
      // pushed untracked, and every return and hook in the component belongs to
      // nothing. 126 components have that signature shape, and the gate printed
      // OK over a live instance of the exact defect it exists to stop
      // (CmaResult.tsx, found 2026-08-18). The "verified by reintroducing the
      // shipped ClientProfile defect" claim above held only because that
      // component's signature happens to be multiline, which re-enters the
      // tracked path via the `) {` opener.
      let fnBraceOrdinal = -1;
      if (willOpenFn) {
        const openOrdinals = [];
        let ordinal = 0;
        for (const ch of line) {
          if (ch === "{") {
            openOrdinals.push(ordinal);
            ordinal += 1;
          } else if (ch === "}") {
            openOrdinals.pop();
          }
        }
        if (openOrdinals.length > 0) fnBraceOrdinal = openOrdinals[openOrdinals.length - 1];
      }
      let opened = 0;
      for (const ch of line) {
        if (ch === "{") {
          const isFn = opened === fnBraceOrdinal;
          let fnId = -1;
          if (isFn) {
            fnId = nextFnId++;
            fns.set(fnId, { bodyDepth: stack.length + 1, firstEarlyReturn: -1, hooks: [], file, open: i });
          }
          stack.push({ isFn, fnId });
          opened += 1;
        } else if (ch === "}") {
          stack.pop();
        }
      }
    }

    for (const rec of fns.values()) {
      functionsScanned += 1;
      if (rec.firstEarlyReturn === -1) continue;
      for (const h of rec.hooks) {
        if (h.line <= rec.firstEarlyReturn) continue;
        violations.push({
          file: relative(ROOT, file),
          line: h.line + 1,
          hook: h.hook,
          returnLine: rec.firstEarlyReturn + 1,
          text: rawLines[h.line].trim().slice(0, 100),
        });
      }
    }
  }
}

// REFUSE TO PASS OVER NOTHING. The tenancy and bundle checkers both hard-fail
// on an empty scan for the same reason: a checker that found no files prints an
// identical clean bill of health to one that found no problems.
// The numbers are ~78% of the live scan (128 files / 1482 bodies on 2026-09-02),
// the same 10%-ish band the offline-suite floor uses, so ordinary churn is quiet
// and losing the hooks directory again is loud.
if (filesScanned < 100 || functionsScanned < 1150) {
  console.error(
    `[hook-order] REFUSING to pass: scanned only ${filesScanned} file(s) / ${functionsScanned} function bod(ies). ` +
      `SCAN_DIRS is probably wrong or a tree moved.`,
  );
  process.exit(1);
}

if (violations.length > 0) {
  console.error(`[hook-order] ${violations.length} hook call(s) AFTER an early return:\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.hook}() runs only on some renders`);
    console.error(`    early return at line ${v.returnLine} means this hook is skipped when that branch is taken.`);
    console.error(`    React counts hooks per render; a changing count throws "Rendered more hooks than during`);
    console.error(`    the previous render" and blanks the view. Move it above every return in this function.`);
    console.error(`    ${v.text}\n`);
  }
  process.exit(1);
}

console.log(
  `[hook-order] OK — ${filesScanned} file(s), ${functionsScanned} function bod(ies): no hook is called after an early return.`,
);
