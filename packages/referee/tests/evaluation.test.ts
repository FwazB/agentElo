import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateCalibration, type CalibrationCase, type EvaluationInput, type JudgeRun, type Outcome, type RatioMetric,
} from "../evaluation.ts";

const judgeFingerprint = `sha256:${"a".repeat(64)}`;

function exampleCase(id: string, split: "calibration" | "holdout", labels: Outcome[]): CalibrationCase {
  return {
    id, split,
    entryA: { entryId: `${id}-entry-a`, participantId: `${id}-participant-a` },
    entryB: { entryId: `${id}-entry-b`, participantId: `${id}-participant-b` },
    labels: labels.map((outcome, index) => ({ raterId: `simulated-rater-${index}`, outcome })),
  };
}

function runsFor(caseId: string, pairs: Array<[Outcome, Outcome]>): JudgeRun[] {
  return pairs.flatMap(([ab, ba], repeat) => [
    { caseId, repeat, order: "ab" as const, outcome: ab, judgeFingerprint },
    { caseId, repeat, order: "ba" as const, outcome: ba, judgeFingerprint },
  ]);
}

function fixture(): EvaluationInput {
  return {
    datasetProvenance: "synthetic", judgeFingerprint,
    cases: [exampleCase("cal-1", "calibration", ["a_wins", "a_wins", "b_wins"]), exampleCase("held-1", "holdout", ["draw", "draw"])],
    runs: [
      ...runsFor("cal-1", [["a_wins", "b_wins"], ["a_wins", "a_wins"]]),
      ...runsFor("held-1", [["draw", "draw"], ["draw", "draw"]]),
    ],
  };
}

function expected(numerator: number, denominator: number): RatioMetric {
  return { numerator, denominator, value: denominator ? numerator / denominator : null };
}

test("reports exact fractions separately by split and keeps order conflicts in agreement denominators", () => {
  const report = evaluateCalibration(fixture());
  assert.equal(report.status, "pilot_only");
  assert.equal(report.acceptance, "requires_predeclared_external_human_process");
  assert.equal(report.datasetProvenance, "synthetic");
  assert.equal(report.judgeFingerprint, judgeFingerprint);
  assert.equal(report.repeatCount, 2);
  assert.deepEqual(report.splits.calibration, {
    caseIds: ["cal-1"], cases: 1, casesWithHumanConsensus: 1,
    humanPairwiseAgreement: expected(1, 3), judgeHumanAgreement: expected(2, 6),
    judgeHumanConsensusAgreement: expected(1, 2), repeatability: expected(0, 1),
    orderConsistency: expected(1, 2), abstentionRate: expected(1, 2),
    humanConsensusCoverage: expected(1, 1), judgmentCoverage: expected(1, 2),
    coverage: { humanLabels: 3, judgeRuns: 4, consolidatedJudgments: 2, ratedJudgments: 1, orderConflicts: 1 },
  });
  assert.deepEqual(report.splits.holdout.judgeHumanAgreement, expected(4, 4));
  assert.deepEqual(report.splits.holdout.abstentionRate, expected(0, 2));
  assert.deepEqual(report.splits.holdout.repeatability, expected(1, 1));
  assert.equal("judgeHumanAgreement" in report, false, "splits must not be blended");
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("simulated-rater"), false);
  assert.equal(serialized.includes("participant-a"), false);
  assert.equal(serialized.includes("entry-a"), false);
});

test("normalizes displayed winners for both swap directions", () => {
  for (const [winner, swapped] of [["a_wins", "b_wins"], ["b_wins", "a_wins"]] as const) {
    const input: EvaluationInput = {
      datasetProvenance: "synthetic", judgeFingerprint,
      cases: [exampleCase("case", "calibration", [winner, winner])],
      runs: runsFor("case", [[winner, swapped], [winner, swapped]]),
    };
    const split = evaluateCalibration(input).splits.calibration;
    assert.deepEqual(split.orderConsistency, expected(2, 2));
    assert.deepEqual(split.judgeHumanAgreement, expected(4, 4));
    assert.deepEqual(split.abstentionRate, expected(0, 2));
  }
});

