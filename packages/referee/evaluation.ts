import { isProxy } from "node:util/types";

/** Offline diagnostic metrics. This module never authorizes ranked matches. */
export type Outcome = "a_wins" | "b_wins" | "draw" | "unrated";
export type CalibrationSplit = "calibration" | "holdout";
export type DatasetProvenance = "synthetic" | "human_labeled";

export interface CalibrationEntry {
  entryId: string;
  participantId: string;
}

export interface CalibrationCase {
  id: string;
  split: CalibrationSplit;
  entryA: CalibrationEntry;
  entryB: CalibrationEntry;
  labels: Array<{ raterId: string; outcome: Outcome }>;
}

export interface JudgeRun {
  caseId: string;
  repeat: number;
  order: "ab" | "ba";
  /** Winner names refer to the displayed order, including for swapped runs. */
  outcome: Outcome;
  judgeFingerprint: string;
}

export interface EvaluationInput {
  datasetProvenance: DatasetProvenance;
  /** Digest of the frozen judge configuration and prompt. */
  judgeFingerprint: string;
  cases: CalibrationCase[];
  runs: JudgeRun[];
}

export interface RatioMetric {
  numerator: number;
  denominator: number;
  /** Fractions are in [0, 1]; null means there was no denominator. */
  value: number | null;
}

export interface SplitCalibrationReport {
  caseIds: string[];
  cases: number;
  casesWithHumanConsensus: number;
  /** All unordered pairs of human labels, counted once per case. */
  humanPairwiseAgreement: RatioMetric;
  /** Every consolidated repeat compared with every individual human label. */
  judgeHumanAgreement: RatioMetric;
  /** Every consolidated repeat compared with a strict human majority, if any. */
  judgeHumanConsensusAgreement: RatioMetric;
  /** All unordered pairs of consolidated repeats within each case. */
  repeatability: RatioMetric;
  /** AB and normalized BA outcomes agree, including matching abstentions. */
  orderConsistency: RatioMetric;
  /** Consolidated unrated judgments, including conflicts between orders. */
  abstentionRate: RatioMetric;
  humanConsensusCoverage: RatioMetric;
  judgmentCoverage: RatioMetric;
  coverage: {
    humanLabels: number;
    judgeRuns: number;
    consolidatedJudgments: number;
    ratedJudgments: number;
    orderConflicts: number;
  };
}

export interface CalibrationReport {
  status: "pilot_only";
  acceptance: "requires_predeclared_external_human_process";
  datasetProvenance: DatasetProvenance;
  judgeFingerprint: string;
  repeatCount: number | null;
  splits: Record<CalibrationSplit, SplitCalibrationReport>;
}

const outcomes: readonly Outcome[] = ["a_wins", "b_wins", "draw", "unrated"];
const fingerprintPattern = /^sha256:[a-f0-9]{64}$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const MAX_CASES = 10_000;
const MAX_RUNS = 200_000;
const MAX_LABELS = 20;
const MAX_REPEATS = 100;

function invalid(path: string, message: string): never {
  throw new TypeError(`Invalid evaluation input at ${path}: ${message}`);
}

function record(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || isProxy(value) || Array.isArray(value)) {
    invalid(path, "expected an object");
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(path, "expected a plain object");
  const actualKeys = Reflect.ownKeys(value);
  if (actualKeys.length !== keys.length || actualKeys.some((key) => typeof key !== "string" || !keys.includes(key))) {
    invalid(path, "object keys must match the schema exactly");
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
      invalid(path, "expected enumerable data properties");
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function list(value: unknown, maximum: number, path: string): unknown[] {
  if (value === null || typeof value !== "object" || isProxy(value) || !Array.isArray(value)) invalid(path, "expected an array");
  if (Object.getPrototypeOf(value) !== Array.prototype) invalid(path, "expected a plain array");
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value as number;
  if (length > maximum) invalid(path, "array exceeds the allowed size");
  if (Reflect.ownKeys(value).length !== length + 1) invalid(path, "sparse or decorated arrays are forbidden");
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
      invalid(path, "expected enumerable array data items");
    }
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

function id(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length > 80 || value.trim() !== value || !idPattern.test(value)) {
    invalid(path, "expected a bounded ASCII identifier");
  }
  return value;
}

function outcome(value: unknown, path: string): Outcome {
  if (!outcomes.includes(value as Outcome)) invalid(path, "unknown outcome");
  return value as Outcome;
}

function fingerprint(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length !== 71 || !fingerprintPattern.test(value)) invalid(path, "expected a lowercase sha256 digest");
  return value;
}

function entry(value: unknown, path: string): CalibrationEntry {
  const obj = record(value, ["entryId", "participantId"], path);
  return { entryId: id(obj.entryId, `${path}.entryId`), participantId: id(obj.participantId, `${path}.participantId`) };
}

