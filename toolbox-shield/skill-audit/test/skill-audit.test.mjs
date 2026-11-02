import test from "node:test";
import assert from "node:assert/strict";
import { auditSkill, frontmatter, hasToc } from "../skill-audit.mjs";

const fm = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n`;
const body = (n) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");

test("a short skill with a name and a description passes clean", () => {
  const r = auditSkill("tidy", { "SKILL.md": fm("tidy", "Use when tidying notes.") + body(40) });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test("over 200 lines warns, 500 or more fails", () => {
  const warn = auditSkill("w", { "SKILL.md": fm("w", "d") + body(250), "references/a.md": "x" });
  assert.deepEqual(warn.errors, []);
  assert.match(warn.warnings[0], /target is under 200/);
  const fail = auditSkill("f", { "SKILL.md": fm("f", "d") + body(600) });
  assert.match(fail.errors[0], /ceiling is 500/);
});

test("a missing name or description is an error, because that is what decides when a skill fires", () => {
  const r = auditSkill("x", { "SKILL.md": "# no frontmatter\n" });
  assert.ok(r.errors.includes("frontmatter has no name"));
  assert.ok(r.errors.includes("frontmatter has no description"));
});

test("a long reference file needs a table of contents", () => {
  const ref = body(150);
  const bad = auditSkill("r", { "SKILL.md": fm("r", "d"), "references/big.md": ref });
  assert.match(bad.errors[0], /no table of contents/);
  const good = auditSkill("r", { "SKILL.md": fm("r", "d"), "references/big.md": "## Contents\n" + ref });
  assert.deepEqual(good.errors, []);
});

test("deterministic steps and output formats point at scripts/ and assets/", () => {
  const r = auditSkill("d", { "SKILL.md": fm("d", "d") + "Validate the input, then build the HTML report." });
  assert.equal(r.errors.length, 0);
  assert.ok(r.warnings.some((w) => /scripts\//.test(w)));
  assert.ok(r.warnings.some((w) => /assets\//.test(w)));
});

test("frontmatter and table-of-contents readers", () => {
  assert.deepEqual(frontmatter('---\nname: "a"\ndescription: b\n---\nbody'), { name: "a", description: "b" });
  assert.deepEqual(frontmatter("no block"), {});
  assert.equal(hasToc("- [One](#one)\n- [Two](#two)\n- [Three](#three)"), true);
  assert.equal(hasToc("just prose"), false);
});
