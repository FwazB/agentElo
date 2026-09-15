import assert from "node:assert/strict";
import test from "node:test";
import { Decimal as SharedDecimal } from "decimal.js";
import { calculateElo, MathInputError, roundMillipoints, type EloInput } from "../src/mathcore.ts";
import { attachFingerprint, canonicalJson, fingerprintPayload, parseJsonText } from "../src/canonical.ts";
import { buildMatchReceipt, buildPlayerReceipt, validateReceipt } from "../src/receipts.ts";
import { playerCardSvg } from "../src/cards.ts";

function seeded(seed: number) {
  let state = seed >>> 0;
  return (limit: number) => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) % limit; };
}
const base: EloInput = { mode: "scalar", rating_milli_a: 1200000, rating_milli_b: 1300000, form_a: 849, form_b: 775, confidence_ppm_a: 800000, confidence_ppm_b: 900000, rated_matches_a: 0, rated_matches_b: 8 };
const probabilityUnits = (value: string) => BigInt(value.replace(".", ""));

test("seeded Elo swaps conserve integer totals, reverse deltas, and keep probabilities bounded", () => {
  const next = seeded(0x5eedc0de);
  for (let sample = 0; sample < 256; sample++) for (const mode of ["scalar", "binary"] as const) {
    const input: EloInput = { mode, rating_milli_a: next(10000001) - 5000000, rating_milli_b: next(10000001) - 5000000,
      form_a: next(1000) + 1, form_b: next(1000) + 1, confidence_ppm_a: next(1000001), confidence_ppm_b: next(1000001), rated_matches_a: next(12), rated_matches_b: next(12) };
    const a = calculateElo(input);
    const b = calculateElo({ ...input, rating_milli_a: input.rating_milli_b, rating_milli_b: input.rating_milli_a,
      form_a: input.form_b, form_b: input.form_a, confidence_ppm_a: input.confidence_ppm_b, confidence_ppm_b: input.confidence_ppm_a,
      rated_matches_a: input.rated_matches_b, rated_matches_b: input.rated_matches_a });
    assert.equal(a.candidate_delta_milli_a + a.candidate_delta_milli_b, 0);
    assert.equal(a.candidate_delta_milli_a, -b.candidate_delta_milli_a || 0);
    assert.equal(BigInt(a.candidate_rating_after_milli_a) + BigInt(a.candidate_rating_after_milli_b), BigInt(input.rating_milli_a) + BigInt(input.rating_milli_b));
    assert.ok(Number.isSafeInteger(a.candidate_delta_milli_a));
    assert.ok(Math.abs(a.candidate_delta_milli_a) <= a.k * 1000);
    assert.equal(a.k, input.rated_matches_a < 5 || input.rated_matches_b < 5 ? 64 : 32);
    for (const field of ["actual_score_a", "expected_score_a"] as const) {
      assert.match(a[field], /^(?:0|1)\.\d{15}$/);
      assert.ok(probabilityUnits(a[field]) >= 0n && probabilityUnits(a[field]) <= 1000000000000000n);
      assert.equal(probabilityUnits(a[field]) + probabilityUnits(b[field]), 1000000000000000n);
    }
    assert.deepEqual(calculateElo(input), a, `deterministic replay ${sample}/${mode}`);
  }
});

test("ties-to-even rounding agrees with an independent signed BigInt oracle", () => {
  const next = seeded(0x1234abcd);
  for (let sample = 0; sample < 256; sample++) {
    const integer = BigInt(next(64000));
    const remainder = BigInt(sample % 2 === 0 ? 500 : next(1000));
    const micro = integer * 1000n + remainder;
    const rounded = integer + (remainder > 500n || remainder === 500n && integer % 2n === 1n ? 1n : 0n);
    const raw = `${micro / 1000000n}.${String(micro % 1000000n).padStart(6, "0")}`;
    assert.equal(roundMillipoints(raw), Number(rounded));
    assert.equal(roundMillipoints(`-${raw}`), -Number(rounded) || 0);
  }
  assert.equal(roundMillipoints("9007199254740.991"), Number.MAX_SAFE_INTEGER);
  assert.equal(roundMillipoints("1e-1000"), 0);
  for (const invalid of ["1e100", "-1e100", "9007199254740.9915", "NaN", "Infinity", "not a number"]) assert.throws(() => roundMillipoints(invalid), MathInputError);
});

