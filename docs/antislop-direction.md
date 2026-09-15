# AntiSlop product direction

**Show your work → duel anytime → share the challenge.**

AntiSlop is a game for people using AI and other tools to make useful things.
A shared referee compares the evidence in two entries. Personal assistants help
prepare entries; their self-assigned scores do not determine the match outcome.
The competition measures demonstrated work under a published rubric. It does
not establish a person's worth or prove that their account of work is true.

## Cadence

- Each entry describes a rolling seven-day evidence window ending at its
  snapshot time. This supplies context for substantial work and quieter days.
- Players can approve a new snapshot whenever they have work to include. There
  is no ISO-week boundary or calendar reset in the new entry contract.
- Duels are on demand. A frozen entry can face multiple different opponents
  without requiring the player to invent new work between matches.
- Exact match retries return the recorded result. Ranked rematch restrictions
  belong to the participant pair, so new entry IDs or rewritten text cannot
  reset them. Their limits will be selected from pilot evidence, not a weekly
  play restriction.
- A weekly recap summarizes activity; it does not control access to play.

## First-use and sharing flow

1. Prepare a short recap with selected evidence.
2. Review the exact material to share with the referee and approve it.
3. Enter a matchup or send a friend a direct challenge link.
4. Receive a verdict and a short explanation.
5. Choose **New opponent**, **Challenge a friend**, or **Share**.

A challenge link opens that matchup with an entry preview and an **Accept
challenge** action. Private evidence and referee explanations do not become
public automatically. Public text requires its own explicit review and approval.

The growth measure is completed duels that produce another completed duel through
a shared challenge. Record invitation opens, acceptance, completion, further
invitations, time to first verdict, and repeat participation to explain that rate.
An empty queue needs an honest waiting/invitation state; invented opponents or
scores would undermine the premise.

## Competition

The shared rubric evaluates demonstrated completion, usefulness, quality and
checks. Focus, hours worked and tool usage volume are outside the referee's
judgment. Concise fixes, maintenance and learning applied to an outcome can
compete. Missing information differs from evidence of weak or unfinished work.

Every match receives independent A/B and B/A judgments with the same frozen
provider snapshot, rubric, prompt, inference settings and aggregation policy.
The outcomes are A wins, B wins, draw or unrated. A supported draw has a result of
0.5 and can move Elo. Insufficient evidence, incomparable entries or conflicting
order judgments are unrated and produce no rating update.

The current Form score remains a personal assessment. Existing ratings and
receipts retain their original meaning. Referee-based ranked play starts in a
separate season and updates Elo only through its recorded, server-authoritative
match results. A provisional label alone does not authorize an untested judge.

## Delivery in one feature PR

All AntiSlop work stays in the primary checkout on `feat/antislop` and in one
feature PR. The scoring-recovery fix is a separate PR.

The first implementation is the offline foundation:

- Strict, bounded entry snapshots with evidence links and separate public text.
- Metadata-blind request packets and response-to-pair/configuration binding.
- Conservative resolution of order disagreement.
- Calibration reports with human disagreement, repeatability, order consistency,
  abstention and denominators, reported separately on calibration and holdout sets.
- Synthetic smoke fixtures that cannot establish referee quality.

The same feature PR can then carry the provider adapter, evidence review UI,
private storage lifecycle, on-demand matching, challenge links, duel cards and
new-season ledger after their contracts and calibration evidence are ready.
See [the calibration workflow](referee-calibration.md) for the next concrete step.
