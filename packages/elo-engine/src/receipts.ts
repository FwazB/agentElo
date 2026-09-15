import { attachFingerprint, canonicalJson, verifyFingerprint } from "./canonical.ts";
import {
  CANONICAL_JSON_PROFILE,
  CONFIDENCE_VERSION,
  type EloMode,
  FORMULA_BY_MODE,
  FORM_VERSION,
  LOW_CONFIDENCE_THRESHOLD_PPM,
  MAX_CONFIDENCE_PPM,
  MAX_FORM_SCORE,
  MAX_SAFE_INTEGER,
  MIN_CONFIDENCE_PPM,
  MIN_FORM_SCORE,
  NUMERIC_PROFILE,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  STARTING_RATING_MILLI,
} from "./constants.ts";
import { calculateElo, type EloCalculation } from "./mathcore.ts";

const PLAYER_ID_PATTERN = /^p_[0-9a-f]{32}$/;
const COMPETITION_ID_PATTERN = /^c_[0-9a-f]{32}$/;
const MATCH_ID_PATTERN = /^m_[0-9a-f]{32}$/;
const WEEK_ID_PATTERN = /^[0-9]{4}-W(?:0[1-9]|[1-4][0-9]|5[0-3])$/;
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const DECIMAL_15_PATTERN = /^-?[0-9]+\.[0-9]{15}$/;
const DECIMAL_12_PATTERN = /^-?[0-9]+\.[0-9]{12}$/;
const EXHIBITION_REASONS = new Set([
  "competition_mismatch",
  "week_mismatch",
  "form_version_mismatch",
  "confidence_version_mismatch",
  "low_confidence",
]);

export class ReceiptValidationError extends Error {
  override readonly name = "ReceiptValidationError";
}

export interface Confidence {
  band: "low" | "medium" | "high";
  certainty_ppm: number;
  coverage_ppm: number;
  effective_ppm: number;
  version: string;
}

export interface EloState {
  formula_version: string;
  last_match_fingerprint: string | null;
  rated_matches: number;
  rating_milli: number;
}

export interface PlayerReceipt {
  canonical_json_profile: string;
  competition_id: string;
  elo: Record<EloMode, EloState>;
  fingerprint: string;
  form: { confidence: Confidence; score: number; version: string };
  parent_fingerprint: string | null;
  player_id: string;
  privacy: Privacy;
  protocol_version: string;
  receipt_type: "player";
  schema_version: string;
  week_id: string;
}

export interface MatchPlayer {
  applied_delta_milli: number;
  confidence_ppm: number;
  form_score: number;
  player_id: string;
  rated_matches_after: number;
  rated_matches_before: number;
  rating_after_milli: number;
  rating_before_milli: number;
  source_receipt_fingerprint: string;
  week_id: string;
}

export interface CalculationProjection {
  actual_score_a: string;
  calculated_delta_milli_a: number;
  calculated_delta_milli_b: number;
  confidence_ppm: number;
  expected_score_a: string;
  k: number;
  numeric_profile: string;
  raw_delta_a: string;
}

export interface MatchReceipt {
  calculation: CalculationProjection;
  canonical_json_profile: string;
  competition_ids: string[];
  exhibition_reasons: string[];
  fingerprint: string;
  formula_version: string;
  match_id: string;
  mode: EloMode;
  players: Record<"a" | "b", MatchPlayer>;
  privacy: Privacy;
  protocol_version: string;
  rating_effect: "rated" | "exhibition";
  receipt_type: "match";
  schema_version: string;
}

export interface LeaderboardEntry {
  player_id: string;
  rank: number;
  rated_matches: number;
  rating_milli: number;
  source_receipt_fingerprint: string;
}

export interface LeaderboardReceipt {
  canonical_json_profile: string;
  competition_id: string;
  entries: LeaderboardEntry[];
  fingerprint: string;
  formula_version: string;
  mode: EloMode;
  privacy: Privacy;
  protocol_version: string;
  receipt_type: "leaderboard";
  schema_version: string;
}