test("the numeric profile is isolated and unsafe output never escapes the engine", () => {
  const before = calculateElo(base);
  const previous = { precision: SharedDecimal.precision, rounding: SharedDecimal.rounding };
  try {
    SharedDecimal.set({ precision: 4, rounding: SharedDecimal.ROUND_DOWN });
    assert.deepEqual(calculateElo(base), before);
    assert.equal(SharedDecimal.precision, 4, "The engine must not change another consumer's settings");
  } finally { SharedDecimal.set(previous); }
  for (const rating of [Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => calculateElo({ ...base, mode: "binary", rating_milli_a: rating, rating_milli_b: rating,
      form_a: rating > 0 ? 1000 : 1, form_b: rating > 0 ? 1 : 1000 }), MathInputError);
  }
  const extreme = calculateElo({ ...base, mode: "binary", rating_milli_a: Number.MAX_SAFE_INTEGER, rating_milli_b: -Number.MAX_SAFE_INTEGER, form_a: 1, form_b: 1000 });
  assert.equal(extreme.expected_score_a, "1.000000000000000");
  assert.ok(Number.isSafeInteger(extreme.candidate_rating_after_milli_a));
  assert.equal(BigInt(extreme.candidate_rating_after_milli_a) + BigInt(extreme.candidate_rating_after_milli_b), 0n);
  for (const field of ["rating_milli_a", "rating_milli_b", "form_a", "form_b", "confidence_ppm_a", "confidence_ppm_b", "rated_matches_a", "rated_matches_b"]) {
    for (const invalid of [NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", undefined]) assert.throws(() => calculateElo({ ...base, [field]: invalid } as EloInput), MathInputError);
  }
});

test("canonical ingress rejects non-JSON whitespace, negative zero, sparse arrays and decoded duplicate keys", () => {
  for (const whitespace of ["\u00a0", "\ufeff", "\u2003", "\v", "\f"]) {
    for (const source of [`${whitespace}{}`, `{${whitespace}"a":1}`, `{"a":1${whitespace}}`, `{}${whitespace}`]) assert.throws(() => parseJsonText(source));
  }
  assert.deepEqual(parseJsonText(' \t\r\n { "a" : 1 } \n'), { a: 1 });
  for (const value of [-0, { nested: -0 }, new Array(2), [1, , 3]]) assert.throws(() => canonicalJson(value));
  for (const source of ['{"a":1,"\\u0061":2}', '{"nested":{"score":1,"score":2}}', '{"__proto__":{},"\\u005f_proto__":{}}']) assert.throws(() => parseJsonText(source));
  assert.equal(canonicalJson([0, null, false]), "[0,null,false]");
});

test("seeded canonical roundtrips preserve fingerprints across key order and ordinary formatting", () => {
  const next = seeded(0xa55a1234);
  for (let sample = 0; sample < 128; sample++) {
    const entries: [string, unknown][] = Array.from({ length: 8 }, (_, index) => [`key_${index}`, [next(2000001) - 1000000, `quote\" slash\\ ${next(999)}`, { flag: next(2) === 0, nothing: null }]]);
    const first = Object.fromEntries(entries);
    const second = Object.fromEntries([...entries].reverse());
    assert.equal(canonicalJson(first), canonicalJson(second));
    assert.equal(fingerprintPayload(first), fingerprintPayload(second));
    assert.equal(canonicalJson(parseJsonText(JSON.stringify(second, null, 2))), canonicalJson(first));
  }
});

test("seeded receipt replay preserves inputs, independent streams, exhibitions and public allowlists", () => {
  const next = seeded(0xface1234);
  const axes = [0, 1, 430000, 499999, 500000, 800000, 1000000];
  for (let sample = 0; sample < 32; sample++) {
    const create = (id: string) => buildPlayerReceipt({ player_id: `p_${id.repeat(32)}`, competition_id: `c_${"a".repeat(32)}`, week_id: "2026-W37",
      form_score: 1 + next(1000), coverage_ppm: axes[next(axes.length)]!, certainty_ppm: axes[next(axes.length)]! });
    const a = create("1"), b = create("2");
    const before = canonicalJson([a, b]);
    for (const mode of ["binary", "scalar"] as const) {
      const input = { receipt_a: a, receipt_b: b, mode, match_id: `m_${sample.toString(16).padStart(32, "0")}` };
      const [match, afterA, afterB] = buildMatchReceipt(input);
      assert.deepEqual(buildMatchReceipt(input), [match, afterA, afterB]);
      assert.equal(canonicalJson([a, b]), before);
      assert.deepEqual(validateReceipt(match), match);
      assert.equal(match.players.a.applied_delta_milli + match.players.b.applied_delta_milli, 0);
      const rated = Math.min(a.form.confidence.effective_ppm, b.form.confidence.effective_ppm) >= 500000;
      assert.equal(match.rating_effect, rated ? "rated" : "exhibition");
      if (rated) {
        assert.ok(afterA && afterB);
        assert.equal(afterA.elo[mode].rated_matches, 1);
        assert.equal(afterB.elo[mode].rated_matches, 1);
        assert.equal(afterA.parent_fingerprint, a.fingerprint);
        assert.equal(afterA.elo[mode].rating_milli + afterB.elo[mode].rating_milli, 2400000);
        const other = mode === "binary" ? "scalar" : "binary";
        assert.deepEqual(afterA.elo[other], a.elo[other]);
      } else { assert.equal(afterA, null); assert.equal(afterB, null); }
    }
  }
  const clean = buildPlayerReceipt({ player_id: `p_${"1".repeat(32)}`, competition_id: `c_${"a".repeat(32)}`, week_id: "2026-W37", form_score: 849, coverage_ppm: 430000, certainty_ppm: 800000 });
  for (const path of [[], ["form"], ["form", "confidence"], ["privacy"], ["elo"], ["elo", "binary"], ["elo", "scalar"]]) for (const key of ["private_note", "__proto__", "constructor"]) {
    const changed = structuredClone(clean) as unknown as Record<string, any>;
    let target = changed;
    for (const segment of path) target = target[segment];
    Object.defineProperty(target, key, { enumerable: true, value: "PRIVATE_CANARY" });
    assert.throws(() => validateReceipt(attachFingerprint(changed)));
  }
  assert.ok(!playerCardSvg(clean).includes("PRIVATE_CANARY"));
});
