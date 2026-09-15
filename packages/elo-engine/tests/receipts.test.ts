import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { matchCardSvg, playerCardSvg } from "../src/cards.ts";
import { fingerprintPayload, parseJsonText } from "../src/canonical.ts";
import {
  buildLeaderboardReceipt,
  buildMatchReceipt,
  buildPlayerReceipt,
  ReceiptValidationError,
  validateReceipt,
  type PlayerReceipt,
} from "../src/receipts.ts";

const fixtureRoot = new URL("../../../fixtures/e2e/", import.meta.url);

async function jsonFixture(relative: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(relative, fixtureRoot), "utf8"));
}

async function textFixture(relative: string): Promise<string> {
  return readFile(new URL(relative, fixtureRoot), "utf8");
}

function player(playerId: string, score: number, options: {
  week?: string;
  coverage?: number;
  certainty?: number;
  competition?: string;
} = {}): PlayerReceipt {
  return buildPlayerReceipt({
    player_id: playerId,
    competition_id: options.competition ?? `c_${"a".repeat(32)}`,
    week_id: options.week ?? "2026-W35",
    form_score: score,
    coverage_ppm: options.coverage ?? 900_000,
    certainty_ppm: options.certainty ?? 900_000,
  });
}

test("checked-in receipts and SVG cards replay byte-for-byte", async () => {
  const a = player(`p_${"1".repeat(32)}`, 700, { certainty: 800_000 });
  const b = player(`p_${"2".repeat(32)}`, 500, { coverage: 750_000, certainty: 600_000 });
  const low = player(`p_${"5".repeat(32)}`, 620, { coverage: 499_999 });

  for (const [name, receipt] of [
    ["placement-a", a],
    ["placement-b", b],
    ["placement-low", low],
  ] as const) {
    assert.deepEqual(receipt, await jsonFixture(`${name}/player.receipt.json`));
    assert.equal(playerCardSvg(receipt), await textFixture(`${name}/player-card.svg`));
  }

  const [scalar, scalarA, scalarB] = buildMatchReceipt({
    receipt_a: a,
    receipt_b: b,
    mode: "scalar",
    match_id: `m_${"3".repeat(32)}`,
  });
  const [binary, binaryA, binaryB] = buildMatchReceipt({
    receipt_a: a,
    receipt_b: b,
    mode: "binary",
    match_id: `m_${"4".repeat(32)}`,
  });
  const [exhibition, exhibitionA, exhibitionB] = buildMatchReceipt({
    receipt_a: a,
    receipt_b: low,
    mode: "scalar",
    match_id: `m_${"6".repeat(32)}`,
  });
  assert.equal(exhibitionA, null);
  assert.equal(exhibitionB, null);

  for (const [name, receipt, updatedA, updatedB] of [
    ["scalar-duel", scalar, scalarA, scalarB],
    ["binary-duel", binary, binaryA, binaryB],
  ] as const) {
    assert.deepEqual(receipt, await jsonFixture(`${name}/match.receipt.json`));
    assert.deepEqual(updatedA, await jsonFixture(`${name}/player-a.updated.receipt.json`));
    assert.deepEqual(updatedB, await jsonFixture(`${name}/player-b.updated.receipt.json`));
    assert.equal(matchCardSvg(receipt), await textFixture(`${name}/match-card.svg`));
  }
  assert.deepEqual(exhibition, await jsonFixture("exhibition/match.receipt.json"));
  assert.equal(matchCardSvg(exhibition), await textFixture("exhibition/match-card.svg"));
  if (scalarA === null || scalarB === null) throw new Error("rated fixture did not produce updated players");
  assert.deepEqual(
    buildLeaderboardReceipt([scalarA, scalarB], "scalar"),
    await jsonFixture("leaderboard/leaderboard.receipt.json"),
  );
});

