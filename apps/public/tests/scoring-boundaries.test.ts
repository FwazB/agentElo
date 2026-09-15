import assert from "node:assert/strict";
import test from "node:test";
import { lastCompletedWeek as apiWeek } from "../../api/store.ts";
import { completedWeekWindow } from "../../../packages/public-api/week.ts";
import { getScoringGuide, MISSING_EVIDENCE, parseAssessmentResult } from "../../../packages/public-api/scoring-guide.ts";

const DAY = 86400000, WEEK = 7 * DAY, MONDAY_EPOCH = Date.UTC(1970, 0, 5);
function independentWindow(now: number) {
  const start = MONDAY_EPOCH + (Math.floor((now - MONDAY_EPOCH) / WEEK) - 1) * WEEK;
  const thursday = new Date(start + 3 * DAY);
  const year = thursday.getUTCFullYear();
  const dayOfYear = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / DAY) + 1;
  return { weekId: `${year}-W${String(Math.ceil(dayOfYear / 7)).padStart(2, "0")}`, start: new Date(start).toISOString(), end: new Date(start + WEEK).toISOString() };
}

test("completed-week boundaries agree with an independent epoch oracle and API across leap/century years", () => {
  const years = [1900, 1999, 2000, 2004, 2020, 2021, 2026, 2038, 2099, 2100];
  for (const year of years) {
    const end = Date.UTC(year + 1, 0, 1);
    for (let instant = Date.UTC(year, 0, 1); instant < end; instant += DAY) {
      for (const offset of [-1, 0, 12 * 60 * 60 * 1000]) {
        const now = new Date(instant + offset);
        const window = completedWeekWindow(now);
        assert.deepEqual(window, independentWindow(now.getTime()), now.toISOString());
        assert.equal(apiWeek(now), window.weekId);
        const guide = getScoringGuide(now);
        assert.equal(guide.weekId, window.weekId);
        assert.equal(guide.start, window.start); assert.equal(guide.end, window.end);
        assert.ok(Date.parse(window.end) <= now.getTime());
        assert.ok(now.getTime() < Date.parse(window.end) + WEEK);
      }
    }
  }
});

test("every allowed insufficient-evidence subset stays bounded and owns its validated result", () => {
  const codes = Object.keys(MISSING_EVIDENCE);
  for (let mask = 1; mask < 1 << codes.length; mask++) {
    const missing = codes.filter((_code, index) => (mask & 1 << index) !== 0);
    const input = { status: "insufficient_evidence", weekId: "2026-W37", missing };
    const result = parseAssessmentResult(input, "2026-W37");
    assert.deepEqual(result, input);
    assert.ok("missing" in result);
    missing.push("PRIVATE_CANARY");
    assert.ok(!result.missing.includes("PRIVATE_CANARY" as never), "Caller mutations must not change validated codes");
  }
  for (const missing of [new Array(1), ["focus", , "output"], [null], ["toString"], ["constructor"], ["__proto__"], ["focus", "focus"], [...codes, "output"]]) {
    assert.throws(() => parseAssessmentResult({ status: "insufficient_evidence", weekId: "2026-W37", missing }, "2026-W37"));
  }
});
