# Referee calibration and offline replay

The referee CLI prepares packets and evaluates supplied judgments without
network calls or writes to production data. The package also contains the live
`gateway.ts` adapter used by authenticated, approved AntiSlop duels. Every
adjudication has `ratingEligible: false`; every evaluation is `pilot_only`.
The live adapter does not establish human calibration. See
[live operations](antislop-operations.md) for its configuration and limits.

Use Node 24. Run `npm ci --ignore-scripts`, then `npm run test:referee` and
`npm run typecheck` from the repository root.

## Entry snapshots and privacy

`parseWorkEntry` validates a JSON object with these exact fields:

| Field | Meaning |
| --- | --- |
| `version` | `antislop.entry.v1` |
| `entryId`, `participantId` | Opaque identifiers, 1–80 ASCII identifier characters |
| `window` | `startsAt` and `endsAt`, exactly seven elapsed days apart |
| `summary` | Private recap, at most 4,000 UTF-8 bytes |
| `accomplishments` | 1–5 items with an ID, outcome and existing evidence IDs |
| `evidence` | 1–10 items with an ID, kind, excerpt and occurrence date or timestamp |
| `refereeConsent` | Explicit `approved: true` and `approvedAt` timestamp |
| `publicSummary` | `null`, or separately approved `text` and `approvedAt` |

Evidence kinds are `artifact`, `check` and `attestation`. These describe what was
submitted, not verified provenance. Excerpts are bounded to 6,000 UTF-8 bytes and
each accomplishment's outcome to 2,000. The total normalized entry is at most
64 KiB. Windows and approvals use canonical UTC millisecond strings, such as
`2026-09-15T00:00:00.000Z`. Exact evidence timestamps fall in `[startsAt, endsAt)`.
Evidence can instead retain a real `YYYY-MM-DD` source date: its nominal UTC day
must overlap the window, but its actual hour and timezone remain unknown. The
judge preserves that uncertainty, including on boundary days. Never manufacture
a timestamp from a date. Approval occurs at or after the window end. Entries can
end at any time of day; the offline parser imposes no live-clock freshness policy.

Snapshots are detached from caller input. Their SHA-256 fingerprints bind the
content, metadata and approvals; they are not signatures or proof of consent.
The implemented ingestion service authenticates the account, requires explicit
referee approval, supplies identity and approval timestamps, checks that the
window ended within the last 24 hours, and stores the immutable snapshot.
`antislop.entry-draft.v1` carries no account identity or consent and requires
`publicSummary: null`; insufficient-context responses cannot be submitted as work.

`blindEntry` removes account/entry identifiers, consent and public text. It
renames local accomplishment and evidence identifiers to `a1`/`e1` and so on.
Free text can still identify a person: the preparation prompt requests redaction
and the browser shows the material before upload. The referee never retrieves
URLs or external files automatically.

`publicEntrySummary` returns only the separately approved public text and entry
ID, or `null`. It never derives public text from the recap, evidence, or referee
explanations. The live API additionally publishes player/entry metadata and
structured duel results under separate challenge opt-in. Raw explanations and
opponent evidence remain private; public renderers escape text.

## Synthetic smoke example

Everything under `fixtures/referee` is invented. The outcome and simulated rater
labels test program behavior; no human panel or live model produced them.

```sh
npm run referee -- config --config fixtures/referee/judge.synthetic.json
npm run referee -- evaluate --input fixtures/referee/evaluation.synthetic.json
```

The evaluation example deliberately contains order disagreement. Its metrics
must not be advertised as human agreement, accuracy, or readiness for ranked play.
The synthetic judge uses `provider: offline` and `modelSnapshot:
synthetic-fixture-v1`; it is not an inference provider.

## Prepare a private pair

Use the same two frozen entries and config for both orders. These commands print
private evidence, so redirect their output into the ignored local `runs/` folder:

```sh
umask 077
mkdir -p runs/referee
npm run --silent referee -- packet \
  --entry-a fixtures/referee/entry-a.synthetic.json \
  --entry-b fixtures/referee/entry-b.synthetic.json \
  --config fixtures/referee/judge.synthetic.json --order ab > runs/referee/ab.packet.json
npm run --silent referee -- packet \
  --entry-a fixtures/referee/entry-a.synthetic.json \
  --entry-b fixtures/referee/entry-b.synthetic.json \
  --config fixtures/referee/judge.synthetic.json --order ba > runs/referee/ba.packet.json
```

Each packet includes request messages, an order, a judge fingerprint, and a pair
fingerprint. The judge fingerprint covers the config, exact system-prompt bytes,
and aggregation-policy version. Bump that version when changing the two-order
resolution rule. Any of those changes creates a different identity. The config
restricts this version to calibration, zero temperature and bounded output
tokens. The live adapter fixes its model ID, Alibaba provider route and strict
JSON schema. Neither a fixed model ID nor rejection of obvious `latest` aliases
guarantees immutable provider weights. Zero temperature does not guarantee
identical outputs.

