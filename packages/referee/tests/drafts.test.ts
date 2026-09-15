import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEntryPrompt,
  ENTRY_DRAFT_VERSION,
  parseEntryDraft,
  type EntryDraft,
  type InsufficientContextEntryDraft,
  type ReadyEntryDraft,
} from "../drafts.ts";
import { EntryValidationError } from "../entries.ts";

const window = { startsAt: "2026-09-08T15:04:05.006Z", endsAt: "2026-09-15T15:04:05.006Z" };

function ready(): ReadyEntryDraft {
  return {
    version: ENTRY_DRAFT_VERSION,
    status: "ready",
    window: { ...window },
    summary: "Fixed café ordering retries. 修复 ✅",
    accomplishments: [{ id: "a1", outcome: "Retries kept one order instead of creating duplicates.", evidenceIds: ["e1", "e2"] }],
    evidence: [
      { id: "e1", kind: "artifact", excerpt: "The retry handler reuses the original order key.", occurredAt: "2026-09-09" },
      { id: "e2", kind: "check", excerpt: "Two repeated requests returned one persisted order.", occurredAt: "2026-09-10T12:00:00.000Z" },
    ],
    publicSummary: null,
  };
}

function insufficient(reason: InsufficientContextEntryDraft["reason"] = "no_dated_evidence"): InsufficientContextEntryDraft {
  return { version: ENTRY_DRAFT_VERSION, status: "insufficient_context", window: { ...window }, reason };
}

test("ready drafts retain evidence precision without granting identity, approval or public sharing", () => {
  const draft = ready();
  const parsed = parseEntryDraft(draft);
  assert.deepEqual(parsed, draft);
  assert.equal(parsed.status, "ready");
  assert.equal(JSON.stringify(parsed).includes("draft-validation"), false);
  assert.equal(Object.hasOwn(parsed, "refereeConsent"), false);
  assert.equal(Object.hasOwn(parsed, "participantId"), false);
  assert.equal(Object.hasOwn(parsed, "entryId"), false);
  if (parsed.status !== "ready") assert.fail("Expected a ready draft.");
  assert.equal(parsed.publicSummary, null);
  assert.equal(parsed.evidence[0]!.occurredAt, "2026-09-09");
  assert.equal(parsed.evidence[1]!.occurredAt, "2026-09-10T12:00:00.000Z");
});

test("insufficient context is a separate response with no invented summary or evidence", () => {
  const reasons: InsufficientContextEntryDraft["reason"][] = ["no_authorized_context", "no_dated_evidence", "no_safe_evidence", "no_supported_outcome"];
  for (const reason of reasons) {
    const draft = insufficient(reason);
    assert.deepEqual(parseEntryDraft(draft), draft);
    assert.throws(() => parseEntryDraft({ ...draft, summary: "Invented work." }), EntryValidationError);
    assert.throws(() => parseEntryDraft({ ...draft, evidence: [] }), EntryValidationError);
    assert.throws(() => parseEntryDraft({ ...draft, publicSummary: null }), EntryValidationError);
  }
  for (const reason of ["no_work_happened", "", null, 0, {}, "no_dated_evidence\n"]) {
    assert.throws(() => parseEntryDraft({ ...insufficient(), reason }), EntryValidationError);
  }
});

test("both draft shapes require exact fields and reject unsupported versions and statuses", () => {
  for (const draft of [ready(), insufficient()]) {
    for (const key of Object.keys(draft)) {
      const missing: Record<string, unknown> = { ...draft };
      delete missing[key];
      assert.throws(() => parseEntryDraft(missing), EntryValidationError);
    }
    assert.throws(() => parseEntryDraft({ ...draft, version: "antislop.entry.v1" }), EntryValidationError);
    assert.throws(() => parseEntryDraft({ ...draft, status: "submitted" }), EntryValidationError);
    assert.throws(() => parseEntryDraft({ ...draft, status: "ready\n" }), EntryValidationError);
    assert.throws(() => parseEntryDraft({ ...draft, [Symbol("private")]: "private" }), EntryValidationError);
  }
});

