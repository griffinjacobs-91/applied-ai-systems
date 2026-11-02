# Mission Control: 179 agents, and why I stood them down

Before Praxis, I built an operations system out of agents: 179 Claude agents in 22 teams, running 28 scheduled loops over my business. It had a live cockpit app (Astro, Preact, Supabase Realtime, Vercel) where I could watch agents work and move cards. An Obsidian vault served as the knowledge layer, and a write contract defined what every agent recorded and when. The repo reached about 179,000 lines with 113 tests.

```
  Agents (scheduled and dispatched from the dashboard)
        │  write status, task changes, audits, events
        ▼
  Supabase: the live operational spine (Postgres and Realtime)
        ▲                                   │
        │ vault and database sync (loops)   │ realtime subscribe
        │                                   ▼
  Obsidian vault                       Web cockpit, desktop and phone
  (knowledge and human edits)
```

## What it taught me

I stood it down in August 2026. These lessons are what everything since is built on:

1. **Narrow agents beat broad ones.** An agent with one job and one table to write to can be tested. A team of agents with overlapping jobs can only be watched.
2. **Caps belong in the database.** A limit an agent is told about in a prompt is a suggestion. A limit enforced by a database function that two runs can't both get past is a rule. Jordan's daily cap is built that way.
3. **A person approves before anything leaves the building.** Internal work can run unattended. Anything that reaches a customer, spends money, or can't be undone waits for a yes.
4. **Don't build shared infrastructure on your least-trusted system.** When I added cross-app credential checks, I moved them off Mission Control and into a daily CI job in a repo I actually use.
