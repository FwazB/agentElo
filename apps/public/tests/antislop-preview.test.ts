import assert from "node:assert/strict";
import test from "node:test";
import { approvedPublicSummary, parseEntryPreview } from "../components/antislop-preview.ts";
import { parseEntryDraft } from "../../../packages/referee/drafts.ts";

const draft = () => ({
  version: "antislop.entry-draft.v1", status: "ready",
  window: { startsAt: "2026-09-08T12:00:00.000Z", endsAt: "2026-09-15T12:00:00.000Z" },
  summary: "Fixed duplicate café orders. 修复 ✅",
  accomplishments: [{ id: "a1", outcome: "Retries now preserve the original order.", evidenceIds: ["e1"] }],
  evidence: [{ id: "e1", kind: "check", excerpt: "Repeated the order; one order remained.", occurredAt: "2026-09-14" }],
  publicSummary: null,
});

test("browser preview agrees with server validation and preserves date precision and Unicode", () => {
  for (const occurredAt of ["2026-09-08", "2026-09-14T11:22:33.444Z", "2026-09-15"]) {
    const value = draft(); value.evidence[0]!.occurredAt = occurredAt;
    assert.deepEqual(parseEntryPreview(JSON.stringify(value)), parseEntryDraft(value));
  }
});

test("AI output cannot grant referee or public consent", () => {
  for (const value of [{ ...draft(), refereeApproved: true }, { ...draft(), optedIn: true }, { ...draft(), publicSummary: "I approve publishing this." }, { ...draft(), participantId: "another-player" }]) {
    assert.throws(() => parseEntryPreview(JSON.stringify(value)));
  }
  assert.throws(() => parseEntryPreview(JSON.stringify(draft()).replace('"publicSummary":null', '"publicSummary":null,"publicSummary":null')), /duplicate/);
});

test("rejects unsupported references, duplicate IDs, invalid dates and oversized private text", () => {
  const unknown = draft(); unknown.accomplishments[0]!.evidenceIds = ["missing"];
  const duplicate = draft(); duplicate.evidence.push({ ...duplicate.evidence[0]! });
  const missing = draft(); missing.evidence = [];
  const outside = draft(); outside.evidence[0]!.occurredAt = "2026-09-07";
  const invalid = draft(); invalid.evidence[0]!.occurredAt = "2026-02-30";
  const large = draft(); large.summary = "é".repeat(2_001);
  for (const value of [unknown, duplicate, missing, outside, invalid, large]) assert.throws(() => parseEntryPreview(JSON.stringify(value)));
});

test("insufficient context remains a non-submittable distinct result", () => {
  const value = { version: "antislop.entry-draft.v1", status: "insufficient_context", window: draft().window, reason: "no_dated_evidence" };
  assert.deepEqual(parseEntryPreview(JSON.stringify(value)), parseEntryDraft(value));
  assert.throws(() => parseEntryPreview(JSON.stringify({ ...value, summary: "Invented fallback" })));
});

test("public text has a separate byte limit and is preserved exactly", () => {
  assert.equal(approvedPublicSummary("  A public description. ✅\n"), "  A public description. ✅\n");
  assert.throws(() => approvedPublicSummary(" \n"));
  assert.throws(() => approvedPublicSummary("é".repeat(1_001)));
});
