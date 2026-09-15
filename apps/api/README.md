# Computer Elo API

This Node 24 service uses the existing deterministic Elo engine and SQLite. It starts empty. The public frontend connects through its Vercel server; browsers do not receive the service key or connect directly to this API.

## Run

From the repository root, set `SERVICE_KEY` to a securely generated random value of at least 32 characters, then run:

```sh
node --import tsx apps/api/server.ts
```

The default port is `8787`; `PORT` overrides it. Local development stores data in `var/elo.sqlite`. In production, set `NODE_ENV=production` and an absolute `DATABASE_PATH` on a mounted persistent volume, for example `/data/elo.sqlite`. The production entrypoint neither creates missing directories nor falls back to an in-memory database. Configure one Railway replica with its persistent volume mounted at `/data`. Persist and back up the SQLite database and its associated WAL files using a SQLite-aware backup procedure.

The API rejects a missing or short service key in every environment. Use the same secret in the Vercel server's configuration. The Vercel server must overwrite `X-Service-Key` and derive `X-Client-Id` as a keyed SHA-256 hash of the platform-provided client address. Never forward a browser-supplied value as either trusted header.

## Railway configuration

`.railway/railway.ts` defines the existing `computer-elo` production project, service `api`, and its `api-volume` mounted at `/data` (5000 MB, `us-west2`). It specifies Dockerfile builds, a `/health` check, one replica and five restart retries. The configuration was applied on 2026-09-14 and a subsequent plan reported no changes. The legacy `railway.json` has been removed.

