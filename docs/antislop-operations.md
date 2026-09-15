# AntiSlop pilot operations

AntiSlop supports approved evidence ingestion, on-demand duels and a live shared
referee. Every public result and adjudication has `ratingEligible: false`.
**The pilot writes no Elo updates.** Personal Form and the legacy rating ledger
keep their existing rules.

Duel screens and share images also show **current public profile stats**, read
from each player's latest validated receipt rather than frozen at duel time.
Form is displayed out of 100 by dividing the saved score by 10; its native
0–1000 storage and scoring remain unchanged. Elo shows the current scalar-league
rating (1200 for an account with no rated matches). Missing Form is shown as
“Not scored yet.” These profile stats are separate from the immutable referee
verdict, and pilot duels still make no Elo changes.

## Deployment and launch budget

Use the existing `computer-elo` Vercel project for the Next.js frontend and the
existing Railway API with its persistent SQLite volume. `antislop.org` is the
canonical domain attached to that project; DNS cutover and live-domain checks
are a later release step, not evidence supplied by a successful build.

| Process | Server configuration |
| --- | --- |
| Railway API | `NODE_ENV=production`, `DATABASE_PATH=/data/elo.sqlite`, private `SERVICE_KEY`, configured `PORT` |
| Vercel Next.js | `ELO_API_URL` over HTTPS, matching private `ELO_SERVICE_KEY`, request-scoped Vercel OIDC via `@vercel/oidc` |

The OIDC token authenticates server-side Vercel AI Gateway calls and never goes
to the browser. Missing configuration makes judging unavailable. Local tests
inject fake fetch responses and need no provider credentials. See
[base deployment setup](public-deployment.md).

**Initial launch policy:** configure a **$5 non-refreshing project Gateway cap**
on `computer-elo`, using only existing free credits. Do not buy credits, enable
automatic refresh or raise the cap as a release workaround. Confirm the setting
in the hosting account before live judging; request quotas do not themselves
enforce a dollar budget. Exhausted capacity must fail safely.

## Fixed referee and failure handling

`packages/referee/live-config.ts` and `gateway.ts` fix these settings:

| Setting | Pilot value |
| --- | --- |
| Season | `antislop-pilot-2026-09-v2` |
| Gateway endpoint | `https://ai-gateway.vercel.sh/v1/chat/completions` |
| Model ID | `alibaba/qwen3-next-80b-a3b-instruct` |
| Provider route | Alibaba only; no configured fallback |
| Provider privacy | Per-request `zeroDataRetention: true`, which also disallows prompt training; requires Vercel Pro or Enterprise |
| Output | Strict verdict JSON schema, non-streaming, at most 1,800 output tokens |
| Sampling | Temperature `0` |
| Calls | A/B and B/A concurrently, with the same configuration |
| Time limits | 45 seconds per provider call; 8 seconds per API operation; 90-second Next.js function maximum |

A fixed model ID does not guarantee immutable provider weights. Neither that ID
nor zero temperature establishes deterministic results or human agreement.
The judge fingerprint covers configuration, prompt bytes and aggregation
version. Startup refuses to reuse an existing season with a changed fingerprint
or configuration; make an explicit season decision when changing these inputs.

A new duel is `pending` for at most two minutes. A participant's authenticated
request obtains one durable claim and a 90-second lease before provider calls.
The browser cannot supply model packets or verdicts. The API validates pair,
judge and order bindings, outcome/reason consistency and cited evidence before
atomically storing both private judgments and the structured public result.

Order disagreement is unrated. Refusal, malformed/oversized JSON, mismatched
model output, timeout or invalid citations close the attempt as failed/unrated.
Duplicate claims are rejected; identical completed settlements are idempotent.
There is no automatic retry or reroll. If settlement acknowledgement is lost,
refresh the recorded duel: do not infer an unchanged state or start another
provider run. Lease expiration makes an abandoned attempt terminal.

## Guest preparation and account naming

