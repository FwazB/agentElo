import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  blindEntry,
  EntryValidationError,
  entryFingerprint,
  MAX_ENTRY_BYTES,
  parseWorkEntry,
  publicEntrySummary,
  type WorkEntry,
} from "../entries.ts";

function entry(): WorkEntry {
  return {
    version: "antislop.entry.v1",
    entryId: "entry-42",
    participantId: "participant-7",
    window: { startsAt: "2026-09-08T15:04:05.006Z", endsAt: "2026-09-15T15:04:05.006Z" },
    summary: "Fixed a retry bug for café orders. 修复 ✅",
    accomplishments: [{ id: "private-accomplishment", outcome: "Retries no longer create duplicate orders.", evidenceIds: ["private-check", "private-artifact"] }],
    evidence: [
      { id: "private-artifact", kind: "artifact", excerpt: "Retry handling now reuses the original order key.", occurredAt: "2026-09-09T12:00:00.000Z" },
      { id: "private-check", kind: "check", excerpt: "Repeated the same order request twice; one order remained.", occurredAt: "2026-09-10T12:00:00.000Z" },
    ],
    refereeConsent: { approved: true, approvedAt: "2026-09-15T15:04:05.006Z" },
    publicSummary: { text: "  Improved ordering reliability. ✅\n", approvedAt: "2026-09-15T16:00:00.000Z" },
  };
}

function reject(mutator: (value: WorkEntry) => void): void {
  const value = entry();
  mutator(value);
  assert.throws(() => parseWorkEntry(value), EntryValidationError);
}

test("accepts Unicode, rolling windows, and the explicit approved public snapshot", () => {
  const value = entry();
  assert.deepEqual(parseWorkEntry(value), value);
  assert.equal(publicEntrySummary(value)?.text, "  Improved ordering reliability. ✅\n");
  value.publicSummary = null;
  assert.equal(publicEntrySummary(value), null);
  value.evidence[0]!.kind = "attestation";
  assert.equal(parseWorkEntry(value).evidence[0]!.kind, "attestation");
});

test("requires every field and rejects extra or secret-named keys without echoing them", () => {
  const value = entry();
  for (const key of Object.keys(value)) {
    const missing = { ...value } as Record<string, unknown>;
    delete missing[key];
    assert.throws(() => parseWorkEntry(missing), EntryValidationError);
  }
  const secret = "private-token-do-not-echo";
  const candidates = [
    { ...value, [secret]: secret },
    { ...value, window: { ...value.window, [secret]: secret } },
    { ...value, accomplishments: [{ ...value.accomplishments[0], [secret]: secret }] },
    { ...value, evidence: [{ ...value.evidence[0], [secret]: secret }] },
    { ...value, refereeConsent: { ...value.refereeConsent, [secret]: secret } },
    { ...value, publicSummary: { ...value.publicSummary, [secret]: secret } },
  ];
  for (const candidate of candidates) {
    assert.throws(() => parseWorkEntry(candidate), error => error instanceof EntryValidationError && !error.message.includes(secret));
  }
  reject(value => { value.version = "unknown" as WorkEntry["version"]; });
});

test("metadata identifiers are bounded ASCII tokens", () => {
  for (const invalid of ["", "a".repeat(81), "contains spaces", "hello@person", "../path", "identité", "_leading", "<tag>", "abc\n", "abc\r", "abc\r\n", "abc\u2028", "abc\u2029"]) {
    reject(value => { value.entryId = invalid; });
    reject(value => { value.participantId = invalid; });
    reject(value => { value.accomplishments[0]!.id = invalid; });
    reject(value => { value.evidence[0]!.id = invalid; });
  }
  const value = entry();
  value.participantId = "p".repeat(80);
  assert.equal(parseWorkEntry(value).participantId.length, 80);
});

test("requires supporting evidence for every accomplishment and enforces unique linked ids", () => {
  reject(value => { value.evidence = []; });
  reject(value => { value.accomplishments = []; });
  reject(value => { value.accomplishments[0]!.evidenceIds = []; });
  reject(value => { value.accomplishments[0]!.evidenceIds = ["nonexistent"]; });
  reject(value => { value.accomplishments[0]!.evidenceIds = ["private-check", "private-check"]; });
  reject(value => { value.evidence[1]!.id = value.evidence[0]!.id; });
  reject(value => { value.accomplishments.push(structuredClone(value.accomplishments[0]!)); });
  reject(value => { value.evidence[0]!.kind = "verified" as WorkEntry["evidence"][number]["kind"]; });
});

