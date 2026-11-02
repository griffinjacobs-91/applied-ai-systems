// Self-test for the React hook-order check.
//
// Run: node scripts/check-hook-order-test.mjs
//
// WHY THIS SUITE EXISTS
//   scripts/check-hook-order.mjs is this repo's entire stand-in for
//   `react-hooks/rules-of-hooks` — there is no eslint here at all — and it
//   walked only `.tsx`:
//
//     } else if (/\.tsx$/.test(name)) {
//
//   Components are `.tsx`. CUSTOM HOOKS are `.ts`. The whole of
//   artifacts/buyer-brief/src/hooks/ was therefore outside the gate: 26 `.ts`
//   files containing hook calls, `use-portal.ts` alone exporting about twenty
//   hooks, plus use-showings.ts, use-annotations.ts, use-clients.ts,
//   use-walkthrough.ts and use-brief-generation.ts. Measured 2026-09-02:
//   98 files / 1172 function bodies scanned before, 128 / 1483 after — about
//   21% of the client's function bodies, and 100% of its shared hook logic, had
//   never been looked at. A `useMemo` placed below an early return inside
//   `useBuyerNotesController` throws "Rendered more hooks than during the
//   previous render" in exactly the way #413 did in ClientProfile, and this
//   gate could not see it.
//
//   The floor could not notice either: the `.tsx` files alone cleared the old
//   20/50 by such a margin that narrowing the walk back would have stayed
//   green. It moved with the walk, and case 4 below is the proof.
//
// OFFLINE
//   Every child is `node scripts/check-hook-order.mjs` against a temp tree.

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLIENT = "artifacts/buyer-brief/src";

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

const TMP = mkdtempSync(path.join(tmpdir(), "legwork-hook-order-"));