A trusted runner must preserve packet metadata and wrap the model's JSON verdict:

```json
{
  "version": "antislop.judge-response.v1",
  "judgeFingerprint": "copy the originating packet's digest",
  "pairFingerprint": "copy the originating packet's digest",
  "order": "ab",
  "verdict": {
    "outcome": "a_wins",
    "reason": "stronger_work",
    "explanation": "Private explanation tied to the submitted evidence.",
    "evidenceRefs": { "a": ["e1"], "b": ["e1"] }
  }
}
```

Use `npm run referee -- adjudicate` with `--entry-a`, `--entry-b`, `--config`,
`--response-ab` and `--response-ba`. Responses for another pair, config or order
are rejected. A win/draw must cite valid evidence IDs from both displayed entries.
The reverse order's winner is mapped back to the original participants before
aggregation. Inconsistent outcomes become unrated; a supported draw remains 0.5.
The result and its explanations are private offline artifacts. Metadata bindings
detect accidental replay; they do not authenticate a provider or prevent a
trusted operator from fabricating a response.

CLI JSON parsing rejects duplicate keys, including escaped duplicates, and limits
nesting and file sizes. Validation errors do not echo evidence or consent text.

## Human calibration pilot

1. Select approximately 50 representative pairs as a pilot: strong, weak, mixed,
   concise, verbose, insufficient and incomparable entries. Include attacks that
   put instructions in evidence, unsupported claims and documented failed work.
   Use only evidence explicitly approved for the referee **and** human reviewers.
2. Allocate entire participants and their entries to either calibration or
   holdout before forming pairs. Keep the holdout private during prompt tuning.
   Reusing an entry across calibration and holdout is leakage. Reuse within
   holdout creates correlated examples; account for that when interpreting metrics.
3. Ask at least two independent humans (preferably three) to label each pair
   A wins, B wins, draw or unrated under the same rubric. Preserve disagreements.
   These labels must come from actual reviewers; synthetic labels are only tests.
4. Before opening the holdout results, record the acceptance criteria, allowed
   abstention, disagreement handling, sample-size limitations and who can approve
   the pilot. Fifty pairs support iteration, not a broad accuracy claim. Repeated
   calls on the same pairs do not increase the number of independent examples.
5. Tune only on calibration entries. Freeze a candidate config and run at least
   two independent repeats of both AB and BA for every case. Retain failures and
   abstentions; do not keep only the most favorable response.
6. Evaluate holdout separately. If its results inform another prompt change,
   reserve a fresh held-out set for the next acceptance decision.

The input shape is demonstrated by `evaluation.synthetic.json`. A real input uses
`datasetProvenance: human_labeled`, one frozen `judgeFingerprint`, a `cases` array
with participant/entry IDs and independent labels, and a `runs` array with
case ID, repeat index, order, displayed outcome and that same judge fingerprint.
Repeat indices start at zero and must be complete, with both orders for every
case/repeat. Every case must have the same repeat count. There is no automatic
generation of human labels.

The evaluator rejects self-matches, duplicate cases/runs/raters, missing orders,
mixed judge fingerprints, conflicting entry ownership and leakage across splits.
Run metadata is declared by the operator: this module does not independently
verify that labels came from humans or bind them to provider request logs. Keep
the approved entries, response envelopes and manifest mapping in the private
evaluation archive. The live API binds both responses to the claimed pair and
configuration, but this does not verify the origin of human labels or prove that
the provider's underlying weights remained unchanged.

Reports separate calibration from holdout and include:

- Human pairwise agreement and strict-majority coverage; disputed cases do not
  become artificial draws.
- Judge agreement against all labels and against human consensus, with abstention
  left in the denominator.
- Repeatability, order consistency, abstention, judgment coverage and explicit
  numerator/denominator counts. Missing denominators are `null`.

Metrics are micro-averaged over the documented comparisons, not confidence
intervals or independent-match accuracy estimates. High repeatability can simply
mean the judge always abstains; inspect coverage alongside agreement.

The motivating study documents order and verbosity bias and tests judgments in
both orders. It evaluates chatbot answers, not people's work weeks, so this
product needs its own human calibration: [Judging LLM-as-a-Judge with MT-Bench and
Chatbot Arena](https://arxiv.org/html/2306.05685v4).

## Before ranked release

The pilot already includes approved ingestion, durable claims, response binding,
content/pair replay controls and the evidence-review/sharing flow. It still must
not change ratings. Before a separate ranked season, obtain real human labels
and held-out calibration evidence, define retention/deletion and stronger abuse
controls, and review a server-authoritative ranked ledger. Preserve existing
Form and Elo history. Model, provider, prompt or aggregation changes require
fresh evaluation and an explicit season/version decision.
