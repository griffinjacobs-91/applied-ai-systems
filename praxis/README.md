# Praxis

The operating platform for my consulting firm. I built it alone, test-first.

- **Scale:** about 200,000 lines of TypeScript and Astro, 178 routes, 130 API endpoints, 15 scheduled jobs, 245 test files, 71 database migrations, 270 pull requests.
- **Stack:** Astro and TypeScript on Vercel, Supabase Postgres with row-level security, GitHub Actions.
- **Integrations:** Stripe, Adobe Sign, Gmail, Google Calendar, Cal.com, Slack, Twilio, Apify, Plaud, and models through Anthropic and OpenRouter.

## What it does

```
            ┌──────────── Leads ────────────┐
 research → │ grade → playbook → approve    │ → Jordan (email, text, booking)
            └───────────────────────────────┘
                                │ booked call
                                ▼
 Clients: SOW and MSA → e-signature → Stripe deposit → delivery → acceptance → final payment
                                ▲
 Training grounds: call simulator, AI role-play, AI grading of real calls, sales kit
```

- **Five rooms, role-based seats.** Owner, sellers and clients each see their own part. A commissioned sales partner gets first-run onboarding and their own pipeline, and never sees the firm's margin.
- **Two editions from one codebase.** The firm's sales CRM, and a realtor edition that runs a working agent's 2,268-contact book of business. A deploy refuses to start if its edition and its database disagree.
- **Research room.** Grades a lead backlog on public review pain before spending on anything deeper. It graded 696 leads for under 3 cents in total.
- **Client delivery end to end.** Audit and deck generators, SOW and MSA drafting, e-signature, acceptance certificates, a webhook-driven payment chain, and meeting transcripts turned into decisions and next steps.

## In this folder

| Folder | Tests | What it shows |
|---|---|---|
| [jordan/](jordan/) | 40 | An AI agent's guardrails held in code and in the database |
| [research/](research/) | 18 | A scheduler that can't overspend or run the same work twice |
| [realtor/](realtor/) | 32 | A likelihood score a person can audit, with a fair-housing guard |
| [payments/](payments/) | 56 | Money automation that never double-charges and never re-sends an invoice someone sent by hand |