function run(dir, label) {
  const r = spawnSync(process.execPath, ["scripts/check-hook-order.mjs"], { cwd: dir, encoding: "utf8", timeout: 120_000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const ran = !r.error && r.status !== null;
  if (!ran) check(`the checker ran to completion (${label})`, false, `status=${r.status} error=${r.error?.message ?? "none"}`);
  return { code: r.status, out, ran };
}

/** A well-behaved component: every hook above the early return. */
function cleanFile(i) {
  const fns = Array.from(
    { length: 12 },
    (_, k) => `export function Widget${i}_${k}({ ready }: { ready: boolean }) {
  const value = useMemo(() => ${k}, []);
  const [open, setOpen] = useState(false);
  if (!ready) {
    return null;
  }
  return { value, open, setOpen };
}`,
  );
  return `${fns.join("\n\n")}\n`;
}

/** The #413 shape: a hook below a conditional return. */
const VIOLATION = `export function useBuyerNotesController({ ready }: { ready: boolean }) {
  const [draft, setDraft] = useState("");
  if (!ready) {
    return { draft, setDraft };
  }
  const summary = useMemo(() => draft.trim(), [draft]);
  return { draft, setDraft, summary };
}
`;

// The floor is a fraction of the real scan, so a sandbox has to be a real-sized
// tree or every case would only ever prove the floor.
let n = 0;
function tree({ files = 110, extra = {} } = {}) {
  const dir = path.join(TMP, `t${(n += 1)}`);
  mkdirSync(path.join(dir, "scripts", "lib"), { recursive: true });
  copyFileSync(path.join(REPO, "scripts", "check-hook-order.mjs"), path.join(dir, "scripts", "check-hook-order.mjs"));
  copyFileSync(path.join(REPO, "scripts", "lib", "strip-source.mjs"), path.join(dir, "scripts", "lib", "strip-source.mjs"));
  mkdirSync(path.join(dir, CLIENT, "components"), { recursive: true });
  mkdirSync(path.join(dir, CLIENT, "hooks"), { recursive: true });
  for (let i = 0; i < files; i += 1) {
    writeFileSync(path.join(dir, CLIENT, "components", `Widget${i}.tsx`), cleanFile(i));
  }
  for (const [rel, body] of Object.entries(extra)) {
    const full = path.join(dir, CLIENT, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

// ── 1. THE REGRESSION: a hook module is a `.ts` file ───────────────────────
console.log("a hook after an early return in a .ts hook module is caught");
{
  const r = run(tree({ extra: { "hooks/use-portal.ts": VIOLATION } }), "ts-hook-violation");
  check("exits non-zero", r.ran && r.code !== 0, `exit=${r.code}\n${r.out.slice(0, 600)}`);
  check("names the .ts file", r.ran && /hooks\/use-portal\.ts/.test(r.out), r.out.slice(0, 600));
  check("names the hook", r.ran && /useMemo\(\) runs only on some renders/.test(r.out), r.out.slice(0, 600));
  check("never prints the reassuring line", r.ran && !/\[hook-order\] OK/.test(r.out), r.out.slice(0, 600));
}

// ── 2. The .tsx path is unchanged ──────────────────────────────────────────
console.log("the .tsx path still works");
{
  const r = run(tree({ extra: { "components/Broken.tsx": VIOLATION } }), "tsx-violation");
  check("exits non-zero", r.ran && r.code !== 0, `exit=${r.code}`);
  check("names the .tsx file", r.ran && /components\/Broken\.tsx/.test(r.out), r.out.slice(0, 600));
}

// ── 3. A clean .ts hook module passes, and is COUNTED ──────────────────────
// Both halves matter: a checker that failed on every `.ts` file would score as
// a fix, and one that "passed" by not reading them would look identical to
// today's green.
console.log("a clean .ts hook module passes and is counted");
{
  const clean = `export function usePortal({ ready }: { ready: boolean }) {
  const [state, setState] = useState(null);
  const summary = useMemo(() => state, [state]);
  if (!ready) {
    return null;
  }
  return { state, setState, summary };
}
`;
  const r = run(tree({ files: 109, extra: { "hooks/use-portal.ts": clean } }), "ts-clean");
  check("exits 0", r.ran && r.code === 0, `exit=${r.code}\n${r.out.slice(0, 600)}`);
  check("counted 110 files, so the .ts file was read", r.ran && /OK — 110 file\(s\)/.test(r.out), r.out.slice(0, 300));
}

// ── 4. Narrowing the walk back is RED, not quietly green ───────────────────
// The floor's whole job. Before it moved, `.tsx`-only cleared 20/50 by a wide
// margin, so returning the gate to today's blind spot would have gone unnoticed.
console.log("a walk that suddenly sees far less is refused");
{
  const r = run(tree({ files: 40 }), "narrowed");
  check("exits non-zero", r.ran && r.code !== 0, `exit=${r.code}\n${r.out.slice(0, 400)}`);
  check("refuses rather than reporting", r.ran && /REFUSING to pass/.test(r.out), r.out.slice(0, 400));
  check("says how little it saw", r.ran && /scanned only 40 file\(s\)/.test(r.out), r.out.slice(0, 400));
}

// ── 5. A hook named only in a comment or a string is not a hook call ───────
// The stripper's job, shared with check-route-auth.mjs.
console.log("a hook named in prose is not a hook call");
{
  const prose = `export function useThing({ ready }: { ready: boolean }) {
  const [state, setState] = useState(null);
  if (!ready) {
    return null;
  }
  // A useMemo( here would be a violation, which is the point of this line.
  console.log("do not add useMemo( below the early return");
  return state;
}
`;
  const r = run(tree({ files: 110, extra: { "hooks/use-thing.ts": prose } }), "prose-hook");
  check("exits 0", r.ran && r.code === 0, `exit=${r.code}\n${r.out.slice(0, 600)}`);
}

// ── 6. JSX CLOSING TAGS ARE NOT REGEX LITERALS ────────────────────────────
// The stripper decides `/` is a regex where a value may start, and `<` and `>`
// are value positions in plain JS — so `</div>` opened a regex state that ran to
// the end of the line. Measured across artifacts/buyer-brief/src before the fix:
// 205 lines in 57 of 179 .tsx files lost braces that way. `{cond && <span>x
// </span>}` came back missing its closing brace, so the brace-depth counter
// drifted by one and every function body after it in the file was misattributed.
// The fixture below drifts the counter under the old rule and the violation in
// the SECOND component is what proves the counter recovered.
console.log("a JSX closing tag does not open a regex state");
{
  const jsx = `export function Card({ ready, cond }: { ready: boolean; cond: boolean }) {
  const [open, setOpen] = useState(false);
  if (!ready) {
    return null;
  }
  return (
    <div>
      {cond && <span>x</span>}
    </div>
  );
}

export function Later({ ready }: { ready: boolean }) {
  const [a, setA] = useState(0);
  if (!ready) {
    return null;
  }
  const b = useMemo(() => a, [a]);
  return b;
}
`;
  const r = run(tree({ extra: { "components/Card.tsx": jsx } }), "jsx-close-tag");
  check("exits non-zero", r.ran && r.code !== 0, `exit=${r.code}\n${r.out.slice(0, 600)}`);
  check(
    "the violation AFTER the JSX block is still found",
    r.ran && /components\/Card\.tsx:18/.test(r.out),
    r.out.slice(0, 600),
  );
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
