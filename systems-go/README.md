# Systems Go: how code ships

A phone-first, game-style course for people who build software with AI tools but never studied how it works. It runs about 65 hours across seven levels, from how a website loads to a paid app in the App Store. I built it first for myself.

Each level adds a way of working the earlier ones didn't use:

| Level | You learn to |
|---|---|
| 1. Ground school | Take apart live sites in browser devtools |
| 2. Preflight | Set up a machine, terminal, git and an agent workspace from zero |
| 3. Go / no-go | Judge an AI agent's pull requests, some with planted bugs |
| 4. Launch | Recover from failed deploys, roll back and read logs, against a clock |
| 5. Life support | Break into your own app, then close each hole |
| 6. Orbit | Take payments, run on call for a week, write a postmortem |
| 7. Touchdown | Get through App Store review |

Before Level 1, a 45-minute read-only **walkaround** checks the learner's real app for a key in the shipped front-end, secrets in git history, database tables readable while signed out, AI endpoints with no spend cap, and more. Every check reports checked, not checked, or found, never "safe". It ends with a one-page brief for a human developer.

## In this folder

- **[src/assess.js](src/assess.js): the assessment engine.** Deterministic grading with no AI, so it works offline in the free tier. Answers ship as hashes, never in plain text. Eight item types: write a line of code, fix a broken line, spot the bad lines, match, order, short answer, choice, and evidence pasted from your own app. The pass mark is 90%. Tests are timed by item type, and cooldowns double after each failure in a row. A skip test routes you to the lessons you missed instead of failing the whole level. The progress ledger only moves toward more tries and longer locks, so clearing your browser can't shorten a cooldown.
- **[src/rewards.js](src/rewards.js): the rewards economy.** Points by minutes and kind of work, eight ranks, and coins derived from points so spending never lowers a rank. Hints cost more than they pay. The numbers and reasons are in [REWARDS.md](REWARDS.md).
- **[api/ask.js](api/ask.js): Pip, the tutor.** One serverless function, one model call per question, a per-visitor daily limit and a hard monthly spend ceiling.

## Run

```bash
npm run test:systems-go
```
