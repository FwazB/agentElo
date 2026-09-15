# Formula Registry

## Shared numeric profile

`decimal80-rne.v1` is authoritative:

- base-10 arbitrary-precision arithmetic with 80 significant digits;
- round to nearest, ties to even after every operation;
- correctly rounded `exp` at that precision;
- fixed `ln(10)` constant:
  `2.3025850929940456840179914546843642076011014886287729760333279009675726096773525`;
- no intermediate quantization;
- probabilities serialize with exactly 15 fractional digits;
- point deltas serialize with exactly 12 fractional digits;
- the applied change is `roundTiesToEven(raw_delta * 1000)` integer millipoints;
- calculate A once and set B to its exact negation;
- ratings are not clamped.

Persisted integer millipoints are authoritative. Native binary floating point is non-authoritative.

## Confidence

`computer-confidence.coverage-certainty-min.v1`:

```text
effective_confidence_ppm = min(coverage_ppm, certainty_ppm)
match_confidence = min(effective_A_ppm, effective_B_ppm) / 1_000_000
```

Bands are `low` below `500000`, `medium` from `500000` through `799999`, and `high` from `800000` through `1000000`. The low-confidence threshold is exclusive: exactly `500000` is eligible for a rated match.

## Expected score

For millipoint ratings `R_A` and `R_B`:

```text
E_A = 1 / (1 + 10 ** ((R_B - R_A) / 400000))
```

The stable implementation evaluates `logistic((R_A - R_B) * ln(10) / 400000)`.

## Binary v1

Version: `computer-elo.binary.v1`

```text
form_A > form_B  -> S_A = 1
form_A = form_B  -> S_A = 0.5
form_A < form_B  -> S_A = 0
```

The engine derives this outcome from the two Form scores; callers cannot inject a result.

## Scalar v1

Version: `computer-elo.scalar-tanh200.v1`

```text
S_A = 0.5 + 0.5 * tanh((form_A - form_B) / 200)
```

The stable implementation evaluates the mathematically equivalent `logistic((form_A - form_B) / 100)`.

## Common update

```text
K = 64 if matches_A < 5 or matches_B < 5 else 32
raw_delta_A = K * match_confidence * (S_A - E_A)
delta_milli_A = roundTiesToEven(raw_delta_A * 1000)
delta_milli_B = -delta_milli_A
```

Rated matches increment both rated-match counters exactly once, including draws and zero-rounded deltas. Exhibitions apply zero and do not increment counters.

Any change to a formula, threshold, K rule, operation order, precision, or rounding rule requires a new version.