test("bounds arrays before traversing their contents", () => {
  reject(value => { value.accomplishments = Array.from({ length: 6 }, (_, index) => ({ ...value.accomplishments[0]!, id: `a${index}` })); });
  reject(value => { value.evidence = Array.from({ length: 11 }, (_, index) => ({ ...value.evidence[0]!, id: `e${index}` })); });
  reject(value => { value.accomplishments[0]!.evidenceIds = Array.from({ length: 11 }, (_, index) => `e${index}`); });
  reject(value => { value.evidence = new Array(1_000_000_000) as WorkEntry["evidence"]; });
});

test("exact timestamps must be real, canonical UTC millisecond strings", () => {
  for (const invalid of ["2026-09-09T12:00:00Z", "2026-09-09T12:00:00.000+00:00", "2026-09-09t12:00:00.000z", "2026-02-30T12:00:00.000Z", "2026-09-09T24:00:00.000Z", "invalid"]) {
    reject(value => { value.evidence[0]!.occurredAt = invalid; });
    reject(value => { value.window.startsAt = invalid; });
    reject(value => { value.refereeConsent.approvedAt = invalid; });
    reject(value => { value.publicSummary!.approvedAt = invalid; });
  }
  reject(value => { value.window.startsAt = "2026-09-09"; });
  reject(value => { value.refereeConsent.approvedAt = "2026-09-15"; });
  reject(value => { value.publicSummary!.approvedAt = "2026-09-15"; });
});

test("date-only evidence preserves its precision and allows partially overlapping boundary days", () => {
  const value = entry();
  value.evidence[0]!.occurredAt = "2026-09-08";
  value.evidence[1]!.occurredAt = "2026-09-15";
  assert.deepEqual(parseWorkEntry(value).evidence.map(item => item.occurredAt), ["2026-09-08", "2026-09-15"]);
  assert.deepEqual(blindEntry(value).evidence.map(item => item.occurredAt), ["2026-09-08", "2026-09-15"]);
  reject(item => { item.evidence[0]!.occurredAt = "2026-09-07"; });
  reject(item => { item.evidence[0]!.occurredAt = "2026-09-16"; });
});

test("date-only evidence excludes days ending at the window start or starting at its end", () => {
  const value = entry();
  value.window = { startsAt: "2026-09-08T00:00:00.000Z", endsAt: "2026-09-15T00:00:00.000Z" };
  value.evidence[0]!.occurredAt = "2026-09-08";
  value.evidence[1]!.occurredAt = "2026-09-14";
  assert.deepEqual(parseWorkEntry(value).evidence, value.evidence);
  value.evidence[0]!.occurredAt = "2026-09-07";
  assert.throws(() => parseWorkEntry(value), EntryValidationError);
  value.evidence[0]!.occurredAt = "2026-09-15";
  assert.throws(() => parseWorkEntry(value), EntryValidationError);
});

test("calendar dates must be real exact dates, including leap days", () => {
  for (const invalid of ["2026-02-29", "2026-02-30", "2026-09-00", "2026-09-31", "2026-9-09", "2026/09/09", "2026-09-09\n", "2026-09-09Z", "2026-09-09 "]) {
    reject(value => { value.evidence[0]!.occurredAt = invalid; });
  }
  const leap = entry();
  leap.window = { startsAt: "2024-02-26T00:00:00.000Z", endsAt: "2024-03-04T00:00:00.000Z" };
  leap.evidence.forEach(item => { item.occurredAt = "2024-02-29"; });
  assert.equal(parseWorkEntry(leap).evidence[0]!.occurredAt, "2024-02-29");
});

test("entry fingerprints distinguish date-only claims from exact timestamps", () => {
  const value = entry();
  value.evidence[0]!.occurredAt = "2026-09-09";
  const dated = entryFingerprint(value);
  value.evidence[0]!.occurredAt = "2026-09-09T00:00:00.000Z";
  assert.notEqual(entryFingerprint(value), dated);
});

test("requires exactly seven elapsed days and evidence in the half-open window", () => {
  reject(value => { value.window.endsAt = "2026-09-15T15:04:05.005Z"; });
  reject(value => { value.window.endsAt = "2026-09-15T15:04:05.007Z"; });
  reject(value => { value.window.endsAt = value.window.startsAt; });
  reject(value => { value.evidence[0]!.occurredAt = "2026-09-08T15:04:05.005Z"; });
  reject(value => { value.evidence[0]!.occurredAt = value.window.endsAt; });
  const value = entry();
  value.evidence[0]!.occurredAt = value.window.startsAt;
  value.evidence[1]!.occurredAt = "2026-09-15T15:04:05.005Z";
  assert.deepEqual(parseWorkEntry(value).evidence, value.evidence);
});

