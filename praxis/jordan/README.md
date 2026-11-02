# Jordan: an AI sales rep's guardrails

Jordan is the AI sales rep built into Praxis, about 30,000 lines. It researches leads I approve, writes and sends cold email, reads the inbox every five minutes, answers replies, books calls on my calendar, and answers texts from its own number.

An agent that sends email for a business can do real damage in one bad loop: burn a domain's reputation, write to someone who said stop, or send at 2am. This folder holds the rules that stop that, pulled out with their tests.

## The rules

| Rule | Where | How it holds |
|---|---|---|
| At most 15 first messages per Mountain day (set to 5 in production) | [first_touch_cap.sql](first_touch_cap.sql) | An atomic Postgres function. Two overlapping runs can't both take the last place: the row lock makes the second one re-read and get "no". If the function is missing, the run sends no first messages (it fails closed) and the cron alarm fires once a day. |
| Email goes out weekdays 9 to 5 Mountain. Texts go out 8 to 8. | [src/jordan/sequence.ts](src/jordan/sequence.ts), [time.ts](src/jordan/time.ts) | Servers run in UTC, so every rule reasons in America/Denver, including daylight-saving changes. |
| Cadence: day 0, 3, 7, 14, then a 90-day revive | sequence.ts | `nextTouch` returns the next step, or a reason there is none: do not contact, replied, handed to a person, booked. |
| One message per channel per day per lead | sequence.ts `touchedToday` | Checked against what was actually sent. |
| STOP, "no thanks" and carrier keywords end the conversation | [channels/twilio.ts](src/jordan/channels/twilio.ts) | Parsers with tests for every phrasing that has come up, including STOP inside a longer sentence. |
| "Not now, try me in March" is honored | sequence.ts `deferDate` | Reads the date. If the date is unclear, it hands the lead back to a person rather than guess. |
| Only Twilio can post a text in | twilio.ts | HMAC signature check on every webhook. |

Pause stops the next run within five minutes. A person approves every lead before Jordan writes to it.

## Run

```bash
npm run test:praxis
```