test("human ties and disputed pluralities have no consensus and are not coerced to a draw", () => {
  for (const labels of [["a_wins", "b_wins"], ["a_wins", "a_wins", "draw", "b_wins"]] satisfies Outcome[][]) {
    const input: EvaluationInput = {
      datasetProvenance: "human_labeled", judgeFingerprint,
      cases: [exampleCase("case", "calibration", labels)],
      runs: runsFor("case", [["draw", "draw"], ["draw", "draw"]]),
    };
    const report = evaluateCalibration(input);
    assert.equal(report.datasetProvenance, "human_labeled");
    assert.equal(report.status, "pilot_only");
    assert.equal(report.splits.calibration.casesWithHumanConsensus, 0);
    assert.deepEqual(report.splits.calibration.judgeHumanConsensusAgreement, expected(0, 0));
    assert.deepEqual(report.splits.calibration.humanConsensusCoverage, expected(0, 1));
    assert.deepEqual(report.splits.calibration.judgeHumanAgreement, expected(labels.includes("draw") ? 2 : 0, labels.length * 2));
  }
});

test("repeatability compares all pairs of consolidated repeats, not only neighboring repeats", () => {
  const input: EvaluationInput = {
    datasetProvenance: "synthetic", judgeFingerprint,
    cases: [exampleCase("case", "holdout", ["a_wins", "a_wins"])],
    runs: runsFor("case", [["a_wins", "b_wins"], ["draw", "draw"], ["a_wins", "b_wins"]]).reverse(),
  };
  const report = evaluateCalibration(input);
  assert.equal(report.repeatCount, 3);
  assert.deepEqual(report.splits.holdout.repeatability, expected(1, 3));
  assert.deepEqual(report.splits.holdout.judgeHumanAgreement, expected(4, 6));
});

test("matching abstentions count as consistency but remain visible as zero judgment coverage", () => {
  const input: EvaluationInput = {
    datasetProvenance: "synthetic", judgeFingerprint,
    cases: [exampleCase("case", "holdout", ["a_wins", "a_wins"])],
    runs: runsFor("case", [["unrated", "unrated"], ["unrated", "unrated"]]),
  };
  const split = evaluateCalibration(input).splits.holdout;
  assert.deepEqual(split.judgeHumanAgreement, expected(0, 4));
  assert.deepEqual(split.judgeHumanConsensusAgreement, expected(0, 2));
  assert.deepEqual(split.abstentionRate, expected(2, 2));
  assert.deepEqual(split.judgmentCoverage, expected(0, 2));
  assert.deepEqual(split.repeatability, expected(1, 1));
  assert.deepEqual(split.orderConsistency, expected(2, 2));
});

test("unrated human consensus is preserved as its own outcome", () => {
  const input: EvaluationInput = {
    datasetProvenance: "synthetic", judgeFingerprint,
    cases: [exampleCase("case", "holdout", ["unrated", "unrated"])],
    runs: runsFor("case", [["unrated", "unrated"], ["draw", "draw"]]),
  };
  const split = evaluateCalibration(input).splits.holdout;
  assert.deepEqual(split.judgeHumanConsensusAgreement, expected(1, 2));
  assert.deepEqual(split.judgeHumanAgreement, expected(2, 4));
  assert.deepEqual(split.abstentionRate, expected(1, 2));
});

test("empty input and empty splits report null denominators", () => {
  const report = evaluateCalibration({ datasetProvenance: "synthetic", judgeFingerprint, cases: [], runs: [] });
  assert.equal(report.repeatCount, null);
  for (const split of Object.values(report.splits)) {
    assert.equal(split.cases, 0);
    for (const metric of [split.humanPairwiseAgreement, split.judgeHumanAgreement, split.judgeHumanConsensusAgreement,
      split.repeatability, split.orderConsistency, split.abstentionRate, split.humanConsensusCoverage, split.judgmentCoverage]) {
      assert.deepEqual(metric, expected(0, 0));
    }
  }
});

