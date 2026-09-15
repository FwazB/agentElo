import assert from "node:assert/strict";
import test from "node:test";

import { run } from "../src/cli.ts";

test("simulate command preserves deterministic typed engine output", () => {
  const result = run([
    "simulate",
    "--mode", "scalar",
    "--rating-milli-a", "1240000",
    "--rating-milli-b", "1160000",
    "--form-a", "700",
    "--form-b", "500",
    "--confidence-ppm-a", "800000",
    "--confidence-ppm-b", "600000",
    "--rated-matches-a", "5",
    "--rated-matches-b", "8",
  ]) as {
    calculation: { candidate_delta_milli_a: number; raw_delta_a: string };
    rating_effect: string;
    ratings_after_milli: { a: number; b: number };
  };
  assert.equal(result.rating_effect, "rated");
  assert.equal(result.calculation.candidate_delta_milli_a, 5139);
  assert.equal(result.calculation.raw_delta_a, "5.139076950235");
  assert.deepEqual(result.ratings_after_milli, { a: 1_245_139, b: 1_154_861 });
});

test("validate command accepts checked-in receipts", () => {
  const receiptPath = new URL("../../../fixtures/e2e/placement-a/player.receipt.json", import.meta.url);
  const result = run(["validate", receiptPath.pathname]) as {
    receipt_type: string;
    valid: boolean;
  };
  assert.deepEqual(result, {
    fingerprint: "sha256:13f26536d1e799c46e17e68d889ee6f0ae0f89df9ce00cfa6cb2057500dac70e",
    receipt_type: "player",
    schema_version: "1.0.0",
    valid: true,
  });
});
