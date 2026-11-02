# Legwork: property intelligence for agents

[legwork.homes](https://legwork.homes), live in production on the web and as an iOS app. It's my own company.

An agent enters an address. Legwork pulls the parcel and deed records from the county, plus permits, tax and hazard layers and comparable sales, then writes a brief the agent can walk into a showing already knowing. On the listing side it builds a CMA, a seller net sheet, and a no-login portal the agent shares with a buyer.

- **Scale:** the largest of my codebases. An API server, a React web app and an iOS build from one workspace.
- **CI:** 16 workflows, including county data canaries, prompt-regression and model-drift checks, post-deploy smoke tests, and a daily credential-health watch across three apps.
- **What it taught me:** price by cost per output, read a data license before you build on it, and make every rule that matters a check that fails the build.

## In this folder: guards that run in CI

A big app drifts in ways no code review reliably catches. These scripts turn two of those drifts into a red build.

| Script | What it catches | Tests |
|---|---|---|
| [check-route-auth.mjs](scripts/check-route-auth.mjs) | A new HTTP route that ships with no authorization check. In this API, auth is a line each handler has to remember. Forget it and the endpoint ships open, with nothing going red. The script walks every route file and fails unless each route is gated or declared public with a reason. | 43 |
| [check-hook-order.mjs](scripts/check-hook-order.mjs) | A React hook called after an early return. One reached production, found by a user. The script strips strings, comments, regexes and JSX before counting braces, so it doesn't misread the code. | 14 |

Both tests build throwaway source trees and run the real script against them, including trees built to fool it.

## Run

```bash
npm run test:legwork
```
