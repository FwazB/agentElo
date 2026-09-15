# AntiSlop product direction

**Show your work → duel anytime → share the challenge.**

AntiSlop is an implemented pilot for people using AI and other tools to make
useful things. A shared referee compares two entries under the same rubric.
Personal assistants prepare evidence; their self-assigned scores do not decide
the outcome. This compares demonstrated work, not a person's worth, and does not
prove that a submission is truthful or free of AI slop.

## On-demand play

- Each entry covers exactly seven elapsed days ending at its snapshot time.
  There is no ISO-week gate. Submission and new duels require a window ending
  within the last 24 hours; entries used for a new duel must also be that recent.
- Preserve exact timestamps or the source's calendar-date precision. A boundary
  date can overlap the window without proving the work happened inside it.
- Reuse a frozen entry against different opponents. Identical normalized work
  cannot be resubmitted just by changing IDs, order, window or sharing metadata.
- The same content pair in either direction returns its existing duel within
  the season. One durable judging claim prevents a fresh model run on retry.
- Pilot caps are ten duels per participant per UTC day, 100 globally, and one
  in-flight duel per participant. These are capacity controls, not a weekly
  scoring requirement or proof of unique people.

## One-page flow

The Pollen-inspired pop-art presentation uses the main page for the arena and
recent results, with shared modals for preparation, results, accounts and Form.
Routes open those states rather than separate competing product flows:

| Route | State |
| --- | --- |
| `/` | Start a duel, challenge a friend, arena and recent duels |
| `/challenge/<entryId>` | Public invitation preview and accept action |
| `/duel/<duelId>` | Pending, judging, completed or failed duel result |
| `/form` | Existing personal Form workflow |

1. Copy the server's preparation prompt and use existing authorized AI context.
2. Paste the draft; local preview uploads nothing. Review every evidence excerpt.
3. Approve referee processing and separately allow public challenges/results.
4. Challenge an arena entry or share a friend invitation. An empty arena shows
   an invitation state; it never manufactures an opponent.
5. Receive the structured verdict and reason. Share the result or meet another
   opponent. A failed or expired attempt stays unrated and is not rerolled.

Optional public summary text is written and approved separately. Challenge opt-in
makes player metadata, dates and structured duel outcomes public; it does not
release private evidence or raw referee explanations. Pausing challenges stops
new matches and arena listing, while previously approved public records remain.

## Same referee, both orders

The rubric considers completion, usefulness, quality and checks. Hours, focus,
tool brands, personal Form and Elo are outside its judgment. Concise fixes,
maintenance and applied learning can compete; missing information differs from
documented weak or unfinished results.

Each admitted duel receives A/B and B/A judgments with the same configuration,
prompt and aggregation rule. Outcomes are A wins, B wins, draw or unrated. Order
disagreement, insufficient evidence and incomparable entries stay unrated.
Refusals, malformed responses and timeouts produce a failed, unrated attempt.
The fixed provider/model ID is an operating choice, not a guarantee of immutable
weights or referee accuracy.

**Every pilot result has `ratingEligible: false`; no AntiSlop duel changes Elo.**
A supported draw is a draw, but has no rating effect in this pilot. Personal Form
and historical ratings retain their original meaning. A future ranked season
requires actual human calibration and its own reviewed ledger/version decision.

The implementation stays in one AntiSlop feature PR in the primary checkout.
See [operations](antislop-operations.md) for the live adapter, storage and release
limits, and [calibration](referee-calibration.md) for the remaining human evidence.