test("rejects incomplete schedules, duplicate runs, unknown cases and mixed judges", () => {
  const mutations: Array<[string, (input: EvaluationInput) => void]> = [
    ["missing order", (input) => { input.runs.pop(); }],
    ["one repeat only", (input) => { input.runs = input.runs.filter((run) => run.repeat === 0); }],
    ["unequal repeats", (input) => { input.runs.push(...runsFor("cal-1", [["draw", "draw"]]).map((run) => ({ ...run, repeat: 2 }))); }],
    ["gap in repeats", (input) => { for (const run of input.runs) if (run.repeat === 1) run.repeat = 2; }],
    ["starts at one", (input) => { for (const run of input.runs) run.repeat += 1; }],
    ["duplicate run", (input) => { input.runs.push({ ...input.runs[0]! }); }],
    ["unknown case", (input) => { input.runs[0]!.caseId = "missing-case"; }],
    ["mixed judge", (input) => { input.runs[0]!.judgeFingerprint = `sha256:${"b".repeat(64)}`; }],
    ["unsafe repeat", (input) => { input.runs[0]!.repeat = Number.MAX_SAFE_INTEGER + 1; }],
    ["fractional repeat", (input) => { input.runs[0]!.repeat = 0.5; }],
    ["negative repeat", (input) => { input.runs[0]!.repeat = -1; }],
  ];
  for (const [name, mutate] of mutations) {
    const input = fixture();
    mutate(input);
    assert.throws(() => evaluateCalibration(input), /Invalid evaluation input/, name);
  }
});

test("rejects split leakage, conflicting identity, duplicate case/rater IDs and self-matches", () => {
  const mutations: Array<[string, (input: EvaluationInput) => void]> = [
    ["participant across splits", (input) => { input.cases[1]!.entryA.participantId = input.cases[0]!.entryB.participantId; }],
    ["entry across splits", (input) => { input.cases[1]!.entryA.entryId = input.cases[0]!.entryB.entryId; }],
    ["duplicate case id", (input) => { input.cases[1]!.id = input.cases[0]!.id; }],
    ["duplicate rater", (input) => { input.cases[0]!.labels[1]!.raterId = input.cases[0]!.labels[0]!.raterId; }],
    ["one rater", (input) => { input.cases[0]!.labels.length = 1; }],
    ["same participant", (input) => { input.cases[0]!.entryB.participantId = input.cases[0]!.entryA.participantId; }],
    ["same entry", (input) => { input.cases[0]!.entryB.entryId = input.cases[0]!.entryA.entryId; }],
    ["conflicting entry owner", (input) => {
      input.cases[1]!.split = "calibration";
      input.cases[1]!.entryA.entryId = input.cases[0]!.entryA.entryId;
    }],
  ];
  for (const [name, mutate] of mutations) {
    const input = fixture();
    mutate(input);
    assert.throws(() => evaluateCalibration(input), /Invalid evaluation input/, name);
  }
});

test("rejects malformed objects, unknown keys/outcomes, and missing provenance", () => {
  for (const value of [null, [], 1, "input", {}, { ...fixture(), datasetProvenance: "real" },
    { ...fixture(), judgeFingerprint: "sha256:bad" }, { ...fixture(), judgeFingerprint: `sha256:${"A".repeat(64)}` },
    { ...fixture(), extra: true }, { ...fixture(), cases: null }, { ...fixture(), runs: {} },
    { ...fixture(), cases: [{ ...fixture().cases[0], id: " " }] },
    { ...fixture(), cases: [{ ...fixture().cases[0], split: "test" }] },
    { ...fixture(), cases: [{ ...fixture().cases[0], labels: [{ raterId: "rater-1", outcome: "win" }] }] },
    { ...fixture(), runs: [{ ...fixture().runs[0], outcome: "tie" }] },
    { ...fixture(), runs: [{ ...fixture().runs[0], order: "aa" }] },
    { ...fixture(), runs: [{ ...fixture().runs[0], evidence: "must not enter reports" }] },
    { ...fixture(), cases: [{ ...fixture().cases[0], entryA: { entryId: "entry", participantId: "owner", evidence: "private" } }] },
  ]) assert.throws(() => evaluateCalibration(value), /Invalid evaluation input/);
  const { datasetProvenance: _unused, ...withoutProvenance } = fixture();
  assert.throws(() => evaluateCalibration(withoutProvenance), /Invalid evaluation input/);
  const { judgeFingerprint: _unusedFingerprint, ...withoutFingerprint } = fixture().runs[0]!;
  assert.throws(() => evaluateCalibration({ ...fixture(), runs: [withoutFingerprint] }), /Invalid evaluation input/);
});

test("validates without mutating caller data", () => {
  const input = fixture();
  const before = structuredClone(input);
  evaluateCalibration(input);
  assert.deepEqual(input, before);
});

