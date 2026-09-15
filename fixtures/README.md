# Fixtures

`test-vectors.v1.json` is the language-neutral arithmetic and canonical-JSON contract. The TypeScript implementation reproduces every serialized probability, raw delta, integer millipoint delta, post-match rating, confidence boundary, and fingerprint exactly.

`e2e/` contains deterministic command-level examples built with fixed opaque IDs:

- `placement-a/`, `placement-b/`, and `placement-low/`: initial Form receipts, SVG cards, and PNG cards;
- `scalar-duel/`: a rated scalar match plus both updated player receipts;
- `binary-duel/`: the same placement pair rated in the independent binary stream;
- `exhibition/`: a low-confidence comparison with no updated player receipts;
- `leaderboard/`: a scalar leaderboard built from the two scalar-updated receipts.

No fixture contains collected Computer History data or any private evidence. The IDs, week, scores, and confidence values are synthetic protocol inputs.

`packages/elo-engine/tests/receipts.test.ts` reconstructs every receipt and
SVG from the fixed inputs and requires byte-for-byte equality. It also verifies
that every PNG is 1200×675 and contains no PNG text-metadata chunk, preventing
checked-in examples from silently drifting away from the engine.
