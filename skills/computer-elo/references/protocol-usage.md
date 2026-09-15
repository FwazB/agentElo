# Protocol Usage

The engine lives at `packages/elo-engine` and is independent of Computer History. The skill wrapper forwards directly to its CLI.

Node.js 22 or newer is required. `form` and `duel` also require the local
`rsvg-convert` executable from `librsvg` so every successful card command emits
both SVG and PNG; the renderer is checked before any output is written.

## Form

```text
npx tsx scripts/computer_elo.ts form \
  --player-id p_<32 lowercase hex> \
  --competition-id c_<32 lowercase hex> \
  --week 2026-W35 \
  --form-score 835 \
  --coverage-ppm 900000 \
  --certainty-ppm 850000 \
  --out-dir <new-empty-dir>
```

Omit opaque IDs only when creating a new solo receipt. Friends must share the same competition ID. Use `--prior-receipt` to carry both Elo streams forward into a new weekly Form receipt.

## Duel

```text
npx tsx scripts/computer_elo.ts duel player-a.json player-b.json \
  --mode scalar \
  --match-id m_<32 lowercase hex> \
  --out-dir <new-empty-dir>
```

Use `--mode binary` for the ordinal mode. Rated output includes updated player receipts. Exhibition output includes only the match receipt and card.

## Other commands

```text
npx tsx scripts/computer_elo.ts validate receipt.json
npx tsx scripts/computer_elo.ts leaderboard player-a.json player-b.json --mode scalar --out-dir <dir>
npx tsx scripts/computer_elo.ts simulate --mode scalar <explicit numeric inputs>
```

Every output directory must be new or empty so stale receipts cannot be mistaken for current output. Exact arithmetic, schemas, canonical JSON, and fixed vectors are documented under the project `protocol/` and `fixtures/` directories.
