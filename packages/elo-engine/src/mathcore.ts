import { Decimal as SharedDecimal } from "decimal.js";

import {
  ESTABLISHED_K,
  type EloMode,
  MAX_CONFIDENCE_PPM,
  MAX_FORM_SCORE,
  MIN_CONFIDENCE_PPM,
  MIN_FORM_SCORE,
  NUMERIC_PROFILE,
  PROVISIONAL_K,
  PROVISIONAL_MATCH_LIMIT,
} from "./constants.ts";

// Keep the versioned numeric profile independent of another consumer's settings.
const Decimal = SharedDecimal.clone({ precision: 80, rounding: SharedDecimal.ROUND_HALF_EVEN });
type Decimal = SharedDecimal;

export const LN10 = new Decimal(
  "2.3025850929940456840179914546843642076011014886287729760333279009675726096773525",
);

export class MathInputError extends Error {
  override readonly name = "MathInputError";
}

export interface EloCalculation {
  readonly mode: EloMode;
  readonly numeric_profile: string;
  readonly k: number;
  readonly confidence_ppm: number;
  readonly actual_score_a: string;
  readonly expected_score_a: string;
  readonly raw_delta_a: string;
  readonly candidate_delta_milli_a: number;
  readonly candidate_delta_milli_b: number;
  readonly candidate_rating_after_milli_a: number;
  readonly candidate_rating_after_milli_b: number;
}

export interface EloInput {
  readonly mode: EloMode;
  readonly rating_milli_a: number;
  readonly rating_milli_b: number;
  readonly form_a: number;
  readonly form_b: number;
  readonly confidence_ppm_a: number;
  readonly confidence_ppm_b: number;
  readonly rated_matches_a: number;
  readonly rated_matches_b: number;
}

function requireInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new MathInputError(`${name} must be a safe integer`);
  }
}

function validateInput(input: EloInput): void {
  if (input.mode !== "binary" && input.mode !== "scalar") {
    throw new MathInputError("mode must be binary or scalar");
  }
  const numericFields: ReadonlyArray<readonly [string, number]> = [
    ["rating_milli_a", input.rating_milli_a],
    ["rating_milli_b", input.rating_milli_b],
    ["form_a", input.form_a],
    ["form_b", input.form_b],
    ["confidence_ppm_a", input.confidence_ppm_a],
    ["confidence_ppm_b", input.confidence_ppm_b],
    ["rated_matches_a", input.rated_matches_a],
    ["rated_matches_b", input.rated_matches_b],
  ];
  for (const [name, value] of numericFields) requireInteger(value, name);
  if (input.form_a < MIN_FORM_SCORE || input.form_a > MAX_FORM_SCORE) {
    throw new MathInputError("form_a must be between 1 and 1000");
  }
  if (input.form_b < MIN_FORM_SCORE || input.form_b > MAX_FORM_SCORE) {
    throw new MathInputError("form_b must be between 1 and 1000");
  }
  if (
    input.confidence_ppm_a < MIN_CONFIDENCE_PPM ||
    input.confidence_ppm_a > MAX_CONFIDENCE_PPM
  ) {
    throw new MathInputError("confidence_ppm_a must be between 0 and 1000000");
  }
  if (
    input.confidence_ppm_b < MIN_CONFIDENCE_PPM ||
    input.confidence_ppm_b > MAX_CONFIDENCE_PPM
  ) {
    throw new MathInputError("confidence_ppm_b must be between 0 and 1000000");
  }
  if (input.rated_matches_a < 0 || input.rated_matches_b < 0) {
    throw new MathInputError("rated match counts cannot be negative");
  }
}

function logistic(value: Decimal): Decimal {
  if (value.greaterThanOrEqualTo(0)) {
    const q = value.negated().exp();
    return new Decimal(1).div(new Decimal(1).plus(q));
  }
  const q = value.exp();
  return q.div(new Decimal(1).plus(q));
}

function binaryScore(formA: number, formB: number): Decimal {
  if (formA > formB) return new Decimal(1);
  if (formA < formB) return new Decimal(0);
  return new Decimal("0.5");
}

function scalarScore(formA: number, formB: number): Decimal {
  return logistic(new Decimal(formA - formB).div(100));
}

function formatDecimal(value: Decimal, decimalPlaces: number): string {
  const normalized = value.toDecimalPlaces(decimalPlaces, Decimal.ROUND_HALF_EVEN);
  return (normalized.isZero() ? normalized.abs() : normalized).toFixed(decimalPlaces);
}

export function roundMillipoints(rawDelta: SharedDecimal.Value): number {
  let value: Decimal;
  try {
    value = new Decimal(rawDelta);
  } catch {
    throw new MathInputError("raw_delta must be a finite decimal value");
  }
  if (!value.isFinite()) {
    throw new MathInputError("raw_delta must be finite");
  }
  const rounded = value.mul(1000).toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN).toNumber();
  if (!Number.isSafeInteger(rounded)) throw new MathInputError("rounded millipoints are outside the safe integer range");
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function calculateElo(input: EloInput): EloCalculation {
  validateInput(input);
  const actual =
    input.mode === "binary"
      ? binaryScore(input.form_a, input.form_b)
      : scalarScore(input.form_a, input.form_b);
  const expectedLogit = new Decimal(input.rating_milli_a).minus(input.rating_milli_b)
    .mul(LN10)
    .div(400_000);
  const expected = logistic(expectedLogit);
  const confidencePpm = Math.min(input.confidence_ppm_a, input.confidence_ppm_b);
  const confidence = new Decimal(confidencePpm).div(1_000_000);
  const k =
    input.rated_matches_a < PROVISIONAL_MATCH_LIMIT ||
    input.rated_matches_b < PROVISIONAL_MATCH_LIMIT
      ? PROVISIONAL_K
      : ESTABLISHED_K;
  const rawDelta = new Decimal(k).mul(confidence).mul(actual.minus(expected));
  const deltaMilliA = roundMillipoints(rawDelta);
  const deltaMilliB = deltaMilliA === 0 ? 0 : -deltaMilliA;
  const ratingAfterA = input.rating_milli_a + deltaMilliA;
  const ratingAfterB = input.rating_milli_b - deltaMilliA;
  requireInteger(ratingAfterA, "candidate_rating_after_milli_a");
  requireInteger(ratingAfterB, "candidate_rating_after_milli_b");
  return {
    mode: input.mode,
    numeric_profile: NUMERIC_PROFILE,
    k,
    confidence_ppm: confidencePpm,
    actual_score_a: formatDecimal(actual, 15),
    expected_score_a: formatDecimal(expected, 15),
    raw_delta_a: formatDecimal(rawDelta, 12),
    candidate_delta_milli_a: deltaMilliA,
    candidate_delta_milli_b: deltaMilliB,
    candidate_rating_after_milli_a: ratingAfterA,
    candidate_rating_after_milli_b: ratingAfterB,
  };
}
