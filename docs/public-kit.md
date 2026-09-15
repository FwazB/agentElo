# Computer Elo scoring kit

This optional kit runs locally. Most players can give their AI [the public scoring reference](https://computer-elo.vercel.app/rate.md), then paste its approved aggregate result into the website. The kit does not collect activity, connect to the league, upload evidence, or require a model API key. Your own assistant assesses evidence you already chose to make available to it. The website and public reference MCP do not provide access to your computer history.

## Rate a week

1. Install Node.js 22 or newer. Extract this kit, open its folder, and run `npm ci --ignore-scripts`. The included lockfile pins the dependency tree and integrity checks.
2. Give your local assistant `skills/computer-elo/SKILL.md` and `skills/computer-elo/references/form-rubric.md`, plus the assessment prompt copied from your league player page. If Computer History is unavailable, use another evidence source you explicitly approve; report the reduced coverage honestly. Do not invent missing observations.
3. Assess the last completed ISO week, Monday 00:00 UTC through the next Monday. First check that authorized evidence from that week can ground all five dimensions. Otherwise ask for the smallest missing private examples and return no numerical score, receipt, or card. When supported, score the dimensions before looking at earlier scores: output and closure (30%), focus (25%), workflow leverage (20%), verification (15%), and operational hygiene (10%). Form is the weighted result, rounded half up, from 1 to 1000. Keep the evidence and dimension notes local.
4. Estimate evidence coverage and evaluator certainty separately in parts per million, from 0 to 1,000,000. Effective confidence is the lower of the two. Zero on either axis means no score. Grounded positive confidence below 500,000 is exhibition-only. These are game scores, not validated population rankings or a measure of human worth.
5. Generate a public receipt using ONLY the approved aggregate values. Replace every example value below with the actual assessment and target week:

```sh
npm run --silent receipt -- --week YYYY-WNN --form-score SCORE --coverage-ppm COVERAGE --certainty-ppm CERTAINTY > weekly.receipt.json
```

The player and competition IDs can optionally be passed with `--player-id` and `--competition-id` from the website. If omitted, the kit creates opaque IDs. The league maps the receipt to your signed-in account and uses its own rating ledger; it never imports a claimed Elo rating.

The lightweight `receipt` command requires no image renderer. The existing `computer-elo form` and `duel` commands additionally need `rsvg-convert` from librsvg for PNG cards. They remain available for offline use.

## Preview, then publish

Open the JSON yourself. Its content must contain only opaque IDs, the ISO week, aggregate Form and confidence, protocol constants, Elo state, and a fingerprint. Never add names, handles, notes, URLs, history, prompts, window titles, filenames, or project details. Unknown fields are rejected.

Choose the receipt on the website, review its score, confidence and week, and explicitly publish it. Publishing makes those aggregates public. A new hosted player begins at 1200 in each Elo stream. Joining a matchup separately opts you into a duel. Each player gets at most one matchup per week per mode, and a queued week's Form is locked even if the queue is later cancelled.

Scores are self-attested. A SHA-256 fingerprint checks content integrity; it is not an identity signature or proof that an assessment is true.

Save your private account recovery key separately. It grants control of your player. Never include it in a receipt, screenshot, card, or public message.
