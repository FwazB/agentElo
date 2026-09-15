import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { calculateElo, type EloCalculation, type EloInput } from "../src/mathcore.ts";

interface FormulaVector {
  readonly id: string;
  readonly input: EloInput;
  readonly expected: EloCalculation;
}

interface VectorFile {
  readonly formula_vectors: FormulaVector[];
}

const fixtureUrl = new URL("../../../fixtures/test-vectors.v1.json", import.meta.url);
const vectors = JSON.parse(await readFile(fixtureUrl, "utf8")) as VectorFile;

for (const vector of vectors.formula_vectors) {
  test(`formula vector: ${vector.id}`, () => {
    assert.deepEqual(calculateElo(vector.input), vector.expected);
  });
}