interface Privacy {
  private_evidence_included: false;
  raw_activity_included: false;
}

export type Receipt = PlayerReceipt | MatchReceipt | LeaderboardReceipt;

const PUBLIC_PRIVACY: Privacy = {
  private_evidence_included: false,
  raw_activity_included: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactRecord(value: unknown, fields: ReadonlySet<string>, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ReceiptValidationError(`${name} must be an object`);
  const keys = Object.keys(value);
  const missing = [...fields].filter((field) => !Object.hasOwn(value, field)).sort();
  const extra = keys.filter((field) => !fields.has(field)).sort();
  if (missing.length > 0 || extra.length > 0) {
    throw new ReceiptValidationError(`${name} fields mismatch; missing=${missing.join(",")}, extra=${extra.join(",")}`);
  }
  return value;
}

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ReceiptValidationError(`${name} must be an integer`);
  }
  if (value < minimum || value > maximum) {
    throw new ReceiptValidationError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function pattern(value: unknown, expression: RegExp, name: string): string {
  if (typeof value !== "string" || !expression.test(value)) {
    throw new ReceiptValidationError(`${name} has an invalid format`);
  }
  return value;
}

function nullableFingerprint(value: unknown, name: string): string | null {
  return value === null ? null : pattern(value, FINGERPRINT_PATTERN, name);
}

function weeksInIsoYear(year: number): number {
  const januaryFirst = new Date(Date.UTC(year, 0, 1));
  const weekday = januaryFirst.getUTCDay() || 7;
  const leap = new Date(Date.UTC(year, 1, 29)).getUTCMonth() === 1;
  return weekday === 4 || (weekday === 3 && leap) ? 53 : 52;
}

function weekId(value: unknown, name: string): string {
  const result = pattern(value, WEEK_ID_PATTERN, name);
  const year = Number(result.slice(0, 4));
  const week = Number(result.slice(-2));
  if (week > weeksInIsoYear(year)) throw new ReceiptValidationError(`${name} is not a real ISO week`);
  return result;
}

export function confidenceBand(effectivePpm: number): Confidence["band"] {
  if (effectivePpm < LOW_CONFIDENCE_THRESHOLD_PPM) return "low";
  if (effectivePpm < 800_000) return "medium";
  return "high";
}

export function buildConfidence(coveragePpm: number, certaintyPpm: number): Confidence {
  const coverage = integer(coveragePpm, "coverage_ppm", MIN_CONFIDENCE_PPM, MAX_CONFIDENCE_PPM);
  const certainty = integer(certaintyPpm, "certainty_ppm", MIN_CONFIDENCE_PPM, MAX_CONFIDENCE_PPM);
  const effective = Math.min(coverage, certainty);
  return {
    band: confidenceBand(effective),
    certainty_ppm: certainty,
    coverage_ppm: coverage,
    effective_ppm: effective,
    version: CONFIDENCE_VERSION,
  };
}

function validateConfidence(value: unknown, name: string): Confidence {
  const confidence = exactRecord(
    value,
    new Set(["band", "certainty_ppm", "coverage_ppm", "effective_ppm", "version"]),
    name,
  );
  if (confidence.version !== CONFIDENCE_VERSION) throw new ReceiptValidationError(`${name}.version is unsupported`);
  const coverage = integer(confidence.coverage_ppm, `${name}.coverage_ppm`, 0, MAX_CONFIDENCE_PPM);
  const certainty = integer(confidence.certainty_ppm, `${name}.certainty_ppm`, 0, MAX_CONFIDENCE_PPM);
  const effective = integer(confidence.effective_ppm, `${name}.effective_ppm`, 0, MAX_CONFIDENCE_PPM);
  if (effective !== Math.min(coverage, certainty)) throw new ReceiptValidationError(`${name}.effective_ppm must be the lower axis`);
  if (confidence.band !== confidenceBand(effective)) throw new ReceiptValidationError(`${name}.band does not match effective_ppm`);
  return confidence as unknown as Confidence;
}

function initialEloState(mode: EloMode): EloState {
  return {
    formula_version: FORMULA_BY_MODE[mode],
    last_match_fingerprint: null,
    rated_matches: 0,
    rating_milli: STARTING_RATING_MILLI,
  };
}

function validateEloState(value: unknown, mode: EloMode, name: string): EloState {
  const state = exactRecord(
    value,
    new Set(["formula_version", "last_match_fingerprint", "rated_matches", "rating_milli"]),
    name,
  );
  if (state.formula_version !== FORMULA_BY_MODE[mode]) throw new ReceiptValidationError(`${name}.formula_version is unsupported`);
  const rating = integer(state.rating_milli, `${name}.rating_milli`, -MAX_SAFE_INTEGER, MAX_SAFE_INTEGER);
  const matches = integer(state.rated_matches, `${name}.rated_matches`, 0, MAX_SAFE_INTEGER);
  const lastMatch = nullableFingerprint(state.last_match_fingerprint, `${name}.last_match_fingerprint`);
  if (matches === 0 && (rating !== STARTING_RATING_MILLI || lastMatch !== null)) {
    throw new ReceiptValidationError(`${name} with zero matches must be at the 1200 starting rating`);
  }
  if (matches > 0 && lastMatch === null) throw new ReceiptValidationError(`${name} with matches needs a match fingerprint`);
  return state as unknown as EloState;
}

function validateCommon(receipt: Record<string, unknown>): void {
  if (receipt.schema_version !== SCHEMA_VERSION) throw new ReceiptValidationError("unsupported schema version");
  if (receipt.protocol_version !== PROTOCOL_VERSION) throw new ReceiptValidationError("unsupported protocol version");
  if (receipt.canonical_json_profile !== CANONICAL_JSON_PROFILE) throw new ReceiptValidationError("unsupported canonical JSON profile");
}

function validatePrivacy(value: unknown): Privacy {
  const privacy = exactRecord(value, new Set(["private_evidence_included", "raw_activity_included"]), "privacy");
  if (privacy.private_evidence_included !== false || privacy.raw_activity_included !== false) {
    throw new ReceiptValidationError("public receipts cannot include private evidence");
  }
  return privacy as unknown as Privacy;
}

function validateReceiptFingerprint(receipt: Record<string, unknown>): void {
  pattern(receipt.fingerprint, FINGERPRINT_PATTERN, "fingerprint");
  if (!verifyFingerprint(receipt)) throw new ReceiptValidationError("receipt fingerprint does not match its contents");
}

export interface BuildPlayerInput {
  player_id: string;
  competition_id: string;
  week_id: string;
  form_score: number;
  coverage_ppm: number;
  certainty_ppm: number;
  prior_receipt?: PlayerReceipt | null;
}

export function buildPlayerReceipt(input: BuildPlayerInput): PlayerReceipt {
  pattern(input.player_id, PLAYER_ID_PATTERN, "player_id");
  pattern(input.competition_id, COMPETITION_ID_PATTERN, "competition_id");
  weekId(input.week_id, "week_id");
  const score = integer(input.form_score, "form_score", MIN_FORM_SCORE, MAX_FORM_SCORE);
  const confidence = buildConfidence(input.coverage_ppm, input.certainty_ppm);
  let elo: Record<EloMode, EloState>;
  let parentFingerprint: string | null;
  if (input.prior_receipt === undefined || input.prior_receipt === null) {
    elo = { binary: initialEloState("binary"), scalar: initialEloState("scalar") };
    parentFingerprint = null;
  } else {
    const prior = validatePlayerReceipt(input.prior_receipt);
    if (prior.player_id !== input.player_id) throw new ReceiptValidationError("prior receipt belongs to another player");
    if (prior.competition_id !== input.competition_id) throw new ReceiptValidationError("prior receipt belongs to another competition");
    elo = structuredClone(prior.elo);
    parentFingerprint = prior.fingerprint;
  }
  const receipt = attachFingerprint({
    canonical_json_profile: CANONICAL_JSON_PROFILE,
    competition_id: input.competition_id,
    elo,
    form: { confidence, score, version: FORM_VERSION },
    parent_fingerprint: parentFingerprint,
    player_id: input.player_id,
    privacy: PUBLIC_PRIVACY,
    protocol_version: PROTOCOL_VERSION,
    receipt_type: "player" as const,
    schema_version: SCHEMA_VERSION,
    week_id: input.week_id,
  });
  return validatePlayerReceipt(receipt);
}

export function validatePlayerReceipt(value: unknown): PlayerReceipt {
  const receipt = exactRecord(
    value,
    new Set([
      "canonical_json_profile", "competition_id", "elo", "fingerprint", "form",
      "parent_fingerprint", "player_id", "privacy", "protocol_version",
      "receipt_type", "schema_version", "week_id",
    ]),
    "player receipt",
  );
  if (receipt.receipt_type !== "player") throw new ReceiptValidationError("receipt_type must be player");
  validateCommon(receipt);
  pattern(receipt.player_id, PLAYER_ID_PATTERN, "player_id");
  pattern(receipt.competition_id, COMPETITION_ID_PATTERN, "competition_id");
  weekId(receipt.week_id, "week_id");
  nullableFingerprint(receipt.parent_fingerprint, "parent_fingerprint");
  const form = exactRecord(receipt.form, new Set(["confidence", "score", "version"]), "form");
  if (form.version !== FORM_VERSION) throw new ReceiptValidationError("unsupported form version");
  integer(form.score, "form.score", MIN_FORM_SCORE, MAX_FORM_SCORE);
  validateConfidence(form.confidence, "form.confidence");
  const elo = exactRecord(receipt.elo, new Set(["binary", "scalar"]), "elo");
  validateEloState(elo.binary, "binary", "elo.binary");
  validateEloState(elo.scalar, "scalar", "elo.scalar");
  validatePrivacy(receipt.privacy);
  validateReceiptFingerprint(receipt);
  return receipt as unknown as PlayerReceipt;
}

export function compatibilityReasons(a: PlayerReceipt, b: PlayerReceipt): string[] {
  const reasons: string[] = [];
  if (a.competition_id !== b.competition_id) reasons.push("competition_mismatch");
  if (a.week_id !== b.week_id) reasons.push("week_mismatch");
  if (a.form.version !== b.form.version) reasons.push("form_version_mismatch");
  if (a.form.confidence.version !== b.form.confidence.version) reasons.push("confidence_version_mismatch");
  if (Math.min(a.form.confidence.effective_ppm, b.form.confidence.effective_ppm) < LOW_CONFIDENCE_THRESHOLD_PPM) {
    reasons.push("low_confidence");
  }
  return reasons.sort();
}

function calculationProjection(calculation: EloCalculation): CalculationProjection {
  return {
    actual_score_a: calculation.actual_score_a,
    calculated_delta_milli_a: calculation.candidate_delta_milli_a,
    calculated_delta_milli_b: calculation.candidate_delta_milli_b,
    confidence_ppm: calculation.confidence_ppm,
    expected_score_a: calculation.expected_score_a,
    k: calculation.k,
    numeric_profile: calculation.numeric_profile,
    raw_delta_a: calculation.raw_delta_a,
  };
}

export interface BuildMatchInput {
  receipt_a: PlayerReceipt;
  receipt_b: PlayerReceipt;
  mode: EloMode;
  match_id: string;
}

export function buildMatchReceipt(
  input: BuildMatchInput,
): [MatchReceipt, PlayerReceipt | null, PlayerReceipt | null] {
  const a = validatePlayerReceipt(input.receipt_a);
  const b = validatePlayerReceipt(input.receipt_b);
  if (a.player_id === b.player_id) throw new ReceiptValidationError("a player cannot duel themself");
  if (input.mode !== "binary" && input.mode !== "scalar") throw new ReceiptValidationError("mode must be binary or scalar");
  pattern(input.match_id, MATCH_ID_PATTERN, "match_id");
  const stateA = a.elo[input.mode];
  const stateB = b.elo[input.mode];
  const confidenceA = a.form.confidence.effective_ppm;
  const confidenceB = b.form.confidence.effective_ppm;
  const calculation = calculateElo({
    mode: input.mode,
    rating_milli_a: stateA.rating_milli,
    rating_milli_b: stateB.rating_milli,
    form_a: a.form.score,
    form_b: b.form.score,
    confidence_ppm_a: confidenceA,
    confidence_ppm_b: confidenceB,
    rated_matches_a: stateA.rated_matches,
    rated_matches_b: stateB.rated_matches,
  });
  const reasons = compatibilityReasons(a, b);
  const rated = reasons.length === 0;
  const deltaA = rated ? calculation.candidate_delta_milli_a : 0;
  const deltaB = deltaA === 0 ? 0 : -deltaA;
  const match = attachFingerprint({
    calculation: calculationProjection(calculation),
    canonical_json_profile: CANONICAL_JSON_PROFILE,
    competition_ids: [...new Set([a.competition_id, b.competition_id])].sort(),
    exhibition_reasons: reasons,
    formula_version: FORMULA_BY_MODE[input.mode],
    match_id: input.match_id,
    mode: input.mode,
    players: {
      a: matchPlayer(a, stateA, confidenceA, deltaA, rated),
      b: matchPlayer(b, stateB, confidenceB, deltaB, rated),
    },
    privacy: PUBLIC_PRIVACY,
    protocol_version: PROTOCOL_VERSION,
    rating_effect: rated ? "rated" as const : "exhibition" as const,
    receipt_type: "match" as const,
    schema_version: SCHEMA_VERSION,
  });
  const validated = validateMatchReceipt(match);
  if (!rated) return [validated, null, null];
  return [validated, applyRatedMatch(a, validated, input.mode, "a"), applyRatedMatch(b, validated, input.mode, "b")];
}

function matchPlayer(
  player: PlayerReceipt,
  state: EloState,
  confidence: number,
  delta: number,
  rated: boolean,
): MatchPlayer {
  return {
    applied_delta_milli: delta,
    confidence_ppm: confidence,
    form_score: player.form.score,
    player_id: player.player_id,
    rated_matches_after: state.rated_matches + (rated ? 1 : 0),
    rated_matches_before: state.rated_matches,
    rating_after_milli: state.rating_milli + delta,
    rating_before_milli: state.rating_milli,
    source_receipt_fingerprint: player.fingerprint,
    week_id: player.week_id,
  };
}

function applyRatedMatch(player: PlayerReceipt, match: MatchReceipt, mode: EloMode, side: "a" | "b"): PlayerReceipt {
  const updated = structuredClone(player);
  const state = updated.elo[mode];
  const matchPlayerValue = match.players[side];
  updated.parent_fingerprint = player.fingerprint;
  state.rating_milli = matchPlayerValue.rating_after_milli;
  state.rated_matches = matchPlayerValue.rated_matches_after;
  state.last_match_fingerprint = match.fingerprint;
  return validatePlayerReceipt(attachFingerprint(updated));
}

function validateMatchPlayer(value: unknown, name: string): MatchPlayer {
  const player = exactRecord(
    value,
    new Set([
      "applied_delta_milli", "confidence_ppm", "form_score", "player_id",
      "rated_matches_after", "rated_matches_before", "rating_after_milli",
      "rating_before_milli", "source_receipt_fingerprint", "week_id",
    ]),
    name,
  );
  pattern(player.player_id, PLAYER_ID_PATTERN, `${name}.player_id`);
  pattern(player.source_receipt_fingerprint, FINGERPRINT_PATTERN, `${name}.source_receipt_fingerprint`);
  weekId(player.week_id, `${name}.week_id`);
  const delta = integer(player.applied_delta_milli, `${name}.applied_delta_milli`, -MAX_SAFE_INTEGER, MAX_SAFE_INTEGER);
  const after = integer(player.rating_after_milli, `${name}.rating_after_milli`, -MAX_SAFE_INTEGER, MAX_SAFE_INTEGER);
  const before = integer(player.rating_before_milli, `${name}.rating_before_milli`, -MAX_SAFE_INTEGER, MAX_SAFE_INTEGER);
  integer(player.form_score, `${name}.form_score`, MIN_FORM_SCORE, MAX_FORM_SCORE);
  integer(player.confidence_ppm, `${name}.confidence_ppm`, 0, MAX_CONFIDENCE_PPM);
  integer(player.rated_matches_before, `${name}.rated_matches_before`, 0, MAX_SAFE_INTEGER);
  integer(player.rated_matches_after, `${name}.rated_matches_after`, 0, MAX_SAFE_INTEGER);
  if (after !== before + delta) throw new ReceiptValidationError(`${name} rating arithmetic is invalid`);
  return player as unknown as MatchPlayer;
}

export function validateMatchReceipt(value: unknown): MatchReceipt {
  const receipt = exactRecord(
    value,
    new Set([
      "calculation", "canonical_json_profile", "competition_ids", "exhibition_reasons",
      "fingerprint", "formula_version", "match_id", "mode", "players", "privacy",
      "protocol_version", "rating_effect", "receipt_type", "schema_version",
    ]),
    "match receipt",
  );
  if (receipt.receipt_type !== "match") throw new ReceiptValidationError("receipt_type must be match");
  validateCommon(receipt);
  if (receipt.mode !== "binary" && receipt.mode !== "scalar") throw new ReceiptValidationError("invalid match mode");
  const mode = receipt.mode;
  if (receipt.formula_version !== FORMULA_BY_MODE[mode]) throw new ReceiptValidationError("match formula version does not match its mode");
  pattern(receipt.match_id, MATCH_ID_PATTERN, "match_id");
  if (!Array.isArray(receipt.competition_ids) || receipt.competition_ids.length < 1 || receipt.competition_ids.length > 2) {
    throw new ReceiptValidationError("competition_ids must contain one or two IDs");
  }
  const competitionIds = receipt.competition_ids.map((item, index) => pattern(item, COMPETITION_ID_PATTERN, `competition_ids[${index}]`));
  if (canonicalJson(competitionIds) !== canonicalJson([...new Set(competitionIds)].sort())) {
    throw new ReceiptValidationError("competition_ids must be sorted and unique");
  }
  if (!Array.isArray(receipt.exhibition_reasons)) throw new ReceiptValidationError("exhibition_reasons must be an array");
  const reasons = receipt.exhibition_reasons.map((item) => {
    if (typeof item !== "string" || !EXHIBITION_REASONS.has(item)) throw new ReceiptValidationError("unknown exhibition reason");
    return item;
  });
  if (canonicalJson(reasons) !== canonicalJson([...new Set(reasons)].sort())) {
    throw new ReceiptValidationError("exhibition_reasons must be sorted and unique");
  }
  const effect = reasons.length === 0 ? "rated" : "exhibition";
  if (receipt.rating_effect !== effect) throw new ReceiptValidationError("rating_effect does not match reasons");
  const players = exactRecord(receipt.players, new Set(["a", "b"]), "players");
  const a = validateMatchPlayer(players.a, "players.a");
  const b = validateMatchPlayer(players.b, "players.b");
  if (a.player_id === b.player_id) throw new ReceiptValidationError("match players must be distinct");
  const derived: string[] = [];
  if (competitionIds.length === 2) derived.push("competition_mismatch");
  if (a.week_id !== b.week_id) derived.push("week_mismatch");
  if (Math.min(a.confidence_ppm, b.confidence_ppm) < LOW_CONFIDENCE_THRESHOLD_PPM) derived.push("low_confidence");
  if (canonicalJson(reasons) !== canonicalJson(derived.sort())) {
    throw new ReceiptValidationError("exhibition_reasons do not match public compatibility fields");
  }
  const calculation = exactRecord(
    receipt.calculation,
    new Set([
      "actual_score_a", "calculated_delta_milli_a", "calculated_delta_milli_b",
      "confidence_ppm", "expected_score_a", "k", "numeric_profile", "raw_delta_a",
    ]),
    "calculation",
  );
  if (calculation.numeric_profile !== NUMERIC_PROFILE) throw new ReceiptValidationError("unsupported numeric profile");
  pattern(calculation.actual_score_a, DECIMAL_15_PATTERN, "actual_score_a");
  pattern(calculation.expected_score_a, DECIMAL_15_PATTERN, "expected_score_a");
  pattern(calculation.raw_delta_a, DECIMAL_12_PATTERN, "raw_delta_a");
  if (calculation.k !== 32 && calculation.k !== 64) throw new ReceiptValidationError("calculation.k must be 32 or 64");
  const calculatedA = integer(calculation.calculated_delta_milli_a, "calculation.calculated_delta_milli_a", -MAX_SAFE_INTEGER, MAX_SAFE_INTEGER);
  const calculatedB = integer(calculation.calculated_delta_milli_b, "calculation.calculated_delta_milli_b", -MAX_SAFE_INTEGER, MAX_SAFE_INTEGER);
  if (calculatedB !== (calculatedA === 0 ? 0 : -calculatedA)) throw new ReceiptValidationError("calculated deltas must be zero-sum");
  const expected = calculationProjection(calculateElo({
    mode,
    rating_milli_a: a.rating_before_milli,
    rating_milli_b: b.rating_before_milli,
    form_a: a.form_score,
    form_b: b.form_score,
    confidence_ppm_a: a.confidence_ppm,
    confidence_ppm_b: b.confidence_ppm,
    rated_matches_a: a.rated_matches_before,
    rated_matches_b: b.rated_matches_before,
  }));
  if (canonicalJson(calculation) !== canonicalJson(expected)) throw new ReceiptValidationError("stored calculation does not replay exactly");
  if (effect === "rated") {
    if (a.applied_delta_milli !== calculatedA || b.applied_delta_milli !== calculatedB) throw new ReceiptValidationError("rated delta does not match calculation");
    if (a.rated_matches_after !== a.rated_matches_before + 1 || b.rated_matches_after !== b.rated_matches_before + 1) {
      throw new ReceiptValidationError("rated match count did not increment");
    }
  } else {
    for (const player of [a, b]) {
      if (player.applied_delta_milli !== 0 || player.rated_matches_after !== player.rated_matches_before) {
        throw new ReceiptValidationError("exhibition must not change rating state");
      }
    }
  }
  validatePrivacy(receipt.privacy);
  validateReceiptFingerprint(receipt);
  return receipt as unknown as MatchReceipt;
}

export function buildLeaderboardReceipt(receipts: readonly PlayerReceipt[], mode: EloMode): LeaderboardReceipt {
  if (mode !== "binary" && mode !== "scalar") throw new ReceiptValidationError("mode must be binary or scalar");
  const players = receipts.map(validatePlayerReceipt);
  if (players.length < 2) throw new ReceiptValidationError("leaderboard requires at least two players");
  if (new Set(players.map((player) => player.player_id)).size !== players.length) throw new ReceiptValidationError("leaderboard contains a duplicate player");
  const competitions = new Set(players.map((player) => player.competition_id));
  if (competitions.size !== 1) throw new ReceiptValidationError("leaderboard players must share a competition");
  const ranked = [...players].sort((a, b) =>
    b.elo[mode].rating_milli - a.elo[mode].rating_milli ||
    b.elo[mode].rated_matches - a.elo[mode].rated_matches ||
    a.player_id.localeCompare(b.player_id),
  );
  const result = attachFingerprint({
    canonical_json_profile: CANONICAL_JSON_PROFILE,
    competition_id: ranked[0]?.competition_id ?? "",
    entries: ranked.map((player, index) => ({
      player_id: player.player_id,
      rank: index + 1,
      rated_matches: player.elo[mode].rated_matches,
      rating_milli: player.elo[mode].rating_milli,
      source_receipt_fingerprint: player.fingerprint,
    })),
    formula_version: FORMULA_BY_MODE[mode],
    mode,
    privacy: PUBLIC_PRIVACY,
    protocol_version: PROTOCOL_VERSION,
    receipt_type: "leaderboard" as const,
    schema_version: SCHEMA_VERSION,
  });
  return validateLeaderboardReceipt(result);
}

export function validateLeaderboardReceipt(value: unknown): LeaderboardReceipt {
  const receipt = exactRecord(
    value,
    new Set([
      "canonical_json_profile", "competition_id", "entries", "fingerprint",
      "formula_version", "mode", "privacy", "protocol_version", "receipt_type", "schema_version",
    ]),
    "leaderboard receipt",
  );
  if (receipt.receipt_type !== "leaderboard") throw new ReceiptValidationError("receipt_type must be leaderboard");
  validateCommon(receipt);
  if (receipt.mode !== "binary" && receipt.mode !== "scalar") throw new ReceiptValidationError("invalid leaderboard mode");
  if (receipt.formula_version !== FORMULA_BY_MODE[receipt.mode]) throw new ReceiptValidationError("leaderboard formula does not match mode");
  pattern(receipt.competition_id, COMPETITION_ID_PATTERN, "competition_id");
  if (!Array.isArray(receipt.entries) || receipt.entries.length < 2) throw new ReceiptValidationError("leaderboard requires at least two entries");
  const players = new Set<string>();
  const fingerprints = new Set<string>();
  let previous: readonly [number, number, string] | undefined;
  receipt.entries.forEach((valueEntry, index) => {
    const entry = exactRecord(valueEntry, new Set(["player_id", "rank", "rated_matches", "rating_milli", "source_receipt_fingerprint"]), `entries[${index}]`);
    const player = pattern(entry.player_id, PLAYER_ID_PATTERN, `entries[${index}].player_id`);
    const fingerprint = pattern(entry.source_receipt_fingerprint, FINGERPRINT_PATTERN, `entries[${index}].source_receipt_fingerprint`);
    if (players.has(player) || fingerprints.has(fingerprint)) throw new ReceiptValidationError("leaderboard entries must be unique");
    players.add(player);
    fingerprints.add(fingerprint);
    if (entry.rank !== index + 1) throw new ReceiptValidationError("leaderboard ranks must be contiguous");
    const rating = integer(entry.rating_milli, `entries[${index}].rating_milli`, -MAX_SAFE_INTEGER, MAX_SAFE_INTEGER);
    const matches = integer(entry.rated_matches, `entries[${index}].rated_matches`, 0, MAX_SAFE_INTEGER);
    const current = [-rating, -matches, player] as const;
    if (previous !== undefined) {
      const incorrectlySorted = current[0] < previous[0] ||
        (current[0] === previous[0] && current[1] < previous[1]) ||
        (current[0] === previous[0] && current[1] === previous[1] && current[2] < previous[2]);
      if (incorrectlySorted) throw new ReceiptValidationError("leaderboard entries are not deterministically sorted");
    }
    previous = current;
  });
  validatePrivacy(receipt.privacy);
  validateReceiptFingerprint(receipt);
  return receipt as unknown as LeaderboardReceipt;
}

export function validateReceipt(value: unknown): Receipt {
  if (!isRecord(value)) throw new ReceiptValidationError("receipt must be an object");
  if (value.receipt_type === "player") return validatePlayerReceipt(value);
  if (value.receipt_type === "match") return validateMatchReceipt(value);
  if (value.receipt_type === "leaderboard") return validateLeaderboardReceipt(value);
  throw new ReceiptValidationError("unknown receipt_type");
}
