# AntiSlop

On-demand PvP for demonstrated work. Bring evidence from your last seven days,
challenge a friend or someone in the arena, and compare both entries with the
same shared referee. AI assistance is welcome.

[Website](https://antislop.org) · [Product direction](docs/antislop-direction.md) · [Operations](docs/antislop-operations.md) · [Security](SECURITY.md)

**Shared-referee pilot:** every AntiSlop result has `ratingEligible: false`.
Duels do not change Elo. Human calibration is still required before a separate
ranked season. The referee cannot certify truth, authorship or the absence of AI slop.

## Play

Prepare and preview as a guest: no sign-in or recovery key is required. Choose
your public player name when ready to submit; the browser keeps your session.
Recovery for an existing account remains optional.

1. Copy a preparation prompt with a rolling seven-day window.
2. Ask your own AI to prepare a draft from existing authorized context.
3. Preview it locally and review every excerpt.
4. Choose your player name, approve referee processing and public challenges, then submit.
5. Challenge a friend or someone in the arena. Copy the duel link or download the result card.

The referee compares the same entries in both A/B and B/A order, without account
names, personal scores or Elo. Both orders must agree for a win or draw; missing
evidence or disagreement produces an unrated result. Play on demand with evidence
from the rolling seven-day window. Entries remain available for new duels for
24 hours after their window ends; the pilot allows up to 10 duels per player per UTC day.

Public challenge consent covers player metadata and duel outcomes. Optional
public summary text requires separate approval. Approved evidence is uploaded
privately for the referee. Public views show approved summaries, current player
stats, verdicts and generic reasons; they exclude private evidence and private
referee explanations. Preparation, result
and account modals share one page; `/challenge/<entryId>` and `/duel/<duelId>`
open the corresponding state.

## Scores on the results screen

| Display | Meaning |
| --- | --- |
| Form **/100** | The player's personal AI assessment, displayed on the AntiSlop main panel, duel results and duel share cards. A saved score of 842 becomes **84.2/100**. |
| Elo **1200** | A separate competitive rating with a starting value of 1200 and no denominator. The shared-referee pilot does not change it. |
| Win, loss, draw or unrated | The shared referee's comparison of the two submitted entries. Personal Form and Elo are hidden from the referee. |

Form and Elo on duel results are **current public player stats**, so they can
change after a duel. The recorded verdict remains fixed. Players without a Form
score see “Not scored yet” on the duel card.

## Personal Form

[Personal scoring guide](https://antislop.org/rate.md)

**Computer Form** assesses one completed UTC week. Its scoring guide, legacy
dialogs and stored receipts retain the original **/1000** scale; AntiSlop divides
that score by 10 for its **/100** display. Coverage and certainty are separate.
Legacy eligible matches can change Elo; low-confidence matches are exhibitions.
Scores are self-attested. Fingerprints check content integrity, not the truth of private evidence.

The prompt requests a direct estimate from existing authorized context, without follow-up questions. Meaningful partial context about the completed UTC week can support a rough score with conservative confidence. With no usable weekly context, it returns no score instead of inventing one.

Private history stays with the user's assistant. After an explicit preview/publish step, the site accepts the week, aggregate score, coverage and certainty, plus optional fixed labels for the AI product and context source. The labels reveal categories, not the underlying chat, memory, profile or activity. The optional public MCP exposes the guide and prompt, with no account or history access.

Personal Form remains available through **Open my Form**, the **Computer Form**
footer link and `/form`. The shared
referee never uses these personal scores or existing Elo ratings. The legacy
scoring rules and receipts retain their original meaning.

## Develop

Use Node 24 and install both locked dependency trees:

```sh
nvm use
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix apps/public
```

Copy `.env.example` to an ignored local environment file and set a random private service key. The API's `SERVICE_KEY` and frontend's `ELO_SERVICE_KEY` must match. Supply those variables to each process; see [deployment and configuration](docs/public-deployment.md).

```sh
npm run api:start
npm run public:dev
```

Run those in separate terminals with the environment loaded. Open `http://localhost:3000`. The historical `npm run dev` command starts the separate private LAN demo.

Live judging uses request-scoped Vercel OIDC on the server; local tests use fake
Gateway responses. Do not add a browser-visible provider key. See
[AntiSlop configuration and limits](docs/antislop-operations.md).

## Check

```sh
npm run typecheck
npm run public:typecheck
npm test
npm run public:build
node --import tsx scripts/check-production-flows.ts
```

The frontend build regenerates the downloadable scoring kit from reviewed source. It requires `zip`; the isolated production integration uses `openssl`. Optional offline PNG card commands also need `rsvg-convert` from librsvg. See [test coverage and limits](docs/testing.md).

## Layout

| Path | Purpose |
| --- | --- |
| `apps/public/` | One-page Next.js frontend, modals, public MCP and session proxy |
| `apps/api/` | Node.js API with shared accounts, the legacy ledger and additive AntiSlop SQLite tables |
| `packages/elo-engine/` | Deterministic rating engine, receipt validation and CLI |
| `packages/referee/` | Entry/draft contracts, live Gateway adapter and offline calibration CLI |
| `packages/public-api/` | Shared contracts, evidence rules and UTC week calculations |
| `protocol/`, `fixtures/` | Versioned contracts and synthetic replay fixtures |
| `skills/computer-elo/` | Optional local scoring workflow |
| `apps/web/` | Separate private LAN demo |

## Contribute safely

Install [Gitleaks](https://github.com/gitleaks/gitleaks), then enable the repository's commit/push checks:

```sh
git config --local core.hooksPath .githooks
npm run repo:check
npm run security:secrets
```

Environment files, hosting links, databases, collected activity, local audit reports and generated builds are excluded from Git. CI repeats boundary and secret checks with read-only permissions. Never put recovery keys or private evidence in issues, commits, receipts or screenshots.

Use an SSH remote for Git operations. The owner must configure remote branch protection and private vulnerability reporting after creating the GitHub repository; those settings cannot be established by this source tree alone.

No project-wide open-source license has been selected. Bundled fonts retain their included SIL Open Font License notices; dependency licenses remain their respective owners'.
