# Computer Elo

A weekly computer-use game: choose a username, ask your own AI to rate your week, paste the approved result, and share your card.

[Live league](https://computer-elo.vercel.app) · [Scoring guide](https://computer-elo.vercel.app/rate.md) · [Security](SECURITY.md)

**Computer Form** is a 1–1000 assessment of one week. **Elo** starts at 1200 and changes through eligible matches. Coverage and certainty are separate; low-confidence matches are exhibitions. Scores are self-attested. Fingerprints check content integrity, not the truth of private evidence.

The prompt requests a direct estimate from existing authorized context, without follow-up questions. Meaningful partial context about the completed UTC week can support a rough score with conservative confidence. With no usable weekly context, it returns no score instead of inventing one.

Private history stays with the user's assistant. After an explicit preview/publish step, the site accepts the week, aggregate score, coverage and certainty, plus optional fixed labels for the AI product and context source. The labels reveal categories, not the underlying chat, memory, profile or activity. The optional public MCP exposes the guide and prompt, with no account or history access.

## AntiSlop direction

The next product iteration is on-demand, evidence-based PvP with a shared referee.
The first implementation is an offline entry and calibration toolkit under
`packages/referee`; the existing live scoring flow is unchanged by this toolkit.
See [the product direction](docs/antislop-direction.md) and
[the calibration workflow](docs/referee-calibration.md).

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
| `apps/api/` | Node.js API with a persistent SQLite rating ledger |
| `packages/elo-engine/` | Deterministic rating engine, receipt validation and CLI |
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
