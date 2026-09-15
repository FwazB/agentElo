import assert from "node:assert/strict";
import test from "node:test";
import { parseRefereeJson } from "../json.ts";

test("parses Unicode and standard JSON values without altering text", () => {
  const source = { text: '日本語, café, 🌱, "quotes", \\ and\nnewlines', a: [true, false, null, 0.5, -2, 1e3] };
  assert.equal(JSON.stringify(parseRefereeJson(JSON.stringify(source))), JSON.stringify(source));
});

test("rejects conflicting consent, verdicts and escaped duplicate keys", () => {
  for (const source of [
    '{"refereeConsent":{"approved":false,"approved":true}}',
    '{"outcome":"unrated","outcome":"a_wins"}',
    '{"outcome":"unrated","\\u006futcome":"a_wins"}',
    '[{"x":1,"x":2}]',
  ]) assert.throws(() => parseRefereeJson(source), /duplicate/);
});

test("rejects invalid JSON, nonfinite numbers, trailing data and excessive nesting", () => {
  for (const source of ['', '{"x":1,}', '[1,]', '01', 'true false', '"bad\nstring"', '"\\q"', '{x:1}', '1e999', '1.', '.1', 'undefined']) assert.throws(() => parseRefereeJson(source));
  assert.throws(() => parseRefereeJson("[".repeat(66) + "0" + "]".repeat(66)), /nesting/);
});

test("prototype-looking keys are data and cannot pollute object prototypes", () => {
  const result = parseRefereeJson('{"__proto__":{"polluted":true},"constructor":1}') as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(result), null);
  assert.equal(Object.hasOwn(result, "__proto__"), true);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});
