import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { ReadyEntryDraft } from "../../../packages/referee/drafts.ts";
import type { JudgeResponse, Outcome } from "../../../packages/referee/judge.ts";
import { LIVE_JUDGE_CONFIG } from "../../../packages/referee/live-config.ts";
import type { AntiSlopJudgeClaim, SubmitEntryRequest } from "../../../packages/public-api/antislop.ts";
import { createAntislopStore } from "../antislop/store.ts";
import { ApiError, createStore } from "../store.ts";

const START = Date.parse("2026-09-15T12:00:00.000Z");
const DAY = 86_400_000;
let playerNumber = 0;

function draft(marker: string, end = START): ReadyEntryDraft {
  return {
    version: "antislop.entry-draft.v1", status: "ready",
    window: { startsAt: new Date(end - 7 * DAY).toISOString(), endsAt: new Date(end).toISOString() },
    summary: `Private synthetic completed work ${marker}`,
    accomplishments: [{ id: "a1", outcome: `Fixed synthetic issue ${marker}`, evidenceIds: ["e1"] }],
    evidence: [{ id: "e1", kind: "check", excerpt: `PRIVATE-EVIDENCE-${marker} café 修正 verified`, occurredAt: new Date(end - DAY).toISOString().slice(0, 10) }],
    publicSummary: null,
  };
}

function submission(marker: string, overrides: Partial<SubmitEntryRequest> = {}): SubmitEntryRequest {
  return { requestId: randomUUID(), draft: draft(marker), refereeApproved: true,
    publicSummary: { text: `Approved public ${marker}`, approved: true }, optedIn: true, ...overrides };
}