test("rejects the same unordered matchup hidden behind another case ID", () => {
  for (const swapped of [false, true]) {
    const input = fixture();
    const first = input.cases[0]!;
    const second = input.cases[1]!;
    second.split = "calibration";
    second.entryA = { ...(swapped ? first.entryB : first.entryA) };
    second.entryB = { ...(swapped ? first.entryA : first.entryB) };
    assert.throws(() => evaluateCalibration(input), /duplicate unordered entry pair/);
  }
});

test("allows one entry to face different opponents within its split", () => {
  const input = fixture();
  input.cases[1]!.split = "calibration";
  input.cases[1]!.entryA = { ...input.cases[0]!.entryA };
  const report = evaluateCalibration(input);
  assert.equal(report.splits.calibration.cases, 2);
  assert.deepEqual(report.splits.calibration.humanPairwiseAgreement, expected(2, 4));
});

test("all identifier fields enforce the same bounded ASCII grammar", () => {
  const setters: Array<(input: EvaluationInput, value: string) => void> = [
    (input, value) => { input.cases[0]!.id = value; },
    (input, value) => { input.cases[0]!.entryA.entryId = value; },
    (input, value) => { input.cases[0]!.entryA.participantId = value; },
    (input, value) => { input.cases[0]!.labels[0]!.raterId = value; },
    (input, value) => { input.runs[0]!.caseId = value; },
  ];
  for (const set of setters) {
    for (const identifier of ["", "a".repeat(81), "éclair", "-leading", "white space", "path/slash", "a\n", "a\r", "a\u2028", "a\0"]) {
      const input = fixture();
      set(input, identifier);
      assert.throws(() => evaluateCalibration(input), /bounded ASCII identifier/);
    }
  }
  const input = fixture();
  const accepted = `A0._:-${"x".repeat(74)}`;
  input.cases[0]!.id = accepted;
  for (const run of input.runs) if (run.caseId === "cal-1") run.caseId = accepted;
  input.cases[0]!.entryA.entryId = accepted;
  input.cases[0]!.entryA.participantId = accepted;
  input.cases[0]!.labels[0]!.raterId = accepted;
  assert.equal(evaluateCalibration(input).splits.calibration.caseIds[0], accepted);
  assert.throws(() => evaluateCalibration({ ...fixture(), judgeFingerprint: `${judgeFingerprint}\n` }), /lowercase sha256 digest/);
});

test("bounds dataset sizes before traversing oversized arrays", () => {
  assert.throws(() => evaluateCalibration({ ...fixture(), cases: new Array(10_001) }), /array exceeds the allowed size/);
  assert.throws(() => evaluateCalibration({ ...fixture(), runs: new Array(200_001) }), /array exceeds the allowed size/);
  const tooManyLabels = fixture();
  tooManyLabels.cases[0]!.labels = Array.from({ length: 21 }, (_, index) => ({ raterId: `rater-${index}`, outcome: "draw" }));
  assert.throws(() => evaluateCalibration(tooManyLabels), /array exceeds the allowed size/);
  const tooManyRepeats = fixture();
  tooManyRepeats.runs[0]!.repeat = 100;
  assert.throws(() => evaluateCalibration(tooManyRepeats), /repeat index from zero through 99/);
});

test("supports twenty raters and one hundred repeats with exact all-pairs counts", () => {
  const outcomes: Outcome[] = ["a_wins", "b_wins", "draw", "unrated"];
  const labels = Array.from({ length: 20 }, (_, index) => outcomes[index % 4]!);
  const pairs = Array.from({ length: 100 }, (_, index): [Outcome, Outcome] => {
    const winner = outcomes[index % 4]!;
    const swapped = winner === "a_wins" ? "b_wins" : winner === "b_wins" ? "a_wins" : winner;
    return [winner, swapped];
  });
  const input: EvaluationInput = {
    datasetProvenance: "synthetic", judgeFingerprint,
    cases: [exampleCase("maximum-labels-and-repeats", "calibration", labels)],
    runs: runsFor("maximum-labels-and-repeats", pairs),
  };
  const report = evaluateCalibration(input);
  assert.equal(report.repeatCount, 100);
  assert.deepEqual(report.splits.calibration.humanPairwiseAgreement, expected(40, 190));
  assert.deepEqual(report.splits.calibration.repeatability, expected(1_200, 4_950));
  assert.deepEqual(report.splits.calibration.judgeHumanAgreement, expected(500, 2_000));
  assert.deepEqual(report.splits.calibration.abstentionRate, expected(25, 100));
});