Preparation and local preview require no sign-in, username or recovery key.
`POST /api/guest/session` with `{}` establishes an opaque HttpOnly session cookie
and a short-lived signed pending marker bound to it; it does not allocate an
account. Both cookies use Secure and SameSite=Strict in production. The response
acknowledges readiness without returning a token or recovery key.

When the user is ready to submit, `POST /api/guest/player` with `{username}` uses
that browser session and its pending marker, or validates an existing account.
It creates/binds the named player through the account backend and returns the
account view only. The same cookie and name retry the same identity; a different
name conflicts. Credentials never enter the response body. Guest continuity
depends on the browser cookies; existing-account recovery remains an optional
path, not an entry-preparation gate.

## Entry, consent and privacy

The server prompt issues an exact rolling seven-day window ending at the current
server time. Drafts have no identity or consent fields and require
`publicSummary: null`. Pasting and previewing occur locally; the API receives the
draft only after explicit referee approval. An insufficient-context response
cannot be submitted as evidence.

On submission, the API authenticates the account, supplies entry/participant IDs
and approval time, and requires `window.endsAt` to be no later than now and no
more than 24 hours old. New duels also require both entry creation times to be
within 24 hours. Windows and approvals use canonical UTC timestamps. Evidence
may retain a real `YYYY-MM-DD` source date: nominal-day overlap is accepted while
unknown hour/timezone and boundary-day uncertainty remain visible to the judge.

Entries contain 1–5 outcomes and 1–10 evidence items, with linked evidence for
every outcome. Maximum UTF-8 lengths are 4,000 bytes for the recap, 2,000 per
outcome, 6,000 per excerpt and 2,000 for optional public text; the normalized
entry is at most 64 KiB. JSON parsing rejects duplicate keys and unexpected fields.

- **Referee approval:** store the immutable private snapshot and allow the shared
  referee to process its selected evidence. Metadata is removed and local IDs
  remapped before judging; free text still needs user review for identifiers.
- **Challenge opt-in:** allow public challenges and publication of player
  identifiers/name, entry dates and structured duel outcomes. Both entries must
  opt in before a new duel. Pausing removes arena listing and blocks new pairs;
  previously approved public records remain available.
- **Public summary approval:** publish only the exact optional text written and
  approved separately in the UI. Publication never derives it from private
  evidence or a referee explanation.

Only the authenticated owner receives their private entry through submission or
`me`. Opponent/public responses and share images contain public projections;
they do not expose raw evidence or referee explanations. Private explanations
remain private in server storage until their retention deadline or owner erasure. Never log OIDC/service/session/lease tokens, private
evidence, draft bodies or referee responses, or include them in public issues,
deployment receipts or screenshots.

