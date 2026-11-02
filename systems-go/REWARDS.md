# Rewards: points, ranks, coins, the rig, hints and the streak

Approved by Griffin on 2026-10-29 (design page: the "Streak, coins, hints and your vibe coder" artifact). Code: `rewards.js` (economy, coins, rig shop, hints), `rewards.css`, and the hooks in `game.js` (ranks, unit points, waypoints, the streak rule, the status row). Tests: `test/rewards.test.js`, which reads the built `index.html`, so a course change that breaks a claim below fails the tests.

Stage 1 (this file) is the economy. Stage 2 is the 3D hangar: the rigged coder by level, the gear as models, ribbons and patches worn as decals, the sit-down into a lesson, and the motion set.

## 1. The rules in one table

| | rule | where |
|---|---|---|
| Points for a section | 2 per minute of its estimate, x1.25 labs and drills, x1.5 builds and bridges, rounded to 5, at least 10 | `ECON.unit`, `unitPoints()` |
| Waypoint reached | 50, once, when the section carrying it is done or tested out | `ECON.waypoint`, `game.js` lesson_done |
| Lesson check | 20 first try, 8 later (unchanged) | `game.js` |
| Level final / jump-ahead test | 50 / 30 (the assessment engine, PR #15) | `game.js` on #15 |
| Jump-ahead test passed | also credits the unit points and waypoints of the sections it tested out; doing one later pays nothing more for the unit | `creditSkipped()` |
| Extra credit | 4 first try, 2 after a miss or a hint (was 10/5; see section 4) | LEVELS.json `assessment.extra` on #15 |
| Homework note | 10 (was 30; see section 4) | `game.js` hwNote |
| Ranks | 8, about one every 10 hours of course | `ECON.ranks` |
| Coins | floor(points / 10) + sign-in coins - spent, never stored as a balance, never below zero | `earned()`, `balance()` |
| Sign-in | 5 coins on the first open of each calendar day, 15 on every 7th day in a row | `signIn()` |
| Spending | only with the coins already in hand; never lowers points or rank | `spend()` |
| Rig gear | 21 pieces, 1,460 coins, each opening at a waypoint | `GEAR` |
| Hints | extra credit only; nudge and narrow, 3/5 coins (levels 1 and 2), 4/7 (3 to 5), 5/9 (6 and 7); refused on checks, finals and jump-ahead tests and while any counting clock runs | `SGHints`, `hintAllowed()` |
| Streak | a calendar day counts at 10 points; a ticker counts down to midnight until it does; freezes as before; `ECON.streak.mode = 'rolling'` switches to a strict 24 hours | `game.js` touchStreak, `streakNow()` |
| Daily goal | 50, 100 or 200 points (about 13, 25, 50 minutes) | `ECON.goals` |

## 2. What the course pays

Read from the built page: 151 sections in the levels, about 65 hours. A learner who does every section, check and homework tick, and nothing optional:

| learner | course total |
|---|---|
| misses every first try | about 13,900 |
| 40% of first tries | about 14,700 |
| 70%, half the notes, the simulators, half the extra credit | about 16,900 |
| 95% and everything optional | about 18,900 |

Points a minute by kind, before and after (the old flat 25 paid a 52-minute build a fifth of what a 10-minute lesson paid a minute):

| kind | today | now |
|---|---|---|
| lesson | 2.6 | 2.0 |
| reading | 1.4 | 2.0 |
| field | 2.0 | 2.1 |
| lab | 0.7 | 2.5 |
| drill | 0.5 | 2.5 |
| build | 0.5 | 3.0 |
| bridge | 0.6 | 3.0 |

## 3. Ranks

Thresholds sit where the 40% learner, doing nothing optional, reaches hours 3, 11, 20, 30, 40 and 50, and Flight Director needs the course finished (the learner who misses every first try still gets there at the end).

| rank | points | hour (40%) | hour (70%, typical extras) | hour (everything) |
|---|---|---|---|---|
| Cadet | 0 | 0 | 0 | 0 |
| Pilot | 700 | 3 | 2 | 2 |
| Navigator | 2,700 | 11 | 9 | 8 |
| Flight Lead | 4,800 | 20 | 16 | 14 |
| Flight Engineer | 6,950 | 30 | 25 | 21 |
| Mission Specialist | 8,950 | 40 | 33 | 29 |
| Commander | 11,300 | 50 | 43 | 37 |
| Flight Director | 13,500 | 60 | 51 | 45 |

Hours are course hours (the sections' estimates). Optional work takes real time that the estimates don't count, about 10 to 13 hours for every note and extra-credit item, so in real hours the gap between the typical and the everything learner is smaller than the table shows. The status row shows "N to the next rank, about H h of lessons", worked out from the minutes and points of the sections still ahead.

## 4. Red team of the economy (2026-10-29)

1. **Optional items were a points farm.** Extra credit paid 10 for a 40 to 90 second question and the homework note 30 for one line: 5 to 10 points a minute against about 2.3 for the lessons. With about 500 extra-credit items once the old multiple choice moves there, a learner farming them would have ranked about 30% early. Fixed: extra credit 4 and 2 (the assessment thread set it on PR #15), the note 10.
2. **Ranks were calibrated without homework, simulators, the level final and the jump-ahead credit.** Recalibrated on the path every finisher walks (sections, checks, homework ticks, waypoints, finals), with optional work only making ranks come sooner.
3. **A jump-ahead test skipped points.** A tested-out learner would have ranked a level behind what they showed, and their rig would have stayed locked at the skipped waypoints. Fixed: the test credits the tested-out sections' unit points and waypoints, once; sections a missed slot still sends you to are not credited.
4. **Sign-in coins could buy ahead of learning.** They can't: every piece of gear opens at a waypoint. Sign-in coins only make gear affordable sooner and pay for hints.
5. **Points can fall** (a homework unticked takes its 10 back), so earned coins can fall below what was spent. The balance shows 0, never negative, and nothing is taken back.
6. **Done can be undone.** The shell derives done from the work (a re-answered check can un-finish a section). Points and owned gear stay; a waypoint's gear that wasn't bought yet closes again until the section is done.
7. **Hint lock in depth.** The engine never offers a hint on a check, final or jump-ahead test, or while a counting clock runs; the hint layer refuses those again on every click; `.sg-testing` hides any hint bar already drawn. Narrow on a choice item grades through the engine's `ctx.check`, because answers ship as hashes.
8. **Everything is in this browser.** Clearing site data resets coins, the rig and the streak, and someone could edit their balance. Harmless: coins buy cosmetics and hints on questions that never count. Real enforcement needs accounts.
9. **Gear pace.** Simulated day by day at 20 minutes x 3 days a week, 45 x 5, 60 x 7 and 120 x 7, with 40% first tries and a hint every two hours: every pace owns all 21 pieces by the finish, the first purchase comes on day one, and a newly opened piece is affordable within about a session. A learner buying a hint every hour at 2 hours a day ends one piece short, which is the rule working: hints cost more than they pay.

## 5. The contract with the assessment engine (PR #15)

- The engine calls `SGHints.offer(itemEl, {assessment, item:{id, kind, q, o, hint, see, tip}, level, tier, kind, check})` on extra-credit items only. `check(i)` grades a choice option through `SGAssess.check`.
- A bought hint sets `data-hinted="1"` on the item, so a right answer pays the after-a-miss amount and is never a first try, and dispatches `sg:event` `hint_bought` `{assessment, item, which, price, level}`.
- `assessment_passed` with key `gate:<level>` credits the level's tested-out sections (its lessons minus `last.take`).
- `hints_locked` and `hints_unlocked` repaint any hint bar.

## 6. Gear and where it opens

| piece | coins | opens at |
|---|---|---|
| Mug | 10 | the start |
| Laptop stickers | 15 | the start |
| Desk lamp | 40 | You can see inside any page |
| Real desk | 70 | Your machine is ready |
| Headphones | 45 | The agent works under your rules |
| Desk chair | 55 | Main is guarded |
| Whiteboard with your system map | 70 | Spec on file |
| First monitor | 60 | First change landed |
| Mechanical keyboard | 70 | Fuelled and ready |
| Plant | 50 | First rollback |
| LED strip | 70 | Own call sign |
| Second monitor | 95 | Every door checks |
| Home server rack | 75 | Your own rows |
| Standing desk | 85 | Scripts and guesses refused |
| Espresso machine | 90 | A capped bill |
| Ultrawide screen | 100 | First money |
| Status wall | 95 | Normal, written down |
| Porthole on orbit | 75 | The slow afternoon |
| Captain's chair | 80 | The quiet failure |
| Patch wall | 90 | Capsule on the pad |
| Command console | 120 | the whole course done |

A waypoint renamed in ORDER.txt must be renamed here and in `GEAR`; the tests fail until it is.