test("receipt validation rejects impossible weeks, private fields, and tampering", () => {
  assert.throws(
    () => player(`p_${"1".repeat(32)}`, 700, { week: "2025-W53" }),
    ReceiptValidationError,
  );
  const receipt = player(`p_${"1".repeat(32)}`, 700);
  assert.throws(() => validateReceipt({ ...receipt, raw_history: "forbidden" }), ReceiptValidationError);
  const tampered = structuredClone(receipt);
  tampered.form.score = 701;
  assert.throws(() => validateReceipt(tampered), ReceiptValidationError);
});

test("receipt fields must be own properties, including nested confidence fields", () => {
  const receipt = player(`p_${"1".repeat(32)}`, 700);
  assert.throws(() => validateReceipt(Object.create(receipt)), ReceiptValidationError);

  const inheritedConfidence = structuredClone(receipt);
  inheritedConfidence.form.confidence = Object.create(receipt.form.confidence);
  assert.throws(() => validateReceipt(inheritedConfidence), ReceiptValidationError);
});

test("prototype-wrapped JSON cannot impersonate a player receipt", () => {
  const receipt = player(`p_${"1".repeat(32)}`, 700);
  receipt.fingerprint = fingerprintPayload({});
  const wrapped = parseJsonText(`{"__proto__":${JSON.stringify(receipt)}}`);
  assert.throws(() => validateReceipt(wrapped), ReceiptValidationError);
});

test("duel eligibility, stream isolation, and lineage are preserved", () => {
  const a = player(`p_${"1".repeat(32)}`, 700, { certainty: 800_000 });
  const b = player(`p_${"2".repeat(32)}`, 500, { certainty: 600_000 });
  const [match, updatedA, updatedB] = buildMatchReceipt({
    receipt_a: a,
    receipt_b: b,
    mode: "scalar",
    match_id: `m_${"3".repeat(32)}`,
  });
  assert.equal(match.rating_effect, "rated");
  if (updatedA === null || updatedB === null) throw new Error("rated duel did not produce updated players");
  assert.equal(updatedA.elo.binary.rating_milli, 1_200_000);
  assert.equal(updatedB.elo.binary.rated_matches, 0);
  assert.equal(updatedA.elo.scalar.rating_milli + updatedB.elo.scalar.rating_milli, 2_400_000);

  const [low, lowA, lowB] = buildMatchReceipt({
    receipt_a: a,
    receipt_b: player(`p_${"2".repeat(32)}`, 900, { coverage: 499_999 }),
    mode: "scalar",
    match_id: `m_${"5".repeat(32)}`,
  });
  assert.equal(low.rating_effect, "exhibition");
  assert.deepEqual(low.exhibition_reasons, ["low_confidence"]);
  assert.equal(lowA, null);
  assert.equal(lowB, null);

  const refreshed = buildPlayerReceipt({
    player_id: a.player_id,
    competition_id: a.competition_id,
    week_id: "2026-W36",
    form_score: 760,
    coverage_ppm: 900_000,
    certainty_ppm: 850_000,
    prior_receipt: a,
  });
  assert.equal(refreshed.parent_fingerprint, a.fingerprint);
  assert.deepEqual(refreshed.elo, a.elo);
});

test("public receipt and card surfaces contain no private evidence", () => {
  const canaries = [
    "PRIVATE_MESSAGE_CANARY",
    "https://private.invalid/secret",
    "person@example.invalid",
    "/Users/private/project/secret.txt",
    "SecretProjectName",
  ];
  const a = player(`p_${"1".repeat(32)}`, 700, { certainty: 800_000 });
  const b = player(`p_${"2".repeat(32)}`, 500, { certainty: 750_000 });
  const [match] = buildMatchReceipt({
    receipt_a: a,
    receipt_b: b,
    mode: "scalar",
    match_id: `m_${"3".repeat(32)}`,
  });
  const publicText = [JSON.stringify(a), JSON.stringify(match), playerCardSvg(a), matchCardSvg(match)].join("\n");
  for (const canary of canaries) assert.doesNotMatch(publicText, new RegExp(canary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