test("requires affirmative referee consent and approvals after the window closes", () => {
  for (const approved of [false, "true", 1, null, undefined]) {
    assert.throws(() => parseWorkEntry({ ...entry(), refereeConsent: { approved, approvedAt: entry().window.endsAt } }), EntryValidationError);
  }
  reject(value => { value.refereeConsent.approvedAt = "2026-09-15T15:04:05.005Z"; });
  reject(value => { value.publicSummary!.approvedAt = "2026-09-15T15:04:05.005Z"; });
  const value = entry();
  value.publicSummary!.approvedAt = value.window.endsAt;
  assert.equal(parseWorkEntry(value).publicSummary!.approvedAt, value.window.endsAt);
});

test("bounds UTF-8 text without altering the approved text", () => {
  for (const blank of ["", " ", "\n\t"]) {
    reject(value => { value.summary = blank; });
    reject(value => { value.accomplishments[0]!.outcome = blank; });
    reject(value => { value.evidence[0]!.excerpt = blank; });
    reject(value => { value.publicSummary!.text = blank; });
  }
  reject(value => { value.summary = "x".repeat(4_001); });
  reject(value => { value.summary = "é".repeat(2_001); });
  reject(value => { value.accomplishments[0]!.outcome = "x".repeat(2_001); });
  reject(value => { value.evidence[0]!.excerpt = "x".repeat(6_001); });
  reject(value => { value.publicSummary!.text = "x".repeat(2_001); });
  const value = entry();
  value.summary = "é".repeat(2_000);
  assert.equal(parseWorkEntry(value).summary, value.summary);
});

test("caps the entire serialized entry at 64 KiB including JSON escaping", () => {
  const value = entry();
  value.summary = "x".repeat(4_000);
  value.evidence = Array.from({ length: 10 }, (_, index) => ({ ...value.evidence[0]!, id: `e${index}`, excerpt: "x".repeat(6_000) }));
  value.accomplishments = Array.from({ length: 5 }, (_, index) => ({ id: `a${index}`, outcome: "x".repeat(2_000), evidenceIds: ["e0"] }));
  assert.ok(Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_ENTRY_BYTES);
  assert.throws(() => parseWorkEntry(value), EntryValidationError);
  value.summary = "summary";
  value.accomplishments = [{ id: "a0", outcome: "outcome", evidenceIds: ["e0"] }];
  value.publicSummary = null;
  assert.ok(Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_ENTRY_BYTES);
  assert.equal(parseWorkEntry(value).evidence.length, 10);
  value.evidence.forEach(item => { item.excerpt = "\u0000".repeat(1_100); });
  assert.throws(() => parseWorkEntry(value), EntryValidationError);
});

test("rejects prototypes, symbols, accessors and proxies without executing accessors", () => {
  const value = entry();
  assert.throws(() => parseWorkEntry(Object.create(value)), EntryValidationError);
  assert.throws(() => parseWorkEntry(Object.assign(new Date(), value)), EntryValidationError);
  assert.throws(() => parseWorkEntry({ ...value, [Symbol("private")]: "private" }), EntryValidationError);
  assert.throws(() => parseWorkEntry({ ...value, window: Object.create(value.window) }), EntryValidationError);
  const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, value);
  assert.deepEqual(parseWorkEntry(nullPrototype), value);
  let accessed = 0;
  const accessor = { ...value };
  Object.defineProperty(accessor, "summary", { enumerable: true, get() { accessed++; throw new Error("private secret"); } });
  assert.throws(() => parseWorkEntry(accessor), EntryValidationError);
  const nestedAccessor = entry();
  Object.defineProperty(nestedAccessor.evidence[0], "excerpt", { enumerable: true, get() { accessed++; return "secret"; } });
  assert.throws(() => parseWorkEntry(nestedAccessor), EntryValidationError);
  const hidden = { ...value };
  Object.defineProperty(hidden, "summary", { enumerable: false, value: value.summary });
  assert.throws(() => parseWorkEntry(hidden), EntryValidationError);
  const proxy = new Proxy(value, { ownKeys() { accessed++; throw new Error("private secret"); } });
  assert.throws(() => parseWorkEntry(proxy), EntryValidationError);
  const revoked = Proxy.revocable(value, {});
  revoked.revoke();
  assert.throws(() => parseWorkEntry(revoked.proxy), EntryValidationError);
  assert.equal(accessed, 0);
});

test("rejects sparse, accessor-backed, decorated and subclassed arrays", () => {
  reject(value => { delete value.evidence[0]; });
  reject(value => { Object.assign(value.evidence, { privateData: "secret" }); });
  reject(value => { Object.assign(value.accomplishments[0]!.evidenceIds, { privateData: "secret" }); });
  reject(value => { Object.defineProperty(value.evidence, Symbol("secret"), { value: "secret" }); });
  reject(value => { value.evidence = new Proxy(value.evidence, {}); });
  class EvidenceList extends Array<WorkEntry["evidence"][number]> {}
  reject(value => { value.evidence = new EvidenceList(...value.evidence); });
  let accessed = 0;
  reject(value => { Object.defineProperty(value.evidence, "0", { enumerable: true, get() { accessed++; return entry().evidence[0]; } }); });
  assert.equal(accessed, 0);
});

