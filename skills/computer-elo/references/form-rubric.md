# Computer Form Rubric v1

Score only the finalized ISO week under review. In v1, that window is Monday
00:00:00 UTC inclusive through the following Monday 00:00:00 UTC exclusive.
Convert locally summarized evidence to those UTC boundaries. Use integers from
1 to 1000 for each dimension.

Give a direct estimate from meaningful partial context tied to the requested
week, without follow-up questions. Use already-shared or authorized chat,
profile, memory, attachments, and history; no new source permissions are implied.
Five separate artifacts or independent observations are not required. Estimate
all five dimensions from the available signals without changing their weights.
Missing detail is unknown, not automatically a low or default score. A documented
lack of checks or unfinished work is evidence. Distinguish inferred judgments
from observed events and self-attested recollections from independently verified
activity. Never invent facts to explain an estimate.

Broader personal context can inform interpretation, but do not relabel earlier
activity as target-week evidence. If there is no usable context for that week,
return the no-score result immediately without questions. A public MCP supplies
rules and never grants access to private history.

| Dimension | Weight | Evidence to evaluate |
| --- | ---: | --- |
| Output and closure | 30% | Completed useful outcomes with visible receipts rather than intent or motion. |
| Focus and attention control | 25% | Sustained progress, purposeful switching, and recovery from interruptions. |
| Workflow leverage | 20% | Effective automation, delegation, shortcuts, tools, templates, and reuse in any domain. |
| Verification discipline | 15% | Tests, checks, source-of-truth comparison, and explicit confirmation. |
| Operational hygiene | 10% | Clear ownership, privacy care, cleanup, reproducibility, and recovery paths. |

Calculate:

```text
Form = round_half_up(
  output * 0.30 +
  focus * 0.25 +
  leverage * 0.20 +
  verification * 0.15 +
  hygiene * 0.10
)
```

For positive integer components, the exact implementation is `(30*output + 25*focus + 20*leverage + 15*verification + 10*hygiene + 50) // 100`.

## Anchors

- 950–1000: exceptional control in the observed week
- 850–949: consistently strong
- 750–849: strong with identifiable limitations
- 650–749: effective but uneven
- 500–649: mixed results and meaningful friction
- 300–499: limited control or follow-through
- 1–299: minimal effective behavior visible

These are game anchors, not population percentiles or validated psychometrics.

## Confidence

Confidence is not Form and is not Elo.

- `coverage_ppm`: conservative visibility into the requested week, without counting earlier activity or tool availability as coverage.
- `certainty_ppm`: how certain the assessment is after ambiguity, capture gaps, missing devices, and context limitations.
- `effective_ppm = min(coverage_ppm, certainty_ppm)`.

Zero coverage or zero certainty means insufficient evidence and no score. Do
not invent a denominator or inflate confidence. Meaningful partial context can
support a provisional Form estimate. Keep confidence below 50% when large gaps
or substantial inference support it; such matches are exhibitions. The 50%
threshold controls rated-match eligibility, not whether a rough Form may exist.

Below `500000` is low confidence and cannot produce a rated match. Do not penalize accessibility needs, caregiving, health constraints, required collaboration, or limited work opportunity. Material role, schedule, device, or capture differences should reduce certainty or produce an exhibition.

## Bias controls

- Score all dimensions before looking at a prior Form score.
- Prefer several ordinary observations over one impressive highlight.
- Do not infer effectiveness from app names, job title, prestige, message volume, or apparent busyness.
- Leisure is not inherently negative; deduct only for evidenced harmful fragmentation.
- Commands, requests, and promises are not completion receipts.
- A different evaluator may score the same evidence differently; disclose uncertainty.
