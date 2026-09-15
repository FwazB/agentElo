import test from "node:test";
import assert from "node:assert/strict";
import { buildAssessmentPrompt, buildEvidenceFollowUpPrompt, buildQuickPrompt, getScoringGuide, MISSING_EVIDENCE, parseAssessmentResult, renderScoringGuide } from "../../../packages/public-api/scoring-guide.ts";
import { completedWeekWindow } from "../../../packages/public-api/week.ts";

test("reference uses the completed UTC week across year and Monday boundaries", () => {
  assert.deepEqual(completedWeekWindow(new Date("2026-09-14T00:00:00Z")), { weekId: "2026-W37", start: "2026-09-07T00:00:00.000Z", end: "2026-09-14T00:00:00.000Z" });
  assert.equal(completedWeekWindow(new Date("2026-09-13T23:59:59Z")).weekId, "2026-W36");
  assert.equal(completedWeekWindow(new Date("2021-01-04T00:00:00Z")).weekId, "2020-W53");
  assert.throws(() => completedWeekWindow(new Date("invalid")));
});

test("link, full reference and prompt share a private direct-estimate contract", () => {
  const guide = getScoringGuide(new Date("2026-09-14T12:00:00Z"));
  assert.equal(guide.weekId, "2026-W37");
  assert.equal(guide.version, "computer-elo.assessment-guide.v4");
  assert.equal(guide.prompt, buildAssessmentPrompt(guide.weekId));
  assert.ok(renderScoringGuide(new Date("2026-09-14T12:00:00Z")).includes(guide.prompt));
  assert.match(buildQuickPrompt(guide.weekId), /https:\/\/computer-elo\.vercel\.app\/rate\.md/);
  for (const prompt of [guide.prompt, buildQuickPrompt(guide.weekId)]) {
    assert.match(prompt, /do not ask follow-up questions/i);
    assert.doesNotMatch(prompt, /wait for my reply|ask up to three|Give me 3–6 bullets/);
  }
  assert.match(guide.prompt, /Zero coverage or zero certainty means no score/);
  assert.match(guide.prompt, /Meaningful partial context about this week is enough/);
  assert.match(guide.prompt, /Substantial inference must keep confidence below 500000/);
  assert.match(guide.prompt, /older activity is not observed coverage of this week/);
  assert.match(guide.prompt, /Do not upload or publish anything/);
  assert.ok(guide.prompt.length < 4500, "Keep the primary prompt compact enough to copy");
});

test("prompt emits public categories without requesting underlying personal data", () => {
  const prompt = buildAssessmentPrompt("2026-W37");
  assert.match(prompt, /Return only one JSON code block/);
  assert.match(prompt, /Use unknown when unsure/);
  assert.match(prompt, /self-reported, not verified/);
  assert.match(prompt, /omit both labels/);
  assert.match(prompt, /do not request new access or private exports/i);
  assert.match(prompt, /Never include names, personal\/profile details, raw history/);
  assert.match(prompt, /"aiSystem"/);
  assert.match(prompt, /"contextSource"/);
});

test("legacy insufficient-evidence continuations now use the same direct prompt", () => {
  for (const code of Object.keys(MISSING_EVIDENCE)) {
    const result = parseAssessmentResult({ status: "insufficient_evidence", weekId: "2026-W37", missing: [code] }, "2026-W37");
    assert.ok("status" in result);
    assert.equal(buildEvidenceFollowUpPrompt(result), buildAssessmentPrompt("2026-W37"));
  }
});

test("insufficient evidence is a bounded local outcome with no score or free text", () => {
  const value = { status: "insufficient_evidence", weekId: "2026-W37", missing: ["focus", "verification"] };
  assert.deepEqual(parseAssessmentResult(value, "2026-W37"), value);
  for (const invalid of [
    { ...value, formScore: 500 }, { ...value, notes: "private activity" }, { ...value, missing: [] },
    { ...value, missing: ["focus", "focus"] }, { ...value, missing: ["__proto__"] },
    { ...value, missing: ["private note"] }, { ...value, weekId: "2026-W36" },
    Object.create(value), { ...value, status: "scored" },
  ]) assert.throws(() => parseAssessmentResult(invalid, "2026-W37"));
});

test("zero axes cannot produce a score; grounded 43% is preserved without uplift", () => {
  const score = { weekId: "2026-W37", formScore: 849, coveragePpm: 430000, certaintyPpm: 800000 };
  assert.deepEqual(parseAssessmentResult(score, "2026-W37"), score);
  for (const invalid of [
    { ...score, coveragePpm: 0 }, { ...score, certaintyPpm: 0 }, { ...score, notes: "private" },
    { ...score, coveragePpm: 1000001 }, { ...score, certaintyPpm: 1.5 }, { ...score, formScore: 0 },
    { ...score, formScore: 1001 }, { ...score, formScore: "849" }, Object.create(score),
  ]) assert.throws(() => parseAssessmentResult(invalid, "2026-W37"));
});

test("approved context categories round-trip, legacy scores remain valid, and private fields are rejected", () => {
  const legacy = { weekId: "2026-W37", formScore: 711, coveragePpm: 320000, certaintyPpm: 430000 };
  const score = { ...legacy, aiSystem: "claude", contextSource: "saved_memory" };
  assert.deepEqual(parseAssessmentResult(legacy, "2026-W37"), legacy);
  assert.deepEqual(parseAssessmentResult(score, "2026-W37"), score);
  assert.deepEqual(parseAssessmentResult({ ...score, aiSystem: "unknown", contextSource: "unknown" }, "2026-W37"), { ...score, aiSystem: "unknown", contextSource: "unknown" });
  for (const invalid of [
    { ...legacy, aiSystem: "claude" }, { ...legacy, contextSource: "past_chats" },
    { ...score, aiSystem: "model-account-private-canary" }, { ...score, contextSource: "private-chat-canary" },
    { ...score, aiSystem: "__proto__" }, { ...score, contextSource: "constructor" },
    { ...score, aiSystem: null }, { ...score, contextSource: {} },
    { ...score, userName: "PRIVATE_CANARY" }, { ...score, history: ["PRIVATE_CANARY"] },
    { status: "insufficient_evidence", weekId: "2026-W37", missing: ["focus"], aiSystem: "claude", contextSource: "current_chat" },
  ]) {
    assert.throws(() => parseAssessmentResult(invalid, "2026-W37"), error => {
      assert.doesNotMatch(String(error), /CANARY|private-canary/i);
      return true;
    });
  }
});
