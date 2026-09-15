export const ENGINE_VERSION = "0.1.0";
export const SCHEMA_VERSION = "1.0.0";
export const PROTOCOL_VERSION = "computer-elo.protocol.v1";
export const FORM_VERSION = "computer-form.general.v1";
export const CONFIDENCE_VERSION = "computer-confidence.coverage-certainty-min.v1";
export const BINARY_FORMULA_VERSION = "computer-elo.binary.v1";
export const SCALAR_FORMULA_VERSION = "computer-elo.scalar-tanh200.v1";
export const NUMERIC_PROFILE = "decimal80-rne.v1";
export const CANONICAL_JSON_PROFILE = "cej-ascii-integer.v1";

export const STARTING_RATING_MILLI = 1_200_000;
export const PROVISIONAL_MATCH_LIMIT = 5;
export const PROVISIONAL_K = 64;
export const ESTABLISHED_K = 32;
export const LOW_CONFIDENCE_THRESHOLD_PPM = 500_000;

export const MIN_FORM_SCORE = 1;
export const MAX_FORM_SCORE = 1000;
export const MIN_CONFIDENCE_PPM = 0;
export const MAX_CONFIDENCE_PPM = 1_000_000;
export const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

export type EloMode = "binary" | "scalar";

export const FORMULA_BY_MODE: Readonly<Record<EloMode, string>> = {
  binary: BINARY_FORMULA_VERSION,
  scalar: SCALAR_FORMULA_VERSION,
};