All four environment variables use `preserve()`: `DATABASE_PATH`, `NODE_ENV`, `PORT`, and `SERVICE_KEY`. Review `railway config plan --file .railway/railway.ts` before applying infrastructure changes. If new variables or resources are introduced, add them to the definition: Railway treats omitted managed resources and variables as deletions. Check the project and environment shown in the plan; the file also guards the existing IDs when context is supplied. [Railway IaC reference](https://docs.railway.com/infrastructure-as-code)

## HTTP contract

`GET /health` is public. Every `/v1/` request requires:

```text
X-Service-Key: <service secret>
X-Client-Id: <64 lowercase hex HMAC supplied by Vercel>
```

Account routes also require `Authorization: Bearer <account token>`. Before signup, the browser generates 32 random bytes with WebCrypto and retains their 64-character lowercase hexadecimal representation as the recovery token. The API requires that token and stores only its SHA-256 hash. Retaining it before submission allows recovery when a signup response is lost. Usernames are public presentation names, never authentication credentials. Do not log request bodies, authorization headers, account tokens, or the service key.

| Route | Result |
| --- | --- |
| `GET /v1/overview?mode=scalar` | At most 100 sorted standings, 50 recent matches, totals and active week |
| `POST /v1/players`, body `{username: "your_name", token}` | `{token, player, matches, usernames, queue, formLocked}`; new account has no receipt |
| `GET /v1/me` | Account's current receipt, last 50 matches, current queues and `formLocked` for the current week |
| `GET /v1/players/:id` | Public player receipt and last 50 matches |
| `GET /v1/users/:username` | Public player view by username |
| `POST /v1/username`, body `{username: "your_name"}` | Authenticated one-time claim for an existing account without a username; returns `Me` |
| `POST /v1/session/rotate`, body `{replacementToken}` | Authenticated recovery-token replacement; returns `{token, ...Me}` using the supplied replacement and immediately revokes the old token |
| `POST /v1/form`, body `{receipt: ...}` | Authenticated aggregate receipt import; returns `Me` |
| `POST /v1/assessment`, body `{weekId, formScore, coveragePpm, certaintyPpm}` | Authenticated simple aggregate import; builds a strict receipt and returns `Me` |
| `POST /v1/queue`, body `{mode: "scalar"}` | Explicit opt-in; `{status: "queued"|"matched", match}` |
| `DELETE /v1/queue?mode=scalar` | Cancel waiting entry; returns `Me` |
| `GET /v1/receipts/:fingerprint` | Accepted source or generated receipt for replay |
| `GET /v1/players/:id/card.svg` | Engine-generated player card |
| `GET /v1/matches/:id/card.svg` | Engine-generated match card |

Both `scalar` and `binary` modes are supported and retain independent ratings. The overview defaults to scalar. Unknown fields, duplicate keys, floating-point JSON tokens, private receipt fields, and JSON bodies over 16 KiB are rejected. A request body must finish within five seconds; slow uploads return 408. Slow and oversized uploads close the connection. Errors contain a generic `error` string and never include submitted field names or receipt content.

Usernames contain 3–20 ASCII letters, digits or underscores and begin with a letter. Surrounding whitespace and one leading `@` are removed, then letters are lowercased. Reserved route/system names and Unicode lookalikes are rejected. Names are unique case-insensitively and immutable; repeating the same claim is idempotent. Existing databases receive an additive nullable `username` column and unique index, preserving every token, receipt and rating. Old accounts can claim a username once. `PublicPlayer` and standings expose `username: string | null`; profile/overview responses also include a `usernames` map limited to the players and match participants shown. Canonical receipts keep opaque IDs and their existing fingerprints.

The simple assessment route accepts an ISO week, a Form score from 1–1000, and two integer confidence axes from 1–1000000. The underlying receipt protocol can represent zero confidence, but the hosted service rejects a new assessment with either axis zero as insufficient evidence (422). It uses exactly the same validation, lineage, queue locks and weekly import budget as receipt upload. It does not establish that the assessment is accurate or independently verified.

Before rotation, the browser generates a replacement using WebCrypto and lets the user retain it before submitting. Token rotation updates the stored hash in one transaction and preserves the account, username, Form, rating and matches. A lost response can be recovered using the already-retained replacement token. Account write handlers authenticate before reading a body and recheck authentication after the complete body arrives, so an old-token upload that finishes after rotation is rejected. Signup with the same normalized username and token is idempotent; a token already belonging to another account cannot be used for signup or rotation.

The trusted client is limited to 120 requests/minute, 30 writes/minute and five account creations/hour. Authenticated accounts are also limited to 120 requests/minute. Limiters have bounded memory and restart with the service; they are basic abuse controls, not proof that one account represents one person. Use additional platform controls if public load requires them.

## Rating and replay rules

- The server owns the competition ID, account ID and both Elo streams. Uploaded Elo, identity and lineage never affect hosted ratings. A new account starts at 1200 in both modes.
- The importer validates the complete strict public player receipt, then copies only its finalized ISO week, Form score and two confidence axes into a new server receipt. Only the last completed UTC Monday-to-Monday ISO week is accepted.
- Entering either queue permanently locks that week's Form, including after cancellation. Repeating the exact latest import or identical current aggregates is idempotent and returns the current server state. Different client IDs or fingerprints cannot grow the archive when the approved aggregates are unchanged.
- A player may publish at most five changed Form imports per completed week, including the first import. The persisted count survives restart; additional changes return HTTP 429. The budget resets for the next completed week. No-op repeats do not consume the budget or create receipts.
- Pairing requires both players to opt into the same week and mode. Confidence below 50% pairs only with another exhibition entrant. Confidence at or above 50% is eligible for rated pairing; the engine controls confidence scaling and provisional K.
- A player can complete only one match per week per mode, including exhibitions. Retrying queue entry returns the existing match. Exhibitions preserve both ratings and rated-match counts.
- New weekly imports carry forward both server Elo streams. Older queue entries cannot produce a later week's match. Unrated players always have `rank: null`.
- The database archives every accepted source receipt, normalized player receipt, match receipt and resulting player receipt. Imports record source-to-result fingerprints. Match sources can be retrieved and passed to `buildMatchReceipt` for exact replay.
- Account creation, import, pairing, cancellation, archives and rating updates run inside `BEGIN IMMEDIATE` transactions. WAL mode, full synchronization and SQLite uniqueness constraints protect persistence and weekly match slots.

Form remains an imported, self-reported aggregate. Fingerprints support integrity and replay; they do not prove identity or accuracy of the underlying private assessment.

Stored receipts are validated again before public reads and reuse: their schema, fingerprint and owning row must agree. Damaged player, match or archive records fail with a generic 500 instead of exposing extra fields or silently replacing ratings. Invalid competition metadata stops startup without creating a replacement league. These checks detect malformed stored data; they do not authenticate an assessment or protect against an operator deliberately rewriting the database and recomputing valid fingerprints.

## Testing and integration

```sh
node --import tsx --test apps/api/tests/*.test.ts
```

Tests exercise disk restart persistence, token hashing/authentication, additive username migration, case-insensitive uniqueness, username injection rejection, strict input privacy, forged rating imports, simplified assessment admission, persisted import budgets, finalized weeks, consent, confidence boundaries, exhibitions, cancellation, replay, independent streams, rollover, transaction rollback, response limits and production configuration. The robustness suite also starts independent local processes against one temporary SQLite file to race signup, imports and both queue modes; injects an actual SQL failure during matching; checks damaged receipt handling; and verifies simultaneous token rotation plus slow and abandoned HTTP uploads. These checks use temporary databases and loopback HTTP only.

`apps/api/server.ts` exports `createStore`, `createApiServer`, `lastCompletedWeek` and `ApiError`. `createStore({databasePath, now?})` accepts an in-memory database only for callers such as tests; the service entrypoint always requires disk storage. `createApiServer({store, serviceKey, now?, bodyTimeoutMs?})` returns an unbound Node HTTP server; the optional body deadline lets tests run without a five-second delay. Closing a factory-created server does not close its caller-owned store; the production entrypoint wires both lifecycles together.