test("rejects sparse, decorated and non-plain arrays and nonenumerable properties", () => {
  const malformed: Array<(input: EvaluationInput) => unknown> = [
    (input) => { delete input.cases[0]; return input; },
    (input) => { delete input.cases[0]!.labels[0]; return input; },
    (input) => { delete input.runs[0]; return input; },
    (input) => { Object.assign(input.cases, { extra: true }); return input; },
    (input) => { Object.assign(input.cases[0]!.labels, { extra: true }); return input; },
    (input) => { Object.defineProperty(input.runs, Symbol("decoration"), { value: true }); return input; },
    (input) => { Object.setPrototypeOf(input.cases, null); return input; },
    (input) => { Object.setPrototypeOf(input.runs, {}); return input; },
    (input) => { Object.defineProperty(input, "cases", { enumerable: false }); return input; },
    (input) => { Object.defineProperty(input.cases, "0", { enumerable: false }); return input; },
    (input) => { Object.defineProperty(input.cases[0], "labels", { enumerable: false }); return input; },
    (input) => { Object.defineProperty(input.cases[0]!.entryA, "entryId", { enumerable: false }); return input; },
    (input) => { Object.defineProperty(input.cases[0]!.labels[0], "outcome", { enumerable: false }); return input; },
    (input) => { Object.defineProperty(input.runs[0], "outcome", { enumerable: false }); return input; },
    (input) => { Object.defineProperty(input, Symbol("decoration"), { value: true }); return input; },
  ];
  for (const mutate of malformed) assert.throws(() => evaluateCalibration(mutate(fixture())), /Invalid evaluation input/);
});

test("rejects accessor records and arrays without invoking submitted getters", () => {
  let getterCalls = 0;
  const accessor = { enumerable: true, configurable: true, get: () => { getterCalls += 1; throw new Error("getter invoked"); } };
  const mutations: Array<(input: EvaluationInput) => void> = [
    (input) => { Object.defineProperty(input, "cases", accessor); },
    (input) => { Object.defineProperty(input.cases[0], "labels", accessor); },
    (input) => { Object.defineProperty(input.cases[0]!.entryA, "entryId", accessor); },
    (input) => { Object.defineProperty(input.cases[0]!.labels[0], "outcome", accessor); },
    (input) => { Object.defineProperty(input.runs[0], "outcome", accessor); },
    (input) => { Object.defineProperty(input.cases, "0", accessor); },
    (input) => { Object.defineProperty(input.cases[0]!.labels, "0", accessor); },
    (input) => { Object.defineProperty(input.runs, "0", accessor); },
    (input) => { Object.defineProperty(input.cases, Symbol.iterator, accessor); },
  ];
  for (const mutate of mutations) {
    const input = fixture();
    mutate(input);
    assert.throws(() => evaluateCalibration(input), /Invalid evaluation input/);
  }
  assert.equal(getterCalls, 0);
});

test("rejects proxy records and arrays without invoking traps, including revoked proxies", () => {
  let trapCalls = 0;
  const trap = (): never => { trapCalls += 1; throw new Error("proxy trap invoked"); };
  const proxied = <T extends object>(value: T): T => new Proxy(value, { get: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap, ownKeys: trap });
  const mutations: Array<(input: EvaluationInput) => unknown> = [
    (input) => proxied(input),
    (input) => { input.cases = proxied(input.cases); return input; },
    (input) => { input.cases[0] = proxied(input.cases[0]!); return input; },
    (input) => { input.cases[0]!.entryA = proxied(input.cases[0]!.entryA); return input; },
    (input) => { input.cases[0]!.labels = proxied(input.cases[0]!.labels); return input; },
    (input) => { input.cases[0]!.labels[0] = proxied(input.cases[0]!.labels[0]!); return input; },
    (input) => { input.runs = proxied(input.runs); return input; },
    (input) => { input.runs[0] = proxied(input.runs[0]!); return input; },
    (input) => { const revocable = Proxy.revocable(input, {}); revocable.revoke(); return revocable.proxy; },
    (input) => { const revocable = Proxy.revocable(input.cases, {}); revocable.revoke(); input.cases = revocable.proxy; return input; },
  ];
  for (const mutate of mutations) assert.throws(() => evaluateCalibration(mutate(fixture())), /Invalid evaluation input/);
  assert.equal(trapCalls, 0);
});