function parseInput(value: unknown): EvaluationInput {
  const obj = record(value, ["datasetProvenance", "judgeFingerprint", "cases", "runs"], "input");
  if (obj.datasetProvenance !== "synthetic" && obj.datasetProvenance !== "human_labeled") {
    invalid("datasetProvenance", "expected synthetic or human_labeled");
  }
  const judgeFingerprint = fingerprint(obj.judgeFingerprint, "judgeFingerprint");
  const cases = list(obj.cases, MAX_CASES, "cases").map((value, index): CalibrationCase => {
    const path = `cases[${index}]`;
    const item = record(value, ["id", "split", "entryA", "entryB", "labels"], path);
    if (item.split !== "calibration" && item.split !== "holdout") invalid(`${path}.split`, "unknown split");
    const entryA = entry(item.entryA, `${path}.entryA`);
    const entryB = entry(item.entryB, `${path}.entryB`);
    if (entryA.entryId === entryB.entryId || entryA.participantId === entryB.participantId) invalid(path, "self-match is forbidden");
    const raters = new Set<string>();
    const labels = list(item.labels, MAX_LABELS, `${path}.labels`).map((value, labelIndex) => {
      const labelPath = `${path}.labels[${labelIndex}]`;
      const label = record(value, ["raterId", "outcome"], labelPath);
      const raterId = id(label.raterId, `${labelPath}.raterId`);
      if (raters.has(raterId)) invalid(labelPath, "duplicate rater in the same case");
      raters.add(raterId);
      return { raterId, outcome: outcome(label.outcome, `${labelPath}.outcome`) };
    });
    if (labels.length < 2) invalid(`${path}.labels`, "at least two distinct raters are required");
    return { id: id(item.id, `${path}.id`), split: item.split, entryA, entryB, labels };
  });
  const runs = list(obj.runs, MAX_RUNS, "runs").map((value, index): JudgeRun => {
    const path = `runs[${index}]`;
    const run = record(value, ["caseId", "repeat", "order", "outcome", "judgeFingerprint"], path);
    if (typeof run.repeat !== "number" || !Number.isSafeInteger(run.repeat) || run.repeat < 0 || run.repeat >= MAX_REPEATS) {
      invalid(`${path}.repeat`, "expected an integer repeat index from zero through 99");
    }
    if (run.order !== "ab" && run.order !== "ba") invalid(`${path}.order`, "expected ab or ba");
    if (fingerprint(run.judgeFingerprint, `${path}.judgeFingerprint`) !== judgeFingerprint) {
      invalid(`${path}.judgeFingerprint`, "all runs must use the frozen judge fingerprint");
    }
    return {
      caseId: id(run.caseId, `${path}.caseId`), repeat: run.repeat,
      order: run.order, outcome: outcome(run.outcome, `${path}.outcome`), judgeFingerprint,
    };
  });
  return { datasetProvenance: obj.datasetProvenance, judgeFingerprint, cases, runs };
}

type RunPair = Partial<Record<"ab" | "ba", Outcome>>;
type RunIndex = Map<string, Map<number, RunPair>>;

function validateSchedule(input: EvaluationInput): { runs: RunIndex; repeatCount: number | null } {
  const runs: RunIndex = new Map();
  const participantSplits = new Map<string, CalibrationSplit>();
  const entrySplits = new Map<string, CalibrationSplit>();
  const entryOwners = new Map<string, string>();
  const entryPairs = new Set<string>();
  for (const item of input.cases) {
    if (runs.has(item.id)) invalid("cases", "duplicate case identifier");
    const pair = JSON.stringify([item.entryA.entryId, item.entryB.entryId].sort());
    if (entryPairs.has(pair)) invalid("cases", "duplicate unordered entry pair");
    entryPairs.add(pair);
    runs.set(item.id, new Map());
    for (const selected of [item.entryA, item.entryB]) {
      const participantSplit = participantSplits.get(selected.participantId);
      const entrySplit = entrySplits.get(selected.entryId);
      if (participantSplit !== undefined && participantSplit !== item.split) invalid("cases", "participant leakage across splits");
      if (entrySplit !== undefined && entrySplit !== item.split) invalid("cases", "entry leakage across splits");
      const owner = entryOwners.get(selected.entryId);
      if (owner !== undefined && owner !== selected.participantId) invalid("cases", "one entry identifier has conflicting participants");
      participantSplits.set(selected.participantId, item.split);
      entrySplits.set(selected.entryId, item.split);
      entryOwners.set(selected.entryId, selected.participantId);
    }
  }
  for (const run of input.runs) {
    const caseRuns = runs.get(run.caseId);
    if (!caseRuns) invalid("runs", "run references an unknown case");
    let pair = caseRuns.get(run.repeat);
    if (!pair) { pair = {}; caseRuns.set(run.repeat, pair); }
    if (pair[run.order] !== undefined) invalid("runs", "duplicate case/repeat/order run");
    pair[run.order] = run.outcome;
  }
  let repeatCount: number | null = null;
  for (const caseRuns of runs.values()) {
    const repeats = [...caseRuns.keys()].sort((a, b) => a - b);
    if (repeats.length < 2) invalid("runs", "every case requires at least two repeats");
    if (repeats.some((value, index) => value !== index)) invalid("runs", "repeat indices must start at zero and be contiguous");
    if (repeatCount !== null && repeatCount !== repeats.length) invalid("runs", "every case must have the same repeat count");
    repeatCount = repeats.length;
    for (const pair of caseRuns.values()) {
      if (pair.ab === undefined || pair.ba === undefined) invalid("runs", "every case/repeat requires both ab and ba orders");
    }
  }
  return { runs, repeatCount };
}