test("fingerprints use stable UTF-8 property order and commit to private and approval data", () => {
  const value = entry();
  const normalized = parseWorkEntry(value);
  const expected = `sha256:${createHash("sha256").update(JSON.stringify(normalized), "utf8").digest("hex")}`;
  assert.equal(entryFingerprint(value), expected);
  const reordered = Object.fromEntries(Object.entries(value).reverse());
  reordered.window = Object.fromEntries(Object.entries(value.window).reverse());
  reordered.evidence = value.evidence.map(item => Object.fromEntries(Object.entries(item).reverse()));
  assert.equal(entryFingerprint(reordered as unknown as WorkEntry), expected);
  for (const mutate of [
    (item: WorkEntry) => { item.summary += "!"; },
    (item: WorkEntry) => { item.entryId += "x"; },
    (item: WorkEntry) => { item.participantId += "x"; },
    (item: WorkEntry) => { item.publicSummary!.text += "!"; },
    (item: WorkEntry) => { item.refereeConsent.approvedAt = "2026-09-15T18:00:00.000Z"; },
    (item: WorkEntry) => { item.evidence.reverse(); },
    (item: WorkEntry) => { item.accomplishments[0]!.evidenceIds.reverse(); },
  ]) {
    const changed = entry();
    mutate(changed);
    assert.notEqual(entryFingerprint(changed), expected);
  }
});

test("blind projections omit metadata and replace every submitted local identifier", () => {
  const value = entry();
  const blind = blindEntry(value);
  assert.deepEqual(Object.keys(blind).sort(), ["accomplishments", "evidence", "summary", "window"]);
  assert.deepEqual(blind.evidence.map(item => item.id), ["e1", "e2"]);
  assert.deepEqual(blind.accomplishments.map(item => item.id), ["a1"]);
  assert.deepEqual(blind.accomplishments[0]!.evidenceIds, ["e2", "e1"]);
  const serialized = JSON.stringify(blind);
  for (const privateValue of [value.entryId, value.participantId, value.publicSummary!.text, "private-accomplishment", "private-artifact", "private-check"]) {
    assert.equal(serialized.includes(privateValue), false);
  }
  value.summary = "My name appears in submitted text.";
  assert.equal(blindEntry(value).summary, value.summary);
});

test("public projection releases only entry id and separately approved text", () => {
  const value = entry();
  assert.deepEqual(publicEntrySummary(value), { entryId: value.entryId, text: value.publicSummary!.text });
  const before = publicEntrySummary(value);
  value.summary = "Private summary changed.";
  value.evidence[0]!.excerpt = "Private evidence changed.";
  assert.deepEqual(publicEntrySummary(value), before);
  value.publicSummary = null;
  assert.equal(publicEntrySummary(value), null);
});

test("parsing and projections have no input or output aliases", () => {
  const input = entry();
  const expected = structuredClone(input);
  const parsed = parseWorkEntry(input);
  const blind = blindEntry(input);
  const publicProjection = publicEntrySummary(input)!;
  input.window.startsAt = "changed";
  input.accomplishments[0]!.evidenceIds.push("changed");
  input.evidence[0]!.excerpt = "changed";
  input.refereeConsent.approvedAt = "changed";
  input.publicSummary!.text = "changed";
  assert.deepEqual(parsed, expected);
  assert.equal(blind.window.startsAt, expected.window.startsAt);
  assert.equal(blind.evidence[0]!.excerpt, expected.evidence[0]!.excerpt);
  assert.equal(publicProjection.text, expected.publicSummary!.text);
  parsed.accomplishments[0]!.evidenceIds.push("other");
  assert.deepEqual(blind.accomplishments[0]!.evidenceIds, ["e2", "e1"]);
  const source = entry();
  const output = blindEntry(source);
  output.window.endsAt = "changed";
  output.evidence[0]!.excerpt = "changed";
  output.accomplishments[0]!.evidenceIds.push("changed");
  assert.deepEqual(source, expected);
});

test("all exported transforms revalidate their inputs before releasing data", () => {
  const invalid = { ...entry(), publicSummary: { text: "not approved" } } as WorkEntry;
  for (const transform of [entryFingerprint, blindEntry, publicEntrySummary]) {
    assert.throws(() => transform(invalid), EntryValidationError);
  }
});
