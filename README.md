# Applied AI Systems

I'm Griffin Jacobs, an applied AI engineer in Grand Junction, Colorado. I build AI systems that do real work for a business, and then I run them in production.

All my product code lives in private repos. This repo holds pieces I pulled out of them: the real modules with their real tests, plus a write-up for each system covering the problem, what I built, the decisions and what broke. Every module runs on its own, and CI runs every test on every push.

```bash
npm test          # Node 22.6 or later, no install step
```

## The systems

| Folder | What it is | In this folder |
|---|---|---|
| [praxis/](praxis/) | The platform my consulting firm runs on: CRM, lead research, client delivery, contracts and payments. About 200,000 lines of TypeScript, 245 test files, two editions from one codebase. | Jordan's guardrails, grade-first research planning, the realtor likelihood score with its fair-housing guard, the payment chain rules |
| [praxis/jordan/](praxis/jordan/) | Jordan, an AI sales rep built into Praxis. It emails approved leads, reads replies every five minutes and texts from its own number. | The cadence, send window, opt-out parsing, Twilio signature checks, and the daily cap held by an atomic Postgres function |
| [legwork/](legwork/) | Property intelligence for real estate agents, live at legwork.homes on web and iOS | The CI guards that keep a large app honest: every route gated, no React hook after an early return |
| [systems-go/](systems-go/) | A phone-first, game-style course that teaches people who build with AI how software works. About 65 hours across seven levels. | The deterministic assessment engine, the rewards economy, and Pip's rate-limited, spend-capped tutor endpoint |
| [tenfold/](tenfold/) | A paper-trading book that runs one approved rule every morning and scores itself against SPY, net of every expense | The net-of-expense scorecard and the backtest engine |
| [toolbox-shield/](toolbox-shield/) | Security and upkeep for my whole AI stack: 16 repos, 191 skills, 17 connectors | Secret scanning, Dependabot and agent deny-rule templates, the daily credential-health probe, the skill-audit rubric as code |
| [mission-control/](mission-control/) | A 179-agent operations system that I designed, ran, and stood down | Write-up: what it taught me about narrow agents, hard caps and human gates |
| [client-work/](client-work/) | Systems built for clients | Case studies |

## How I build

- **Guardrails live in code, not in prompts.** A cap is a database function that two overlapping runs can't both get past. An opt-out is a parser with tests. The kill switch stops the next run within five minutes.
- **A person approves before anything leaves the building.** Jordan writes only to leads I approve. Research quotes its cost before anyone presses run.
- **Pure functions hold the rules, so a test can hold them.** The pattern repeats across these folders: a rules file with no imports, beside a runner that does the I/O.
- **"Not checked" is never "safe".** Probes report unknown separately from dead. The course's security walkaround reports checked, not checked, or found.
- **Every rule has its reason in the code.** Headers say why the file exists and what went wrong before it did.

## Stack

TypeScript, Astro, React, Node, Postgres and Supabase (row-level security, migrations, pg_cron), Vercel serverless and cron, GitHub Actions. Claude and other models through the Anthropic API and OpenRouter. Stripe, Twilio, Gmail and Google Calendar, Adobe Sign, Slack, Apify.

## About this repo

The code here is copied from production repos with client data, names and project IDs removed. Comments still refer to the dates and decisions behind each rule, because that's how the code reads in the original. Questions: [griffinjacobs.com](https://griffinjacobs.com).
