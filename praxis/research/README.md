# Research room: grade first, spend later

Praxis researches small-business leads before Jordan writes to them. Deep research costs real money per lead, so the room grades a whole backlog cheaply first, on public review pain, and spends only on the leads worth it. The first full run graded 696 leads for under 3 cents in total.

This folder holds the scheduler that decides what runs next ([plan.ts](src/research/plan.ts)) and the pain scoring ([signals/pain.ts](src/signals/pain.ts)).

## Why the scheduler is its own file

A runner that decides and acts in the same breath can't be tested, and an untested scheduler is how a batch quietly burns a budget on the same work eight times. So `plan.ts` is pure. Every function takes the current time it should reason about, and does no I/O.

- `pickStage`: which stage runs next, in a fixed order.
- `withinBudget`: a cap of zero means no budget, not unlimited. Spending exactly to the cap is allowed.
- Wall-clock limits, which trade and town pairs still need probe runs, and whether another run's lock has gone stale (15 minutes) so it can be taken over safely.

In production the room also quotes the count and cost before anyone presses run, and nothing reaches a customer until I approve the lead.

## Run

```bash
npm run test:praxis
```
