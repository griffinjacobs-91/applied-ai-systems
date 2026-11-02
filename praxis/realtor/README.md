# Realtor edition: a likelihood score a person can audit

The realtor edition of Praxis runs a working agent's book of business, 2,268 contacts. Every morning it gives the agent a Today list with one reason to call each person. Part of that reason is a 1 to 5 likelihood that a contact will buy or sell soon.

## How the score works

- **Code computes it, not a model.** The rubric lives in [rubric.ts](src/realtor/propensity/rubric.ts) and prints on the card in plain words. A model may write the one-line reason, worded from the top three signals only.
- **Every signal is dated and traced to its source.** Signals come from the agent's own CRM notes, county deed records, Colorado Secretary of State filings, the public web, and People Data Labs. No date, no signal.
- **Old evidence fades.** A signal older than 24 months counts half, and older than 36 months it doesn't count.
- **A 5 needs two independent recent signals**, one of them a property or business fact. Six points without that pair is a 4.
- **Not enough data shows a dash, never a 1.**

## The fair-housing guard

[fair-housing.ts](src/realtor/propensity/fair-housing.ts). A score that leans on a protected trait, or on anything that stands in for one, steers who an agent calls. So:

1. No signal kind is built from a protected trait or a proxy: neighbourhood demographics, names read as ethnicity, school data, children, birth year, marital events, health.
2. No reader asks a provider for such a field, so one is never even received.
3. A note sentence that mentions a protected trait is not scored, even when it also states a plan. The agent reads it herself.
4. The model's one-line reason is refused if it names one.

The tests check all four, including a scan of the source readers for demographic field names.

## Run

```bash
npm run test:praxis
```
