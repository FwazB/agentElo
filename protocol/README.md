# Computer Elo Protocol 1.0.0

This directory is the public interoperability contract for Phase 1.

## Separate quantities

- **Computer Form** is an integer from 1 through 1000. It summarizes one finalized weekly assessment. In `computer-form.general.v1`, an ISO week runs from Monday 00:00:00 UTC inclusive to the following Monday 00:00:00 UTC exclusive. The evidence used to produce it is private and is never accepted by the public receipt schema.
- **Computer Elo** is a relative rating stored as signed integer millipoints. Every player begins each mode at `1200000`, displayed as `1200.000`.
- **Confidence** has evidence-coverage and evaluator-certainty axes in parts per million. Effective confidence is their minimum. A match uses the lower effective confidence of its two players.

Binary and scalar Elo are separate streams. A match updates only the selected stream.

## Files

- [formulas.md](formulas.md) fixes both formulas, eligibility, precision, rounding, and K behavior.
- [canonical-json.md](canonical-json.md) defines canonical bytes and receipt fingerprints.
- [public-receipt.schema.json](public-receipt.schema.json) is the Draft 2020-12 structural schema for player, match, and leaderboard receipts.
- [privacy.md](privacy.md) defines the public allowlist and required leak tests.
- [`../fixtures/test-vectors.v1.json`](../fixtures/test-vectors.v1.json) supplies golden cross-language outputs.

## Compatibility and exhibitions

A duel is rated only when both receipts are valid, the players are distinct, both effective confidences are at least `500000`, and these values match exactly:

- competition ID;
- ISO week ID;
- Form version;
- confidence version;
- protocol/schema version.

Low-confidence or otherwise incompatible well-formed comparisons are exhibitions: their applied deltas are zero and rated-match counters do not change. Malformed data, self-matches, unknown versions, and invalid fingerprints are rejected.

The evidence-window convention is part of the Form version. Changing its
timezone or boundaries requires a new Form version, so identically labeled
weeks cannot silently cover different intervals.

## Security boundary

Receipts are self-attested local artifacts. SHA-256 fingerprints detect content changes; they are not signatures, identity proof, an authoritative ledger, or anti-cheat. A future hosted competition will need authenticated identities and an append-only match log without changing the v1 arithmetic.
