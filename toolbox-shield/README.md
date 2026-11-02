# Toolbox and Shield: security and upkeep for an AI stack

I build with Claude Code and Codex every day, across 16 repos, about 191 skills, 22 plugins, 17 connectors and 13 mods. A setup that size breaks quietly: a key expires, a secret lands in git history, a skill stops firing because the listing is too long. This project keeps it secure, safe and accurate, in that order.

## What it does

- **Inventory and a weekly health check.** It finds stale, duplicate or overlapping skills and plugins, probes every connector, and checks for upstream updates. The weekly run posts only what changed. Unused tools get turned off, never deleted.
- **Shield baseline across all 16 repos.** It searched code and git history for secrets, found one real leaked key, and rotated and verified it the same day. It added secret scanning on every push, Dependabot, and deny rules that keep AI agents from reading .env files.
- **Intake gate.** Every new open-source tool, skill or how-to is checked for supply-chain risk (dependencies, install scripts, hooks, network calls), then adopted, trialled for 14 days, or declined.
- **Credential health.** Each production app probes its own keys and answers with verdicts only. A daily job asks all of them and goes red on a dead key.

## In this folder

| Path | What it is | Tests |
|---|---|---|
| [src/credential-probes.ts](src/credential-probes.ts) | The in-app key probes. Read-only and cheap. "Unknown" is never "dead". Checks balances where the vendor exposes one, and probes the capability that matters (can it send, not just can it read). Metered APIs are never probed on a tight schedule. | 19 |
| [credential-health/](credential-health/) | The daily watcher, with three outcomes: green, red, or inconclusive (the monitor is down, which is different from a dead key). It runs a forced-fail mode to prove the red path works. | 20 |
| [skill-audit/](skill-audit/) | The written skill rubric as a check: SKILL.md under 500 lines (target 200), long references need a table of contents, deterministic steps belong in scripts/, output formats get templates, and the frontmatter says when to use the skill. | 6 |
| [templates/](templates/) | Drop-in files: the secret-scan workflow, Dependabot config, agent deny rules, and the credential-health workflow. | |

## Run

```bash
npm run test:shield
node toolbox-shield/skill-audit/skill-audit.mjs ~/.claude/skills
```