test("drafts cannot supply server identities, approval timestamps or public wording", () => {
  for (const fields of [
    { participantId: "someone-else" },
    { entryId: "existing-entry" },
    { refereeConsent: { approved: true, approvedAt: window.endsAt } },
    { refereeApproved: true },
    { optedIn: true },
    { requestId: "request-1" },
  ]) {
    assert.throws(() => parseEntryDraft({ ...ready(), ...fields }), EntryValidationError);
    assert.throws(() => parseEntryDraft({ ...insufficient(), ...fields }), EntryValidationError);
  }
  for (const publicSummary of [{ text: "Share me." }, { text: "Share me.", approved: true }, "Share me.", false, undefined]) {
    assert.throws(() => parseEntryDraft({ ...ready(), publicSummary }), EntryValidationError);
  }
});

test("ready drafts enforce the full linked-evidence and bounded-text entry contract", () => {
  const variants: Array<(draft: ReadyEntryDraft) => void> = [
    draft => { draft.summary = "é".repeat(2_001); },
    draft => { draft.summary = "  "; },
    draft => { draft.evidence = []; },
    draft => { draft.evidence[0]!.occurredAt = "2026-09-07"; },
    draft => { draft.evidence[0]!.occurredAt = "2026-09-09T12:00:00Z"; },
    draft => { draft.evidence[0]!.excerpt = "x".repeat(6_001); },
    draft => { draft.accomplishments[0]!.evidenceIds = []; },
    draft => { draft.accomplishments[0]!.evidenceIds = ["not-present"]; },
    draft => { draft.accomplishments[0]!.evidenceIds = ["e1", "e1"]; },
    draft => { draft.accomplishments[0]!.id = "a1\n"; },
    draft => { draft.evidence[1]!.id = "e1"; },
  ];
  for (const change of variants) {
    const draft = ready();
    change(draft);
    assert.throws(() => parseEntryDraft(draft), EntryValidationError);
  }
  const oversized = ready();
  oversized.summary = "x".repeat(4_000);
  oversized.evidence = Array.from({ length: 10 }, (_, index) => ({ ...oversized.evidence[0]!, id: `e${index}`, excerpt: "x".repeat(6_000) }));
  oversized.accomplishments = Array.from({ length: 5 }, (_, index) => ({ id: `a${index}`, outcome: "x".repeat(2_000), evidenceIds: ["e0"] }));
  assert.throws(() => parseEntryDraft(oversized), EntryValidationError);
});

test("drafts and prompts require exact rolling-seven-day UTC windows", () => {
  const invalidWindows: unknown[] = [
    null,
    { ...window, startsAt: "2026-09-08" },
    { ...window, endsAt: "2026-09-15" },
    { ...window, startsAt: "2026-09-08T15:04:05.006+00:00" },
    { ...window, startsAt: "2026-02-30T15:04:05.006Z" },
    { ...window, endsAt: "2026-09-15T15:04:05.007Z" },
    { ...window, endsAt: window.startsAt },
    { ...window, privateField: "secret" },
    { startsAt: window.startsAt },
    Object.create(window),
    new Proxy(window, {}),
  ];
  for (const invalidWindow of invalidWindows) {
    assert.throws(() => parseEntryDraft({ ...ready(), window: invalidWindow }), EntryValidationError);
    assert.throws(() => parseEntryDraft({ ...insufficient(), window: invalidWindow }), EntryValidationError);
    assert.throws(() => buildEntryPrompt(invalidWindow as ReadyEntryDraft["window"]), EntryValidationError);
  }
  // Draft validation does not invent a current clock or freshness policy: the
  // authenticated submission endpoint owns that separate check.
  const old = insufficient();
  old.window = { startsAt: "2000-01-01T00:00:00.000Z", endsAt: "2000-01-08T00:00:00.000Z" };
  assert.deepEqual(parseEntryDraft(old), old);
});

