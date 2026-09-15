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

test("link, full reference and prompt share an evidence-first no-publication contract", () => {
  const guide = getScoringGuide(new Date("2026-09-14T12:00:00Z"));
  assert.equal(guide.weekId, "2026-W37");
  assert.equal(guide.prompt, buildAssessmentPrompt(guide.weekId));
  assert.ok(renderScoringGuide(new Date("2026-09-14T12:00:00Z")).includes(guide.prompt));
  assert.match(buildQuickPrompt(guide.weekId), /https:\/\/computer-elo\.vercel\.app\/rate\.md/);
  assert.match(guide.prompt, /Zero coverage or zero certainty means no score/);
  assert.match(guide.prompt, /not a zero or an average/);
  assert.match(guide.prompt, /Do not upload or publish anything/);
});

test("assessment instructions gather context before emitting final result JSON", () => {
  const prompt = buildAssessmentPrompt("2026-W37");
  assert.match(prompt, /full rubric is included below/);
  assert.match(prompt, /First review relevant dated evidence I already shared/);
  assert.match(prompt, /A single concrete, dated recap or conversation can be enough/);
  assert.match(prompt, /Give me 3–6 bullets about 2026-W37/);
  for (const text of [prompt, buildQuickPrompt("2026-W37")]) {
    assert.match(text, /wait for my reply and continue/);
    assert.match(text, /Do not return result JSON while gathering evidence/);
    assert.doesNotMatch(text, /ask me for the missing evidence and return insufficient_evidence/);
  }
  assert.match(prompt, /Only if I ask to finish without enough evidence, decline the follow-up, or cannot supply the remaining context after a follow-up/);
  assert.match(prompt, /Do not drop unsupported dimensions or reweight the rubric/);
});

test("every bounded missing category produces a targeted, self-contained continuation", () => {
  for (const code of Object.keys(MISSING_EVIDENCE)) {
    const result = parseAssessmentResult({ status: "insufficient_evidence", weekId: "2026-W37", missing: [code] }, "2026-W37");
    assert.ok("status" in result);
    const prompt = buildEvidenceFollowUpPrompt(result);
    const [followUp] = prompt.split("Use this complete rubric:");
    assert.match(followUp!, /Continue my Computer Elo assessment for 2026-W37/);
    assert.ok(followUp!.includes(MISSING_EVIDENCE[code as keyof typeof MISSING_EVIDENCE]));
    for (const [otherCode, label] of Object.entries(MISSING_EVIDENCE)) if (otherCode !== code) assert.ok(!followUp!.includes(label));
    assert.match(followUp!, /wait for my reply and continue/);
    assert.match(followUp!, /Do not just repeat the insufficient_evidence JSON/);
    assert.ok(prompt.endsWith(buildAssessmentPrompt("2026-W37")));
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
