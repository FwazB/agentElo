import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { canonicalJson, fingerprintPayload, parseJsonText } from "../src/canonical.ts";

interface VectorFile {
  canonical_vectors: Array<{ id: string; input: unknown; canonical_json: string; fingerprint: string }>;
  canonical_rejection_vectors: Array<{ id: string; input: unknown }>;
  canonical_source_rejection_vectors: Array<{ id: string; source: string }>;
  rounding_vectors: Array<{ id: string; raw_delta: string; expected_millipoints: number }>;
}

const fixtureUrl = new URL("../../../fixtures/test-vectors.v1.json", import.meta.url);
const vectors = JSON.parse(await readFile(fixtureUrl, "utf8")) as VectorFile;

for (const vector of vectors.canonical_vectors) {
  test(`canonical vector: ${vector.id}`, () => {
    assert.equal(canonicalJson(vector.input), vector.canonical_json);
    assert.equal(fingerprintPayload(vector.input as object), vector.fingerprint);
  });
}

for (const vector of vectors.canonical_rejection_vectors) {
  test(`canonical rejection: ${vector.id}`, () => {
    assert.throws(() => canonicalJson(vector.input));
  });
}

for (const vector of vectors.canonical_source_rejection_vectors) {
  test(`canonical source rejection: ${vector.id}`, () => {
    assert.throws(() => parseJsonText(vector.source));
  });
}

test("JSON prototype keys remain ordinary own properties at every depth", () => {
  const source = '{"__proto__":{"private":"root"},"nested":{"__proto__":{"private":"nested"}}}';
  const parsed = parseJsonText(source) as Record<string, unknown>;
  const nested = parsed.nested as Record<string, unknown>;

  for (const value of [parsed, nested]) {
    assert.equal(Object.getPrototypeOf(value), Object.prototype);
    assert.equal(Object.hasOwn(value, "__proto__"), true);
    assert.equal(Object.hasOwn(value, "private"), false);
    assert.equal(value.private, undefined);
  }
  assert.deepEqual(parsed, JSON.parse(source));
  assert.equal(canonicalJson(parsed), source);
  assert.throws(() => parseJsonText('{"__proto__":{},"__proto__":{}}'));
});
