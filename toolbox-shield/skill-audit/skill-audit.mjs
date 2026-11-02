#!/usr/bin/env node
// SKILL AUDIT: the written rubric for Claude skills, as a check that runs.
//
// The rubric (adopted 2 Nov 2026, in line with Anthropic's skill-authoring
// guidance):
//   1. SKILL.md targets under 200 lines, with a hard ceiling of 500.
//   2. Overflow detail moves into references/ files.
//   3. A reference file over 100 lines carries a table of contents.
//   4. Deterministic steps (formatting, parsing, validation) live in scripts/,
//      not prose.
//   5. Output formats get assets/ templates.
//   6. Clear and concise, with no hidden constraints: the frontmatter names the
//      skill and says when to use it.
//
// Usage: node skill-audit.mjs <skills-dir>
// Each child folder holding a SKILL.md is one skill. Exit 1 if any skill
// breaks a hard rule (1's ceiling, 3, or 6). Warnings never fail the run.

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";

export const TARGET_LINES = 200;
export const CEILING_LINES = 500;
export const TOC_OVER = 100;

const lines = (text) => text.split(/\r?\n/).length;

/** Parse the leading --- block. Returns {} when there is none. */
export function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

/** A table of contents: a heading named contents, or three or more in-file links. */
export function hasToc(text) {
  if (/^#{1,3}\s*(table of )?contents\b/im.test(text)) return true;
  return (text.match(/\]\(#[^)]+\)/g) || []).length >= 3;
}

/**
 * Audit one skill from its files, given as { "SKILL.md": text, "references/x.md": text, ... }.
 * Returns { name, errors: [], warnings: [] }.
 */
export function auditSkill(name, files) {
  const errors = [];
  const warnings = [];
  const skill = files["SKILL.md"];
  if (skill == null) return { name, errors: ["no SKILL.md"], warnings };

  const n = lines(skill);
  if (n >= CEILING_LINES) errors.push(`SKILL.md is ${n} lines; the ceiling is ${CEILING_LINES}`);
  else if (n > TARGET_LINES) warnings.push(`SKILL.md is ${n} lines; the target is under ${TARGET_LINES}`);

  const fm = frontmatter(skill);
  if (!fm.name) errors.push("frontmatter has no name");
  if (!fm.description) errors.push("frontmatter has no description");
  else if (fm.description.length > 1024) errors.push("description is over 1,024 characters");

  for (const [path, text] of Object.entries(files)) {
    if (!path.startsWith("references/")) continue;
    if (lines(text) > TOC_OVER && !hasToc(text)) errors.push(`${path} is over ${TOC_OVER} lines with no table of contents`);
  }

  const has = (dir) => Object.keys(files).some((p) => p.startsWith(`${dir}/`));
  if (n > TARGET_LINES && !has("references")) warnings.push("long SKILL.md with no references/ to move detail into");
  if (/\b(format|parse|validate)\b/i.test(skill) && !has("scripts")) warnings.push("mentions formatting, parsing or validation but has no scripts/");
  if (/\b(template|report|dossier)\b/i.test(skill) && !has("assets")) warnings.push("names an output format but has no assets/ template");

  return { name, errors, warnings };
}

/** Read a skill folder into the { path: text } shape auditSkill takes. Text files only. */
export function readSkill(dir) {
  const files = {};
  const walk = (d, prefix) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      if (statSync(full).isDirectory()) walk(full, rel);
      else if (/\.(md|txt|py|mjs|js|ts|sh|html|json|ya?ml)$/i.test(entry)) files[rel] = readFileSync(full, "utf8");
    }
  };
  walk(dir, "");
  return files;
}

export function auditDir(root) {
  return readdirSync(root)
    .map((entry) => join(root, entry))
    .filter((d) => statSync(d).isDirectory() && existsSync(join(d, "SKILL.md")))
    .map((d) => auditSkill(basename(d), readSkill(d)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2];
  if (!root) {
    console.error("usage: node skill-audit.mjs <skills-dir>");
    process.exit(2);
  }
  const results = auditDir(root);
  let bad = 0;
  for (const r of results) {
    const mark = r.errors.length ? "FAIL" : r.warnings.length ? "warn" : " ok ";
    console.log(`${mark}  ${r.name}`);
    for (const e of r.errors) console.log(`        error: ${e}`);
    for (const w of r.warnings) console.log(`        warn:  ${w}`);
    if (r.errors.length) bad++;
  }
  console.log(`\n${results.length} skills, ${bad} failing`);
  process.exit(bad ? 1 : 0);
}
