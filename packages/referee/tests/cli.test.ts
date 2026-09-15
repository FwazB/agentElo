import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { readInput, runCommand } from "../cli.ts";
import { judgeFingerprint, parseJudgeConfig, type JudgePacket } from "../judge.ts";
import type { CalibrationReport } from "../evaluation.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const fixture = (name: string) => join(root, "fixtures/referee", name);
const pairArgs = ["--entry-a", fixture("entry-a.synthetic.json"), "--entry-b", fixture("entry-b.synthetic.json"), "--config", fixture("judge.synthetic.json")];

test("CLI prepares both packets, accepts bound response files, and leaves Elo disabled", () => {
  const dir = mkdtempSync(join(tmpdir(), "antislop-cli-"));
  try {
    const packetAB = runCommand(["packet", ...pairArgs, "--order", "ab"]) as JudgePacket;
    const packetBA = runCommand(["packet", ...pairArgs, "--order", "ba"]) as JudgePacket;
    assert.equal(packetAB.pairFingerprint, packetBA.pairFingerprint);
    for (const packet of [packetAB, packetBA]) {
      const response = {
        version: "antislop.judge-response.v1", judgeFingerprint: packet.judgeFingerprint,
        pairFingerprint: packet.pairFingerprint, order: packet.order,
        verdict: { outcome: packet.order === "ab" ? "a_wins" : "b_wins", reason: "stronger_work", explanation: "Synthetic fixture verdict only.", evidenceRefs: { a: ["e1"], b: ["e1"] } },
      };
      writeFileSync(join(dir, `${packet.order}.json`), JSON.stringify(response), { mode: 0o600 });
    }
    const result = runCommand(["adjudicate", ...pairArgs, "--response-ab", join(dir, "ab.json"), "--response-ba", join(dir, "ba.json")]) as { outcome: string; ratingEligible: boolean; proposedResultForA: number };
    assert.equal(result.outcome, "a_wins");
    assert.equal(result.proposedResultForA, 1);
    assert.equal(result.ratingEligible, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("synthetic metrics exercise disagreement without claiming human calibration", () => {
  const result = runCommand(["evaluate", "--input", fixture("evaluation.synthetic.json")]) as CalibrationReport;
  const config = parseJudgeConfig(JSON.parse(readFileSync(fixture("judge.synthetic.json"), "utf8")));
  assert.equal(result.judgeFingerprint, judgeFingerprint(config));
  assert.equal(result.datasetProvenance, "synthetic");
  assert.equal(result.status, "pilot_only");
  assert.equal(result.splits.holdout.abstentionRate.value, 0.5);
  assert.equal(result.splits.holdout.orderConsistency.value, 0.5);
});

test("actual CLI exits with a safe error on duplicate consent fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "antislop-cli-"));
  try {
    const path = join(dir, "ambiguous.json");
    const original = readFileSync(fixture("entry-a.synthetic.json"), "utf8");
    writeFileSync(path, original.replace('"approved": true', '"approved": false, "approved": true').replace('Synthetic example:', 'PRIVATE-CANARY-SHOULD-NOT-PRINT:'));
    const result = spawnSync(process.execPath, ["--import", "tsx", "packages/referee/cli.ts", "packet", "--entry-a", path, ...pairArgs.slice(2), "--order", "ab"], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /duplicate/);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.includes("PRIVATE-CANARY"), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI rejects oversized inputs, invalid UTF-8, and conflicting or missing flags", () => {
  const dir = mkdtempSync(join(tmpdir(), "antislop-cli-"));
  try {
    const path = join(dir, "input.json");
    writeFileSync(path, " ".repeat(65));
    assert.throws(() => readInput(path, 64), /bounded/);
    writeFileSync(path, Buffer.from([0xff, 0xfe]));
    assert.throws(() => readInput(path, 64), /UTF-8/);
    assert.throws(() => runCommand(["config", "--config", "a", "--config", "b"]), /exactly once/);
    assert.throws(() => runCommand(["packet", ...pairArgs]), /exactly once/);
    assert.throws(() => runCommand(["packet", ...pairArgs, "--order", "wrong"]), /Order/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
