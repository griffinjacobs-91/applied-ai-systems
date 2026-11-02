# Client work

Systems I built and ran for clients through my firm. Case studies only: no client code or data lives in this repo.

## Referral desk for a property inspection company (live)

Nearly all of this inspector's work comes from real estate agents' referrals. He was strong at first contact. The leak was follow-up.

- A referral CRM over about 196 agents. It tracks buyer-side and seller-side inspection counts from his real inspection history, with "Never" shown loudly when he has never reached out.
- **Draft, then confirm.** Tapping Email or Text picks a template, stores the exact draft, and opens his own Mail or Messages. Then he confirms "sent" or "didn't send", so the log can never claim more than really happened.
- **An automated cadence that only drafts.** A pg_cron job inside Supabase runs every morning and writes drafts: a thank-you the day after an inspection, an intro for listing agents, and others. Nothing is sent without him.
- **Inspection software webhook.** Raw payloads are always kept, inspections are upserted, and agents are matched automatically.
- Scoped, delivered and signed off under a statement of work, and paid in full.

## AI search visibility for a real estate team

Buyers had started asking AI assistants which agent to use, and this team rarely came up. I measured it first: 120 real buyer questions across the major answer engines, scored before and after. The gap turned out to be in how their listings and profiles described them, not in their ads. I rewrote what the engines read, then re-ran the same 120 questions to measure the change.

## A working agent's book of business

The realtor edition of [Praxis](../praxis/realtor/) runs one agent's 2,268 contacts. For the same agent I built and deployed her website (Astro, Tailwind, MDX on Vercel) and a content pipeline that drafts and schedules her social posts.

## A store run as a repo

A print-on-demand art store whose whole operation lives in one repo: Shopify checkout, printing and shipping through Printify, the same products on Etsy, and a Claude plugin. Two people run it through Claude Code, one making the store's decisions, the other owning the accounts and brand. Every session starts from a progress board with copyable prompts.

## Client Synthesis

Drop in a call transcript and get back a re-synthesized client profile: open commitments, unanswered questions, resolved items, suggested next moves, sentiment and recurring themes, with a diff per recording over time. The synthesis engine is pure, so it runs with no backend at all. The same idea runs inside Praxis on every recorded client call.
