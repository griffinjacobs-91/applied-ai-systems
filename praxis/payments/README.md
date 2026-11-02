# Payments: money automation with a person in the loop

When a contract is marked signed, Praxis mints the Stripe link and emails the client the ask. That's money leaving on its own, at a client, with no person reading it first. So the question "should this deal be emailed right now" is answered in [payment-chain-rules.ts](src/payment-chain-rules.ts), a file with no imports that a test can hold in its hand.

## The rules that matter most

- **Never re-send an invoice a person sent by hand.** Deals invoiced before the automation existed carry an invoiced stamp but no chain email. Automation leaves them alone. Only a person pressing Send now gets past this rule.
- **A client who pays by bank transfer is never offered a card link.** Payment method is a fact about the client, so it's checked before anything else.
- **The skip order is the specification.** Checks run cheapest and most decisive first, so the reason a deal was skipped is the first true thing about it.
- **The final payment waits for signed acceptance.**

[money-guard-rules.ts](src/money-guard-rules.ts) adds the guards around the money path: whether what Stripe collected matches what that half should cost, spotting a forged request shaped like a Stripe webhook, and flagging a payment that has sat pending too many business days.

## Run

```bash
npm run test:praxis
```