function harness() {
  const directory = mkdtempSync(join(tmpdir(), "antislop-store-"));
  const databasePath = join(directory, "elo.sqlite");
  let milliseconds = START;
  let fault = "";
  const legacy = createStore({ databasePath, now: () => new Date(milliseconds) });
  const options = { databasePath, now: () => new Date(milliseconds), beforeCommit: (operation: string) => { if (operation === fault) throw new Error("injected transaction failure"); } };
  let arena = createAntislopStore(options);
  return {
    databasePath, legacy,
    get arena() { return arena; },
    setTime: (value: number) => { milliseconds = value; },
    setFault: (value: string) => { fault = value; },
    newPlayer: () => legacy.createPlayer(`testplayer${++playerNumber}`, randomBytes(32).toString("hex")).player.id,
    reopen: () => { arena.close(); arena = createAntislopStore(options); },
    reopenFromLegacySchema: () => {
      arena.close();
      const db = new DatabaseSync(databasePath);
      try {
        db.exec("DROP INDEX antislop_private_expiry");
        for (const column of ["public_json", "public_hash", "private_expires_at", "private_erased_at"]) db.exec(`ALTER TABLE antislop_entries DROP COLUMN ${column}`);
        db.exec("ALTER TABLE antislop_judge_runs DROP COLUMN private_expires_at");
      } finally { db.close(); }
      arena = createAntislopStore(options);
    },
    second: () => createAntislopStore(options),
    inspect: () => new DatabaseSync(databasePath, { readOnly: true }),
    close: () => { arena.close(); legacy.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

type Harness = ReturnType<typeof harness>;
function pair(h: Harness, marker = "pair") {
  const a = h.newPlayer(), b = h.newPlayer();
  const entryA = h.arena.submitEntry(a, submission(`${marker}-a`)).entry;
  const entryB = h.arena.submitEntry(b, submission(`${marker}-b`)).entry;
  const request = { requestId: randomUUID(), entryId: entryA.entryId, opponentEntryId: entryB.entryId };
  const duel = h.arena.createDuel(a, request).duel;
  return { a, b, entryA, entryB, request, duel };
}

function response(claim: AntiSlopJudgeClaim, order: "ab" | "ba", outcome: Outcome): JudgeResponse {
  return {
    version: "antislop.judge-response.v1", judgeFingerprint: claim.judgeFingerprint, pairFingerprint: claim.pairFingerprint, order,
    verdict: { outcome, reason: outcome === "draw" ? "comparable_work" : outcome === "unrated" ? "insufficient_evidence" : "stronger_work",
      explanation: "PRIVATE-VERDICT may quote the opponent's private evidence.", evidenceRefs: { a: ["e1"], b: ["e1"] } },
  };
}

function settlement(claim: AntiSlopJudgeClaim, ab: Outcome = "a_wins", ba: Outcome = "b_wins") {
  return { leaseToken: claim.leaseToken, responseAB: response(claim, "ab", ab), responseBA: response(claim, "ba", ba) };
}

const status = (wanted: number) => (error: unknown): boolean => error instanceof ApiError && error.status === wanted;

test("server owns identity and consent timestamps; private saves have no public presence", () => {
  const h = harness();
  try {
    const owner = h.newPlayer(), other = h.newPlayer();
    const input = submission("private", { publicSummary: null, optedIn: false });
    const result = h.arena.submitEntry(owner, input);
    assert.equal(result.created, true);
    assert.match(result.entry.entryId, /^ae_[a-f0-9]{32}$/);
    assert.equal(result.entry.entry.participantId, owner);
    assert.deepEqual(result.entry.entry.refereeConsent, { approved: true, approvedAt: new Date(START).toISOString() });
    assert.equal(result.entry.publicSummary, null);
    assert.equal(result.entry.entry.evidence[0]!.occurredAt, "2026-09-14");
    assert.equal(h.arena.arena().entries.length, 0);
    assert.throws(() => h.arena.entry(result.entry.entryId), status(404));
    assert.throws(() => h.arena.entry(result.entry.entryId, owner), status(404));
    assert.equal(h.arena.me(owner).entries[0]!.entry.summary, input.draft.summary);
    assert.equal(h.arena.me(other).entries.length, 0);
    assert.throws(() => h.arena.participation(other, result.entry.entryId, { optedIn: true }), status(404));
    const published = h.arena.participation(owner, result.entry.entryId, { optedIn: true });
    assert.equal(published.optedIn, true);
    assert.equal(h.arena.entry(result.entry.entryId).publicSummary, null);
    assert.equal(JSON.stringify(h.arena.arena()).includes("PRIVATE-EVIDENCE"), false);
    assert.deepEqual(h.arena.me(owner).entries[0]!.entry, result.entry.entry, "opt-in cannot mutate the snapshot");
  } finally { h.close(); }
});

test("idempotent submissions preserve exact approval and reject new content under an old request ID", () => {
  const h = harness();
  try {
    const owner = h.newPlayer(), input = submission("replay");
    const first = h.arena.submitEntry(owner, input).entry;
    h.setTime(START + DAY + 1);
    assert.deepEqual(h.arena.submitEntry(owner, input), { created: false, entry: first });
    assert.throws(() => h.arena.submitEntry(owner, { ...input, publicSummary: { text: "Changed publication", approved: true } }), status(409));
    assert.throws(() => h.arena.submitEntry(owner, { ...input, optedIn: false }), status(409));
    assert.equal(h.arena.me(owner).entries[0]!.publicSummary, "Approved public replay");
    assert.equal(h.arena.me(owner).entries.length, 1);
  } finally { h.close(); }
});

test("identical work cannot refresh via new IDs, ordering, whitespace, window or publication text", () => {
  const h = harness();
  try {
    const owner = h.newPlayer(), input = submission("dedup");
    input.draft.evidence.push({ id: "e2", kind: "artifact", excerpt: "Second private artifact", occurredAt: "2026-09-13" });
    input.draft.accomplishments[0]!.evidenceIds.push("e2");
    h.arena.submitEntry(owner, input);
    const changed = structuredClone(input);
    changed.requestId = randomUUID();
    changed.publicSummary = { text: "Different approved public description", approved: true };
    changed.draft.summary = `  ${changed.draft.summary.replaceAll(" ", "  ")}  `;
    changed.draft.accomplishments[0]!.id = "renamed-outcome";
    changed.draft.evidence[0]!.id = "renamed-evidence";
    changed.draft.accomplishments[0]!.evidenceIds = ["e2", "renamed-evidence"];
    changed.draft.evidence.reverse();
    h.setTime(START + 60_000);
    changed.draft.window = draft("unused", START + 60_000).window;
    assert.throws(() => h.arena.submitEntry(owner, changed), status(409));
    assert.equal(h.arena.me(owner).entries.length, 1);
    assert.equal(h.arena.me(owner).entries[0]!.publicSummary, "Approved public dedup");
  } finally { h.close(); }
});

test("rejects missing approval, supplied metadata, insufficient context, stale/future windows and incorrect duration", () => {
  const h = harness();
  try {
    const owner = h.newPlayer();
    const invalid: unknown[] = [
      { ...submission("x"), refereeApproved: false },
      { ...submission("x"), refereeApproved: "true" },
      { ...submission("x"), publicSummary: { text: "Unapproved", approved: false } },
      { ...submission("x"), publicSummary: { text: "Timestamp injection", approved: true, approvedAt: "2020-01-01T00:00:00.000Z" } },
      { ...submission("x"), draft: { ...draft("x"), participantId: owner } },
      { ...submission("x"), draft: { ...draft("x"), publicSummary: "accidentally public" } },
      { ...submission("x"), draft: { version: "antislop.entry-draft.v1", status: "insufficient_context", window: draft("x").window, reason: "no_dated_evidence" } },
      { ...submission("x"), draft: { ...draft("x"), window: { ...draft("x").window, startsAt: new Date(START - 6 * DAY).toISOString() } } },
      { ...submission("x"), requestId: "bad\n" },
    ];
    for (const value of invalid) assert.throws(() => h.arena.submitEntry(owner, value), status(400));
    assert.throws(() => h.arena.submitEntry(owner, submission("future", { draft: draft("future", START + 1) })), status(409));
    assert.throws(() => h.arena.submitEntry(owner, submission("stale", { draft: draft("stale", START - DAY - 1) })), status(409));
    assert.equal(h.arena.submitEntry(owner, submission("boundary", { draft: draft("boundary", START - DAY) })).created, true);
  } finally { h.close(); }
});

test("duel creation, claim and settle persist once; public results never include private material or change legacy Elo", () => {
  const h = harness();
  try {
    const p = pair(h), other = h.newPlayer();
    for (const [id, formScore] of [[p.a, 800], [p.b, 700]] as const) h.legacy.assessment(id, { weekId: h.legacy.currentWeek(), formScore, coveragePpm: 900_000, certaintyPpm: 900_000 });
    h.legacy.joinQueue(p.a, "scalar"); h.legacy.joinQueue(p.b, "scalar");
    const legacyA = h.legacy.me(p.a), legacyB = h.legacy.me(p.b);
    assert.equal(p.duel.state, "pending");
    assert.equal(p.duel.canJudge, true);
    assert.equal(h.arena.duel(p.duel.duelId).canJudge, false);
    assert.equal(h.arena.duel(p.duel.duelId, other).canJudge, false);
    assert.throws(() => h.arena.claim(other, p.duel.duelId), status(403));
    const claim = h.arena.claim(p.b, p.duel.duelId);
    assert.equal(Date.parse(claim.leaseExpiresAt) - START, 90_000);
    assert.equal(claim.packets.ab.order, "ab"); assert.equal(claim.packets.ba.order, "ba");
    for (const packet of Object.values(claim.packets)) {
      assert.equal(JSON.stringify(packet).includes(p.a), false);
      assert.equal(JSON.stringify(packet).includes(p.entryA.entryId), false);
      assert.equal(JSON.stringify(packet).includes("Approved public"), false);
    }
    assert.throws(() => h.arena.claim(p.a, p.duel.duelId), status(409));
    const input = settlement(claim);
    assert.throws(() => h.arena.settle(p.a, p.duel.duelId, input), status(409), "lease belongs to claimant account");
    assert.throws(() => h.arena.settle(p.b, p.duel.duelId, { ...input, leaseToken: "a".repeat(64) }), status(409));
    const completed = h.arena.settle(p.b, p.duel.duelId, input);
    assert.equal(completed.state, "complete"); assert.equal(completed.outcome, "a_wins"); assert.equal(completed.ratingEligible, false);
    assert.equal(completed.reason, "order_agreement"); assert.equal(completed.canJudge, false);
    assert.deepEqual(h.arena.settle(p.b, p.duel.duelId, input), completed);
    assert.throws(() => h.arena.settle(p.b, p.duel.duelId, settlement(claim, "draw", "draw")), status(409));
    assert.throws(() => h.arena.fail(p.b, p.duel.duelId, { leaseToken: claim.leaseToken, reason: "referee_failed" }), status(409));
    for (const exposed of [completed, h.arena.arena(), h.arena.entry(p.entryA.entryId), h.arena.duel(p.duel.duelId)]) {
      assert.equal(JSON.stringify(exposed).includes("PRIVATE-EVIDENCE"), false);
      assert.equal(JSON.stringify(exposed).includes("PRIVATE-VERDICT"), false);
      assert.equal(JSON.stringify(exposed).includes(claim.leaseToken), false);
    }
    assert.equal(JSON.stringify(h.arena.me(p.a)).includes("PRIVATE-EVIDENCE-pair-b"), false);
    assert.equal(JSON.stringify(h.arena.me(p.a)).includes("PRIVATE-VERDICT"), false);
    assert.deepEqual(h.legacy.me(p.a), legacyA); assert.deepEqual(h.legacy.me(p.b), legacyB);
    h.reopen();
    assert.deepEqual(h.arena.duel(p.duel.duelId), { ...completed, canJudge: false });
    assert.equal(h.arena.me(p.a).quota.used, 1);
    const db = h.inspect();
    try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM antislop_judge_runs").get()!.n, 2); }
    finally { db.close(); }
  } finally { h.close(); }
});

test("duel stats use current public Form and scalar Elo without changing the completed referee result", () => {
  const h = harness();
  try {
    const p = pair(h, "current-stats");
    const seed = { formScore: null, ratingMilli: 1_200_000, ratedMatches: 0 };
    assert.deepEqual(p.duel.playerStats, { a: seed, b: seed });
    const claim = h.arena.claim(p.a, p.duel.duelId);
    const completed = h.arena.settle(p.a, p.duel.duelId, settlement(claim));
    for (const [id, formScore] of [[p.a, 873], [p.b, 694]] as const) {
      h.legacy.assessment(id, { weekId: h.legacy.currentWeek(), formScore, coveragePpm: 900_000, certaintyPpm: 900_000 });
    }
    assert.deepEqual(h.arena.duel(p.duel.duelId).playerStats, {
      a: { formScore: 873, ratingMilli: 1_200_000, ratedMatches: 0 },
      b: { formScore: 694, ratingMilli: 1_200_000, ratedMatches: 0 },
    });
    for (const mode of ["scalar", "binary"] as const) {
      h.legacy.joinQueue(p.a, mode); h.legacy.joinQueue(p.b, mode);
    }
    const standings = h.legacy.overview("scalar").players;
    const a = standings.find(item => item.id === p.a)!, b = standings.find(item => item.id === p.b)!;
    const expected = {
      a: { formScore: 873, ratingMilli: a.ratingMilli, ratedMatches: 1 },
      b: { formScore: 694, ratingMilli: b.ratingMilli, ratedMatches: 1 },
    };
    assert.ok(a.ratingMilli > 1_200_000); assert.ok(b.ratingMilli < 1_200_000);
    assert.notEqual(a.ratingMilli, h.legacy.me(p.a).player.receipt!.elo.binary.rating_milli);
    const refreshed = h.arena.duel(p.duel.duelId);
    assert.deepEqual(refreshed, { ...completed, playerStats: expected });
    assert.deepEqual(h.arena.arena().duels[0]!.playerStats, expected);
    assert.deepEqual(h.arena.me(p.b).duels[0]!.playerStats, expected);
    h.reopen();
    assert.deepEqual(h.arena.duel(p.duel.duelId), refreshed);
    assert.deepEqual(h.arena.settle(p.a, p.duel.duelId, settlement(claim)), refreshed);
  } finally { h.close(); }
});

test("duel stats reject a valid public receipt attached to the wrong player", () => {
  const h = harness();
  try {
    const p = pair(h, "stats-integrity");
    h.legacy.assessment(p.a, { weekId: h.legacy.currentWeek(), formScore: 873, coveragePpm: 900_000, certaintyPpm: 900_000 });
    const db = new DatabaseSync(h.databasePath);
    try { db.prepare("UPDATE players SET receipt=(SELECT receipt FROM players WHERE id=?) WHERE id=?").run(p.a, p.b); }
    finally { db.close(); }
    assert.throws(() => h.legacy.me(p.b), /Player receipt integrity failure/);
    assert.throws(() => h.arena.duel(p.duel.duelId), /Player receipt integrity failure/);
  } finally { h.close(); }
});

test("order disagreement and referee abstention remain different from provider failure", () => {
  const h = harness();
  try {
    for (const [ab, ba, state, reason] of [
      ["a_wins", "a_wins", "complete", "order_disagreement"],
      ["unrated", "unrated", "complete", "referee_abstained"],
      ["draw", "draw", "complete", "order_agreement"],
    ] as const) {
      const p = pair(h, reason), claim = h.arena.claim(p.a, p.duel.duelId);
      const result = h.arena.settle(p.a, p.duel.duelId, settlement(claim, ab, ba));
      assert.equal(result.state, state); assert.equal(result.reason, reason);
      assert.equal(result.outcome, ab === "draw" ? "draw" : "unrated");
    }
    const p = pair(h, "provider-failure"), claim = h.arena.claim(p.a, p.duel.duelId);
    const input = { leaseToken: claim.leaseToken, reason: "referee_failed" };
    const failed = h.arena.fail(p.a, p.duel.duelId, input);
    assert.equal(failed.state, "failed"); assert.equal(failed.outcome, "unrated"); assert.equal(failed.reason, "referee_failed");
    assert.deepEqual(h.arena.fail(p.a, p.duel.duelId, input), failed);
    assert.throws(() => h.arena.claim(p.a, p.duel.duelId), status(409));
  } finally { h.close(); }
});

test("rejects spoofed judge, wrong pair/order, unknown evidence and extra verdict fields before settlement", () => {
  const h = harness();
  try {
    const p = pair(h), claim = h.arena.claim(p.a, p.duel.duelId);
    const bad = [
      { ...settlement(claim), responseAB: { ...response(claim, "ab", "a_wins"), judgeFingerprint: `sha256:${"0".repeat(64)}` } },
      { ...settlement(claim), responseAB: { ...response(claim, "ab", "a_wins"), pairFingerprint: `sha256:${"0".repeat(64)}` } },
      { ...settlement(claim), responseAB: response(claim, "ba", "a_wins") },
      { ...settlement(claim), responseAB: { ...response(claim, "ab", "a_wins"), verdict: { outcome: "a_wins", reason: "stronger_work", explanation: "private", evidenceRefs: { a: ["e99"], b: ["e1"] } } } },
      { ...settlement(claim), responseAB: { ...response(claim, "ab", "a_wins"), verdict: { outcome: "a_wins", reason: "stronger_work", explanation: "private", evidenceRefs: { a: ["e1"], b: ["e1"] }, secret: "extra" } } },
    ];
    for (const input of bad) assert.throws(() => h.arena.settle(p.a, p.duel.duelId, input), status(400));
    assert.equal(h.arena.duel(p.duel.duelId).state, "judging");
    const db = h.inspect(); try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM antislop_judge_runs").get()!.n, 0); } finally { db.close(); }
    assert.equal(h.arena.settle(p.a, p.duel.duelId, settlement(claim)).state, "complete");
  } finally { h.close(); }
});

test("unordered pair and request replay reuse a duel across independent connections", () => {
  const h = harness();
  const second = h.second();
  try {
    const p = pair(h);
    assert.equal(second.createDuel(p.a, p.request).created, false);
    const reversed = second.createDuel(p.b, { requestId: randomUUID(), entryId: p.entryB.entryId, opponentEntryId: p.entryA.entryId });
    assert.equal(reversed.created, false); assert.equal(reversed.duel.duelId, p.duel.duelId);
    assert.equal(h.arena.me(p.a).quota.used, 1); assert.equal(h.arena.me(p.b).quota.used, 1);
    assert.throws(() => second.createDuel(p.a, { ...p.request, opponentEntryId: p.entryA.entryId }), status(409));
    const claim = h.arena.claim(p.a, p.duel.duelId);
    assert.throws(() => second.claim(p.b, p.duel.duelId), status(409));
    h.arena.fail(p.a, p.duel.duelId, { leaseToken: claim.leaseToken, reason: "referee_failed" });
    h.arena.participation(p.b, p.entryB.entryId, { optedIn: false });
    const replay = second.createDuel(p.a, { ...p.request, requestId: randomUUID() });
    assert.equal(replay.duel.state, "failed"); assert.equal(replay.created, false);
    assert.equal(h.arena.me(p.a).quota.used, 1);
  } finally { second.close(); h.close(); }
});

test("stale pending and judging leases expire once without reroll, release in-flight slots and retain quota", () => {
  const h = harness();
  try {
    const pending = pair(h, "pending");
    h.setTime(START + 120_000);
    assert.equal(h.arena.duel(pending.duel.duelId).state, "failed");
    assert.equal(h.arena.me(pending.a).quota.inFlight, 0);
    assert.equal(h.arena.me(pending.a).quota.used, 1);
    assert.throws(() => h.arena.claim(pending.a, pending.duel.duelId), status(409));
    h.setTime(START);
    const judging = pair(h, "judging"), claim = h.arena.claim(judging.a, judging.duel.duelId);
    h.setTime(START + 90_000);
    assert.throws(() => h.arena.settle(judging.a, judging.duel.duelId, settlement(claim)), status(409));
    const expired = h.arena.duel(judging.duel.duelId);
    assert.equal(expired.state, "failed"); assert.equal(expired.reason, "referee_timed_out");
    assert.equal(expired.canJudge, false);
    h.reopen(); assert.throws(() => h.arena.claim(judging.a, judging.duel.duelId), status(409));
  } finally { h.close(); }
});

test("ownership, self-match, opt-in, freshness and in-flight checks hold at admission", () => {
  const h = harness();
  try {
    const a = h.newPlayer(), b = h.newPlayer(), c = h.newPlayer();
    const ea = h.arena.submitEntry(a, submission("a")).entry, eb = h.arena.submitEntry(b, submission("b", { optedIn: false })).entry,
      ec = h.arena.submitEntry(c, submission("c")).entry;
    const request = () => ({ requestId: randomUUID(), entryId: ea.entryId, opponentEntryId: eb.entryId });
    assert.throws(() => h.arena.createDuel(c, request()), status(403));
    assert.throws(() => h.arena.createDuel(a, { ...request(), opponentEntryId: ea.entryId }), status(409));
    assert.throws(() => h.arena.createDuel(a, request()), status(409));
    h.arena.participation(b, eb.entryId, { optedIn: true });
    const first = h.arena.createDuel(a, request()).duel;
    assert.throws(() => h.arena.createDuel(c, { requestId: randomUUID(), entryId: ec.entryId, opponentEntryId: ea.entryId }), status(409));
    const claim = h.arena.claim(a, first.duelId); h.arena.fail(a, first.duelId, { leaseToken: claim.leaseToken, reason: "referee_failed" });
    h.setTime(START + DAY + 1);
    assert.throws(() => h.arena.createDuel(c, { requestId: randomUUID(), entryId: ec.entryId, opponentEntryId: ea.entryId }), status(409));
    assert.equal(h.arena.arena().entries.length, 0);
    assert.throws(() => h.arena.participation(a, ea.entryId, { optedIn: true }), status(409));
  } finally { h.close(); }
});

test("ten daily participant reservations persist across restart and include failed duels", () => {
  const h = harness();
  try {
    const owner = h.newPlayer(), entry = h.arena.submitEntry(owner, submission("quota-owner")).entry;
    for (let index = 0; index < 11; index++) {
      const opponent = h.newPlayer(), other = h.arena.submitEntry(opponent, submission(`quota-${index}`)).entry;
      const input = { requestId: randomUUID(), entryId: entry.entryId, opponentEntryId: other.entryId };
      if (index === 10) { assert.throws(() => h.arena.createDuel(owner, input), status(429)); break; }
      const duel = h.arena.createDuel(owner, input).duel, claim = h.arena.claim(owner, duel.duelId);
      h.arena.fail(owner, duel.duelId, { leaseToken: claim.leaseToken, reason: "referee_failed" });
      if (index === 4) h.reopen();
    }
    assert.deepEqual(h.arena.me(owner).quota, { day: "2026-09-15", used: 10, remaining: 0, inFlight: 0 });
  } finally { h.close(); }
});

test("shared daily admission budget is persisted before any external call", () => {
  const h = harness();
  try {
    for (let index = 0; index < 100; index++) pair(h, `global-${index}`);
    h.reopen();
    const a = h.newPlayer(), b = h.newPlayer();
    const ea = h.arena.submitEntry(a, submission("global-over-a")).entry, eb = h.arena.submitEntry(b, submission("global-over-b")).entry;
    assert.throws(() => h.arena.createDuel(a, { requestId: randomUUID(), entryId: ea.entryId, opponentEntryId: eb.entryId }), status(429));
    const db = h.inspect();
    try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM antislop_duels").get()!.n, 100); assert.equal(db.prepare("SELECT COUNT(*) AS n FROM antislop_judge_runs").get()!.n, 0); }
    finally { db.close(); }
  } finally { h.close(); }
});

test("transaction failure rolls back submission, admission, claim and settlement", () => {
  const h = harness();
  try {
    const owner = h.newPlayer(), input = submission("rollback");
    h.setFault("submitAntislopEntry"); assert.throws(() => h.arena.submitEntry(owner, input), /injected/);
    h.setFault(""); assert.equal(h.arena.me(owner).entries.length, 0);
    const p = pair(h, "rollback-pair");
    h.setFault("claimAntislopDuel"); assert.throws(() => h.arena.claim(p.a, p.duel.duelId), /injected/);
    h.setFault(""); assert.equal(h.arena.duel(p.duel.duelId).state, "pending");
    const claim = h.arena.claim(p.a, p.duel.duelId);
    h.setFault("settleAntislopDuel"); assert.throws(() => h.arena.settle(p.a, p.duel.duelId, settlement(claim)), /injected/);
    h.setFault(""); assert.equal(h.arena.duel(p.duel.duelId).state, "judging");
    const db = h.inspect(); try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM antislop_judge_runs").get()!.n, 0); } finally { db.close(); }
    assert.equal(h.arena.settle(p.a, p.duel.duelId, settlement(claim)).state, "complete");
    const third = h.newPlayer(), thirdEntry = h.arena.submitEntry(third, submission("rollback-third")).entry;
    const next = { requestId: randomUUID(), entryId: p.entryA.entryId, opponentEntryId: thirdEntry.entryId };
    h.setFault("createAntislopDuel"); assert.throws(() => h.arena.createDuel(p.a, next), /injected/);
    h.setFault(""); assert.equal(h.arena.me(p.a).quota.used, 1); assert.equal(h.arena.me(third).quota.used, 0);
    assert.equal(h.arena.createDuel(p.a, next).created, true);
  } finally { h.close(); }
});

test("season config drift is rejected and frozen snapshot corruption is detected", () => {
  const h = harness();
  try {
    assert.throws(() => createAntislopStore({ databasePath: h.databasePath, judgeConfig: { ...LIVE_JUDGE_CONFIG, maxOutputTokens: 256 } }), /configuration changed/);
    const owner = h.newPlayer(), entry = h.arena.submitEntry(owner, submission("integrity")).entry;
    const db = new DatabaseSync(h.databasePath);
    const tampered = { ...entry.entry, summary: "Silent rewrite" };
    db.prepare("UPDATE antislop_entries SET snapshot_json=? WHERE id=?").run(JSON.stringify(tampered), entry.entryId); db.close();
    assert.throws(() => h.arena.entry(entry.entryId), /integrity failure/);
  } finally { h.close(); }
});

test("new private evidence expires at seven days while approved public history and fingerprints persist", () => {
  const h = harness();
  try {
    const p = pair(h, "retention"), claim = h.arena.claim(p.a, p.duel.duelId), input = settlement(claim);
    const completed = h.arena.settle(p.a, p.duel.duelId, input);
    const legacyBefore = h.legacy.me(p.a);
    const db = h.inspect();
    const before = db.prepare("SELECT fingerprint,content_hash FROM antislop_entries WHERE id=?").get(p.entryA.entryId);
    db.close();
    h.setTime(START + 7 * DAY - 1);
    assert.equal(h.arena.me(p.a).entries.length, 1);
    h.setTime(START + 7 * DAY);
    h.arena.prunePrivateEvidence();
    assert.equal(h.arena.me(p.a).entries.length, 0);
    assert.equal(h.arena.me(p.b).entries.length, 0);
    assert.equal(h.arena.entry(p.entryA.entryId).publicSummary, "Approved public retention-a");
    assert.equal(h.arena.entry(p.entryA.entryId).optedIn, false);
    const after = h.arena.duel(p.duel.duelId);
    assert.equal(after.outcome, completed.outcome); assert.equal(after.judgeFingerprint, completed.judgeFingerprint);
    assert.equal(after.completedAt, completed.completedAt); assert.deepEqual(after.playerStats, completed.playerStats);
    assert.deepEqual(h.legacy.me(p.a).player, legacyBefore.player);
    assert.throws(() => h.arena.settle(p.a, p.duel.duelId, input), status(410));
    const inspect = h.inspect();
    try {
      assert.equal(inspect.prepare("SELECT COUNT(*) n FROM antislop_entries WHERE snapshot_json='null' AND private_erased_at=?").get(START + 7 * DAY)!.n, 2);
      assert.equal(inspect.prepare("SELECT COUNT(*) n FROM antislop_judge_runs WHERE verdict_json='null'").get()!.n, 2);
      assert.deepEqual(inspect.prepare("SELECT fingerprint,content_hash FROM antislop_entries WHERE id=?").get(p.entryA.entryId), before);
      assert.equal(inspect.prepare("SELECT COUNT(*) n FROM antislop_requests").get()!.n, 3);
    } finally { inspect.close(); }
    h.reopen(); assert.equal(h.arena.duel(p.duel.duelId).outcome, completed.outcome);
  } finally { h.close(); }
});

test("additive migration preserves historical private payloads with null deadlines until owner erasure", () => {
  const h = harness();
  try {
    const p = pair(h, "historical"), claim = h.arena.claim(p.a, p.duel.duelId);
    h.arena.settle(p.a, p.duel.duelId, settlement(claim));
    const later = START + 366 * DAY;
    h.setTime(later); h.reopenFromLegacySchema();
    assert.equal(h.arena.me(p.a).entries[0]!.entry.summary, p.entryA.entry.summary);
    assert.equal(h.arena.duel(p.duel.duelId).outcome, "a_wins");
    const inspect = h.inspect();
    try {
      assert.equal(inspect.prepare("SELECT COUNT(*) n FROM antislop_entries WHERE private_expires_at IS NULL AND snapshot_json<>'null'").get()!.n, 2);
      assert.equal(inspect.prepare("SELECT COUNT(*) n FROM antislop_judge_runs WHERE private_expires_at IS NULL AND verdict_json<>'null'").get()!.n, 2);
    } finally { inspect.close(); }
    const recent = h.arena.submitEntry(p.a, submission("post-migration", { draft: draft("post-migration", later) })).entry;
    h.setTime(later + 7 * DAY); h.reopen();
    assert.deepEqual(h.arena.me(p.a).entries.map(entry => entry.entryId), [p.entryA.entryId]);
    assert.equal(h.arena.entry(recent.entryId).publicSummary, "Approved public post-migration");
    assert.deepEqual(h.arena.erasePrivateEvidence(p.a), { erased: true });
    assert.equal(h.arena.me(p.a).entries.length, 0);
    assert.equal(h.arena.me(p.b).entries[0]!.entry.summary, p.entryB.entry.summary);
    const erased = h.inspect();
    try { assert.equal(erased.prepare("SELECT COUNT(*) n FROM antislop_judge_runs WHERE verdict_json='null'").get()!.n, 2); }
    finally { erased.close(); }
    h.reopen(); assert.equal(h.arena.duel(p.duel.duelId).outcome, "a_wins");
  } finally { h.close(); }
});

test("new verdicts on historical entries have their own completion deadline", () => {
  const h = harness();
  try {
    const p = pair(h, "verdict-deadline");
    h.reopenFromLegacySchema();
    h.setTime(START + 1000);
    const claim = h.arena.claim(p.a, p.duel.duelId);
    h.arena.settle(p.a, p.duel.duelId, settlement(claim));
    h.setTime(START + 7 * DAY + 999); h.arena.prunePrivateEvidence();
    let db = h.inspect();
    try { assert.equal(db.prepare("SELECT COUNT(*) n FROM antislop_judge_runs WHERE verdict_json<>'null'").get()!.n, 2); } finally { db.close(); }
    h.setTime(START + 7 * DAY + 1000); h.arena.prunePrivateEvidence();
    db = h.inspect();
    try { assert.equal(db.prepare("SELECT COUNT(*) n FROM antislop_judge_runs WHERE verdict_json='null'").get()!.n, 2); } finally { db.close(); }
    assert.equal(h.arena.me(p.a).entries.length, 1, "the historical entry has no implicit deadline");
  } finally { h.close(); }
});

test("owner erasure covers hidden entries, preserves other owners and cannot be undone by request replay", () => {
  const h = harness();
  try {
    const owner = h.newPlayer(), other = h.newPlayer(), first = submission("hidden-0");
    for (let index = 0; index < 23; index++) {
      const at = START + Math.floor(index / 10) * DAY; h.setTime(at);
      h.arena.submitEntry(owner, index === 0 ? first : submission(`hidden-${index}`, { draft: draft(`hidden-${index}`, at) }));
    }
    const otherEntry = h.arena.submitEntry(other, submission("keep-other", { draft: draft("keep-other", START + 2 * DAY) })).entry;
    assert.equal(h.arena.me(owner).entries.length, 20);
    assert.deepEqual(h.arena.erasePrivateEvidence(owner), { erased: true });
    assert.deepEqual(h.arena.erasePrivateEvidence(owner), { erased: true });
    assert.equal(h.arena.me(owner).entries.length, 0);
    assert.equal(h.arena.me(other).entries[0]!.entryId, otherEntry.entryId);
    assert.throws(() => h.arena.submitEntry(owner, first), status(410));
    assert.throws(() => h.arena.submitEntry(owner, { ...first, requestId: randomUUID(), draft: { ...first.draft, window: draft("unused", START + 2 * DAY).window } }), status(409));
    const db = h.inspect();
    try {
      assert.equal(db.prepare("SELECT COUNT(*) n FROM antislop_entries WHERE player_id=? AND snapshot_json='null'").get(owner)!.n, 23);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM antislop_entry_participation p JOIN antislop_entries e ON e.id=p.entry_id WHERE e.player_id=? AND p.opted_in=1").get(owner)!.n, 0);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM antislop_requests WHERE player_id=?").get(owner)!.n, 23);
    } finally { db.close(); }
    h.reopen(); assert.equal(h.arena.me(owner).entries.length, 0);
  } finally { h.close(); }
});

test("owner erasure refuses live pending or judging duels without deleting any entries", () => {
  const h = harness(), second = h.second();
  try {
    const p = pair(h, "active-erasure"); h.arena.submitEntry(p.a, submission("extra-erasure"));
    assert.throws(() => second.erasePrivateEvidence(p.a), status(409));
    assert.equal(h.arena.me(p.a).entries.length, 2);
    const claim = second.claim(p.b, p.duel.duelId);
    assert.throws(() => h.arena.erasePrivateEvidence(p.a), status(409));
    assert.equal(second.me(p.a).entries.length, 2);
    h.setTime(START + 90_000);
    assert.deepEqual(h.arena.erasePrivateEvidence(p.a), { erased: true });
    assert.equal(second.duel(p.duel.duelId).state, "failed");
    assert.equal(second.me(p.a).entries.length, 0);
    assert.equal(second.me(p.b).entries.length, 1);
    assert.throws(() => second.settle(p.b, p.duel.duelId, settlement(claim)), status(410));
    assert.equal(second.me(p.a).quota.used, 1); assert.equal(second.me(p.b).quota.used, 1);
  } finally { second.close(); h.close(); }
});

test("erasure and retention failures roll back snapshots, verdicts and participation together", () => {
  const h = harness();
  try {
    const p = pair(h, "erase-rollback"), claim = h.arena.claim(p.a, p.duel.duelId);
    h.arena.settle(p.a, p.duel.duelId, settlement(claim));
    h.setFault("eraseAntislopEvidence"); assert.throws(() => h.arena.erasePrivateEvidence(p.a), /injected/); h.setFault("");
    assert.equal(h.arena.me(p.a).entries.length, 1); assert.equal(h.arena.entry(p.entryA.entryId).optedIn, true);
    let db = h.inspect();
    try { assert.equal(db.prepare("SELECT COUNT(*) n FROM antislop_judge_runs WHERE verdict_json<>'null'").get()!.n, 2); } finally { db.close(); }
    h.setTime(START + 7 * DAY); h.setFault("pruneAntislopEvidence");
    assert.throws(() => h.arena.prunePrivateEvidence(), /injected/);
    db = h.inspect();
    try { assert.equal(db.prepare("SELECT COUNT(*) n FROM antislop_entries WHERE snapshot_json<>'null'").get()!.n, 2); } finally { db.close(); }
    h.setFault(""); h.arena.prunePrivateEvidence(); assert.equal(h.arena.me(p.a).entries.length, 0);
    db = new DatabaseSync(h.databasePath);
    db.prepare("UPDATE antislop_entries SET public_json=replace(public_json,'Approved public','PRIVATE CORRUPTION') WHERE id=?").run(p.entryA.entryId); db.close();
    assert.throws(() => h.arena.entry(p.entryA.entryId), /integrity failure/);
  } finally { h.close(); }
});

test("unclaimed incoming timeouts release recipient quota but still consume initiator and global budgets", () => {
  const h = harness();
  try {
    const attacker = h.newPlayer(), target = h.newPlayer(), friend = h.newPlayer();
    const targetEntry = h.arena.submitEntry(target, submission("quota-target")).entry;
    const friendEntry = h.arena.submitEntry(friend, submission("quota-friend")).entry;
    for (let index = 0; index < 10; index++) {
      const entry = h.arena.submitEntry(attacker, submission(`incoming-${index}`)).entry;
      h.arena.createDuel(attacker, { requestId: randomUUID(), entryId: entry.entryId, opponentEntryId: targetEntry.entryId });
      assert.equal(h.arena.me(target).quota.used, 1); assert.equal(h.arena.me(target).quota.inFlight, 1);
      h.setTime(START + (index + 1) * 120_001);
      assert.equal(h.arena.me(target).quota.used, 0); assert.equal(h.arena.me(target).quota.inFlight, 0);
    }
    h.reopen();
    assert.equal(h.arena.me(attacker).quota.used, 10); assert.equal(h.arena.me(target).quota.remaining, 10);
    const db = h.inspect();
    try {
      assert.equal(db.prepare("SELECT COUNT(*) n FROM antislop_duels").get()!.n, 10);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM antislop_judge_runs").get()!.n, 0);
    } finally { db.close(); }
    const legitimate = h.arena.createDuel(target, { requestId: randomUUID(), entryId: targetEntry.entryId, opponentEntryId: friendEntry.entryId }).duel;
    const claim = h.arena.claim(target, legitimate.duelId);
    h.arena.fail(target, legitimate.duelId, { leaseToken: claim.leaseToken, reason: "referee_failed" });
    assert.equal(h.arena.me(target).quota.used, 1); assert.equal(h.arena.me(friend).quota.used, 1);
  } finally { h.close(); }
});

// Start independent processes at a barrier, so SQLite—not JavaScript call order—
// decides which authorization transition wins.
async function raceErasure(databasePath: string, jobs: Record<string, unknown>[]) {
  const source = `import{createAntislopStore}from ${JSON.stringify(new URL("../antislop/store.ts", import.meta.url).href)};
    const store=createAntislopStore({databasePath:process.argv[1],now:()=>new Date(${START})});
    console.log('READY');let raw='';for await(const part of process.stdin)raw+=part;
    try{const job=JSON.parse(raw);const value=job.kind==='erase'?store.erasePrivateEvidence(job.id):store.createDuel(job.id,job.input);
      console.log(JSON.stringify({ok:true,value}));}catch(error){console.log(JSON.stringify({ok:false,status:error.status??500}));}finally{store.close();}`;
  const children = jobs.map(job => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source, databasePath], { cwd: resolve(import.meta.dirname, "../../.."), stdio: ["pipe", "pipe", "pipe"] });
    let resolveReady!: () => void, rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    let output = "", errors = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", data => { output += data; if (output.includes("READY\n")) resolveReady(); });
    child.stderr.on("data", data => { errors += data; });
    const result = new Promise<{ ok: boolean; status?: number }>((resolve, reject) => {
      child.on("error", error => { rejectReady(error); reject(error); });
      child.on("exit", code => {
        if (code !== 0) { const error = new Error(`SQLite privacy worker ${code}: ${errors.slice(0, 300)}`); rejectReady(error); reject(error); return; }
        try { resolve(JSON.parse(output.trim().split("\n").at(-1)!)); } catch { reject(new Error("Invalid privacy worker output")); }
      });
    });
    void result.catch(() => {});
    return { child, job, ready, result };
  });
  const deadline = setTimeout(() => { for (const { child } of children) child.kill("SIGKILL"); }, 12_000);
  try {
    await Promise.all(children.map(worker => worker.ready));
    for (const worker of children) worker.child.stdin.end(JSON.stringify(worker.job));
    return await Promise.all(children.map(worker => worker.result));
  } finally { clearTimeout(deadline); for (const { child } of children) if (child.exitCode === null) child.kill("SIGKILL"); }
}

test("concurrent owner erasure and challenge admission cannot both succeed", { timeout: 15_000 }, async () => {
  const h = harness();
  try {
    const a = h.newPlayer(), b = h.newPlayer();
    const ea = h.arena.submitEntry(a, submission("race-a")).entry, eb = h.arena.submitEntry(b, submission("race-b")).entry;
    const results = await raceErasure(h.databasePath, [
      { kind: "erase", id: b },
      { kind: "duel", id: a, input: { requestId: randomUUID(), entryId: ea.entryId, opponentEntryId: eb.entryId } },
    ]);
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.equal(results.find(result => !result.ok)!.status, 409);
    const entries = h.arena.me(b).entries;
    if (results[0]!.ok) { assert.equal(entries.length, 0); assert.equal(h.arena.me(a).duels.length, 0); }
    else { assert.equal(entries.length, 1); assert.equal(h.arena.me(a).duels[0]!.state, "pending"); }
  } finally { h.close(); }
});