test("draft parsing rejects proxies and accessors without executing user code", () => {
  let accessed = 0;
  for (const field of ["status", "summary", "window"]) {
    const draft = ready();
    Object.defineProperty(draft, field, { enumerable: true, get() { accessed++; throw new Error("private secret"); } });
    assert.throws(() => parseEntryDraft(draft), EntryValidationError);
  }
  const nested = ready();
  Object.defineProperty(nested.window, "endsAt", { enumerable: true, get() { accessed++; throw new Error("private secret"); } });
  assert.throws(() => parseEntryDraft(nested), EntryValidationError);
  assert.throws(() => buildEntryPrompt(nested.window), EntryValidationError);
  const proxy = new Proxy(ready(), { get() { accessed++; throw new Error("private secret"); } });
  assert.throws(() => parseEntryDraft(proxy), EntryValidationError);
  const revoked = Proxy.revocable(ready(), {});
  revoked.revoke();
  assert.throws(() => parseEntryDraft(revoked.proxy), EntryValidationError);
  assert.throws(() => parseEntryDraft(Object.create(ready())), EntryValidationError);
  const hidden = ready();
  Object.defineProperty(hidden, "status", { enumerable: false, value: "ready" });
  assert.throws(() => parseEntryDraft(hidden), EntryValidationError);
  assert.equal(accessed, 0);
});

test("draft validation errors do not echo private keys or values", () => {
  const secret = "private-value-never-echo";
  const variants = [
    { ...ready(), [secret]: secret },
    { ...ready(), status: secret },
    { ...insufficient(), reason: secret },
    { ...ready(), window: { ...window, [secret]: secret } },
    { ...ready(), evidence: [{ ...ready().evidence[0], occurredAt: secret }] },
  ];
  for (const variant of variants) {
    assert.throws(() => parseEntryDraft(variant), error => error instanceof EntryValidationError && !error.message.includes(secret));
  }
});

test("draft parser returns detached data for both shapes", () => {
  const original = ready();
  const expected = structuredClone(original);
  const parsed = parseEntryDraft(original);
  original.window.startsAt = "changed";
  original.summary = "changed";
  original.accomplishments[0]!.evidenceIds.push("changed");
  original.evidence[0]!.excerpt = "changed";
  assert.deepEqual(parsed, expected);
  const insufficientInput = insufficient();
  const insufficientOutput = parseEntryDraft(insufficientInput);
  insufficientInput.window.endsAt = "changed";
  assert.equal(insufficientOutput.window.endsAt, window.endsAt);
  const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, expected);
  assert.deepEqual(parseEntryDraft(nullPrototype), expected);
});

test("preparation prompt contains complete contract examples and preserves the issued window", () => {
  const prompt = buildEntryPrompt(window);
  assert.ok(prompt.includes(`${window.startsAt} inclusive to ${window.endsAt} exclusive`));
  const examples = [...prompt.matchAll(/^\{[\s\S]*?^\}/gm)].map(match => JSON.parse(match[0]) as Record<string, unknown>);
  assert.equal(examples.length, 2);
  assert.deepEqual(examples[0]!.window, window);
  assert.deepEqual(examples[1]!.window, window);
  assert.deepEqual(parseEntryDraft(examples[1]), insufficient());
  // The structural example cannot masquerade as dated evidence if copied as-is.
  assert.throws(() => parseEntryDraft(examples[0]), EntryValidationError);
  const completedExample: EntryDraft = { ...ready(), window: examples[0]!.window as ReadyEntryDraft["window"] };
  assert.deepEqual(parseEntryDraft(completedExample), ready());
});

test("preparation prompt preserves consent, privacy, and honest insufficient-context behavior", () => {
  const prompt = buildEntryPrompt(window);
  assert.match(prompt, /Do not ask follow-up questions or request more access/);
  assert.match(prompt, /do not submit it, call a referee, or publish anything/);
  assert.match(prompt, /Never invent work, evidence, checks, impact or dates/);
  assert.match(prompt, /Never invent an hour or timezone/);
  assert.match(prompt, /Remove names, handles, organizations, contact details, URLs, file paths, secrets, customer data and confidential content/);
  assert.match(prompt, /missing context is not proof that no work happened/);
  assert.match(prompt, /Set publicSummary to null/);
  assert.match(prompt, /explicitly approve sending it to the shared referee before submission/);
  assert.match(prompt, /Your output grants no consent and is not a rating/);
  assert.match(prompt, /4000 UTF-8 bytes/);
  assert.match(prompt, /at most 64 KiB/);
});