function ratio(numerator = 0, denominator = 0): RatioMetric {
  return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator };
}

function observe(metric: RatioMetric, agrees: boolean): void {
  metric.denominator += 1;
  if (agrees) metric.numerator += 1;
  metric.value = metric.numerator / metric.denominator;
}

function comparePairs(values: readonly Outcome[], metric: RatioMetric): void {
  const counts: Record<Outcome, number> = { a_wins: 0, b_wins: 0, draw: 0, unrated: 0 };
  for (const value of values) counts[value] += 1;
  for (const count of Object.values(counts)) metric.numerator += count * (count - 1) / 2;
  metric.denominator += values.length * (values.length - 1) / 2;
  metric.value = metric.denominator === 0 ? null : metric.numerator / metric.denominator;
}

function normalizedSwap(value: Outcome): Outcome {
  return value === "a_wins" ? "b_wins" : value === "b_wins" ? "a_wins" : value;
}

function splitReport(): SplitCalibrationReport {
  return {
    caseIds: [], cases: 0, casesWithHumanConsensus: 0,
    humanPairwiseAgreement: ratio(), judgeHumanAgreement: ratio(), judgeHumanConsensusAgreement: ratio(),
    repeatability: ratio(), orderConsistency: ratio(), abstentionRate: ratio(),
    humanConsensusCoverage: ratio(), judgmentCoverage: ratio(),
    coverage: { humanLabels: 0, judgeRuns: 0, consolidatedJudgments: 0, ratedJudgments: 0, orderConflicts: 0 },
  };
}

/**
 * Validate a complete frozen-judge evaluation, then report each split separately.
 * Order conflicts become unrated. Abstentions stay in all agreement denominators;
 * high repeatability can therefore coexist with high abstention. Human ties and
 * pluralities without a strict majority do not create a consensus target.
 * Provenance and judge digests are declarations, not independently verified facts.
 */
export function evaluateCalibration(value: unknown): CalibrationReport {
  const input = parseInput(value);
  const schedule = validateSchedule(input);
  const splits = { calibration: splitReport(), holdout: splitReport() };
  for (const item of input.cases) {
    const report = splits[item.split];
    report.caseIds.push(item.id);
    report.cases += 1;
    report.coverage.humanLabels += item.labels.length;
    const labels = item.labels.map((label) => label.outcome);
    comparePairs(labels, report.humanPairwiseAgreement);
    const consensus = outcomes.find((candidate) => labels.filter((label) => label === candidate).length > labels.length / 2);
    if (consensus !== undefined) report.casesWithHumanConsensus += 1;
    observe(report.humanConsensusCoverage, consensus !== undefined);
    const consolidated: Outcome[] = [];
    // Schedule validation above guarantees both orders exist in every pair.
    for (const pair of schedule.runs.get(item.id)!.values()) {
      const ab = pair.ab!;
      const ba = normalizedSwap(pair.ba!);
      const consistent = ab === ba;
      const judgment = consistent ? ab : "unrated";
      consolidated.push(judgment);
      observe(report.orderConsistency, consistent);
      if (!consistent) report.coverage.orderConflicts += 1;
      observe(report.abstentionRate, judgment === "unrated");
      observe(report.judgmentCoverage, judgment !== "unrated");
      for (const label of labels) observe(report.judgeHumanAgreement, judgment === label);
      if (consensus !== undefined) observe(report.judgeHumanConsensusAgreement, judgment === consensus);
      report.coverage.judgeRuns += 2;
      report.coverage.consolidatedJudgments += 1;
      if (judgment !== "unrated") report.coverage.ratedJudgments += 1;
    }
    comparePairs(consolidated, report.repeatability);
  }
  return {
    status: "pilot_only", acceptance: "requires_predeclared_external_human_process",
    datasetProvenance: input.datasetProvenance, judgeFingerprint: input.judgeFingerprint,
    repeatCount: schedule.repeatCount, splits,
  };
}