New recaps expire seven days after submission and new referee notes seven days
after completion, or earlier when a referenced recap is erased or expires. The API removes expired payloads on access and in an hourly
sweep while running. Pre-policy records retain their existing data until the
owner requests erasure. **Delete private recaps** removes all of a player's
private snapshots and related referee notes, including entries outside the
recent-history view; it opts the entries out of challenges and refuses while a
duel is active. Approved public summaries, results and history remain. This does
not erase historical exports or hosting backups; configure backup expiry
separately. See [privacy boundaries](../SECURITY.md#private-antislop-data).

## API surfaces

Browser mutations require a same-origin request. Guest bootstrap issues cookies;
protected writes require the `elo_session` cookie and an authenticated player.
A caller's Authorization header cannot override the cookie. The general proxy adds private
service authentication; the backend checks account identity again after reading
write bodies. Backend `/v1/antislop/*` routes reject query parameters.

Private entry uploads also require `X-Expected-Player-Id`, naming the player who
approved the draft. The browser proxy checks that player against the captured
session before forwarding the evidence, and the API compares the same header
with the authenticated owner immediately before storage. A player change returns
`409` without saving the entry; the reviewed draft remains available in the page.

| Browser route | Purpose |
| --- | --- |
| `POST /api/guest/session` | `{}`; establish guest cookies without creating a player or returning credentials |
| `POST /api/guest/player` | `{username}`; bind the browser session to a named account; return account view only |
| `GET /api/antislop/prompt` | Generate the current window and preparation prompt |
| `GET /api/antislop/arena` | Public entries/results and pilot limits |
| `GET /api/antislop/me` | Owner's snapshots, duels and quota |
| `GET /api/antislop/entries/<id>` | Previously opted-in public entry projection |
| `GET /api/antislop/duels/<id>` | Structured result and participant-specific `canJudge` |
| `POST /api/antislop/entries` | `{requestId, draft, refereeApproved:true, publicSummary:{text,approved:true}\|null, optedIn}` |
| `POST /api/antislop/entries/<id>/participation` | `{optedIn}` for the owner's entry |
| `POST /api/antislop/privacy/erase` | `{}` and `X-Expected-Player-Id`; erase all owned private recaps and related notes |
| `POST /api/antislop/duels` | `{requestId, entryId, opponentEntryId}` |
| `POST /api/antislop/duels/<id>/judge` | Request judging of an admitted duel; client body is discarded |

The generic browser proxy maps allowed routes to `/v1/antislop/*`. The dedicated
Next.js judge handler calls the service-authenticated internal
`/v1/antislop/internal/duels/<id>/{claim,settle,fail}` routes, which are excluded
from the generic proxy allowlist. Internal claim responses contain private
packets and a lease token and must never be exposed to browser callers.

## Storage, replay and capacity

The account store initializes the existing SQLite database first. AntiSlop adds
six tables for seasons, entries, participation, duels, judge runs and request
idempotency. It uses foreign keys, WAL, full synchronization and immediate
transactions. Preserve the volume and run one API replica; keep consistent
SQLite backups. Redeployment or frontend rollback is not a reason to delete
the database or its new tables.

The same request ID with the same normalized request returns its recorded
resource; different content with that ID receives `409`. A per-player work hash
ignores submitted IDs, item order, refreshed windows and public metadata, and
normalizes Unicode/whitespace. Reusing that work cannot create a new immutable
entry. An unordered participant/content pair has one duel per season.

This is syntactic replay protection, not proof of substantively new work: text
rewrites or changed claimed dates can evade it. Accounts do not establish unique
humans, and submitted evidence is not independently verified.

| Capacity control | Limit |
| --- | --- |
| Duels involving one participant | 10 per UTC day |
| Total admitted duels | 100 per UTC day |
| Pending/judging duels involving one participant | 1 |
| New entries per account | 10 per UTC day |
| New idempotency request records per account | 60 per UTC day |

Failed and expired admitted duels still consume the initiator's and global daily
capacity. An incoming challenge that expires without ever claiming the referee
does not consume the opponent's daily allowance. Pending challenges reserve both
participants' capacity; once judging is claimed, both remain charged even if it
fails. Private payload retention and owner erasure are described above.

## Release checks

1. Run root/public type checks, `npm test`, `npm run public:build` and the isolated
   production-flow checks. Use local synthetic accounts/data and fake provider
   calls for write-path tests: timeout, duplicate claims, malformed output,
   failed settlement and restart persistence.
2. Confirm the Vercel project, Railway service/volume, server-only credentials
   and non-refreshing $5 Gateway cap. Preserve Form history and the SQLite
   volume; retain sanitized deployment receipts.
3. After deployment, use read-only production checks for health, arena, prompt,
   HTML, challenge/result routes and share metadata. Do not seed synthetic
   players, evidence or duels into production to demonstrate success.
4. Cut DNS to the already bound `antislop.org` project as its own release step,
   then verify HTTPS, canonical/share URLs and real browser flows. A page load
   alone is not proof of persistence or a completed provider call.

Keep the pilot unrated. Actual human labels, held-out evaluation and a separate
reviewed ranked season are required before any future referee-based Elo update;
see [calibration](referee-calibration.md).
