import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildPlayerReceipt, validatePlayerReceipt } from "../../../packages/elo-engine/src/receipts.ts";
import { AI_SYSTEMS, CONTEXT_SOURCES, parseAssessmentContext, type AssessmentContext } from "../../../packages/public-api/assessment-context.ts";
import { createApiServer } from "../http.ts";
import { ApiError, createStore, type StoreOptions } from "../store.ts";

const DATE = new Date("2026-09-14T12:00:00Z");
const WEEK = "2026-W37";
const aggregate = { weekId: WEEK, formScore: 800, coveragePpm: 800000, certaintyPpm: 900000 };
const context: AssessmentContext = { aiSystem: "chatgpt", contextSource: "current_chat" };
const token = () => randomBytes(32).toString("hex");
const fails = (status: number) => (error: unknown) => error instanceof ApiError && error.status === status;

function fixture(options: Omit<StoreOptions, "databasePath"> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "elo-context-"));
  const databasePath = join(directory, "league.sqlite");
  let store = createStore({ databasePath, now: () => DATE, ...options });
  const db = new DatabaseSync(databasePath);
  return {
    databasePath, db, get store() { return store; },
    restart() { store.close(); store = createStore({ databasePath, now: () => DATE, ...options }); },
    counts() { return Object.fromEntries(["receipts", "imports", "assessment_context"].map(table => [table, Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n)])); },
    close() { db.close(); store.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test("assessment context accepts only two own category fields without evaluating accessors", () => {
  for (const aiSystem of Object.keys(AI_SYSTEMS)) {
    for (const contextSource of Object.keys(CONTEXT_SOURCES)) {
      assert.deepEqual(parseAssessmentContext({ aiSystem, contextSource }), { aiSystem, contextSource });
    }
  }
  let reads = 0;
  const getter = { get aiSystem() { reads++; return "chatgpt"; }, contextSource: "current_chat" };
  const hidden = Object.defineProperty({ ...context }, "notes", { value: "PRIVATE_CONTEXT_CANARY" });
  for (const value of [null, [], {}, { aiSystem: "chatgpt" }, { contextSource: "mixed" },
    { ...context, notes: "PRIVATE_CONTEXT_CANARY" }, { ...context, aiSystem: "PRIVATE_CONTEXT_CANARY" },
    { ...context, contextSource: "PRIVATE_CONTEXT_CANARY" }, { ...context, aiSystem: "x".repeat(1000) },
    { ...context, aiSystem: "__proto__" }, { ...context, contextSource: "constructor" },
    { ...context, aiSystem: "ChatGPT" }, { ...context, aiSystem: "сhatgpt" },
    Object.create(context), { ...context, [Symbol("private")]: true }, getter, hidden]) {
    assert.throws(() => parseAssessmentContext(value), { message: "Invalid assessment context." });
  }
  assert.equal(reads, 0);
});

test("HTTP accepts legacy or paired context fields, rejects private inputs, and keeps accounts isolated", async () => {
  const state = fixture();
  const a = state.store.createPlayer("context_http_a", token()), b = state.store.createPlayer("context_http_b", token());
  const server = createApiServer({ store: state.store, serviceKey: "s".repeat(48) });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const call = (path: string, auth?: string, value?: unknown) => fetch(base + path, {
    method: value === undefined ? "GET" : "POST",
    headers: { "x-service-key": "s".repeat(48), "x-client-id": "c".repeat(64), "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
    ...(value === undefined ? {} : { body: typeof value === "string" ? value : JSON.stringify(value) }), signal: AbortSignal.timeout(3000),
  });
  try {
    assert.equal((await call("/v1/assessment", undefined, { ...aggregate, ...context })).status, 401);
    assert.equal((await call("/v1/assessment", b.token, aggregate)).status, 200);
    assert.equal(state.store.me(b.player.id).player.assessmentContext, undefined);
    const before = state.counts();
    for (const patch of [
      { aiSystem: "chatgpt" }, { contextSource: "mixed" },
      { ...context, aiSystem: "PRIVATE_CONTEXT_CANARY" }, { ...context, contextSource: "PRIVATE_CONTEXT_CANARY" },
      { ...context, notes: "PRIVATE_CONTEXT_CANARY" }, { ...context, contextSource: { notes: "PRIVATE_CONTEXT_CANARY" } },
      { ...context, aiSystem: null }, { ...context, playerId: b.player.id },
    ]) {
      const response = await call("/v1/assessment", a.token, { ...aggregate, ...patch });
      assert.equal(response.status, 400);
      assert.ok(!(await response.text()).includes("PRIVATE_CONTEXT_CANARY"));
      assert.deepEqual(state.counts(), before);
    }
    const duplicate = JSON.stringify({ ...aggregate, ...context }).replace('"aiSystem":"chatgpt"', '"aiSystem":"claude","aiSystem":"chatgpt"');
    assert.equal((await call("/v1/assessment", a.token, duplicate)).status, 400);
    const response = await call("/v1/assessment", a.token, { ...aggregate, ...context });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.player.assessmentContext, context);
    validatePlayerReceipt(result.player.receipt);
    assert.equal(result.player.receipt.aiSystem, undefined);
    assert.equal(result.player.receipt.assessmentContext, undefined);
    const publicView = await (await call(`/v1/players/${a.player.id}`)).json();
    assert.deepEqual(publicView.player.assessmentContext, context);
    const other = await (await call("/v1/me", b.token)).json();
    assert.equal(other.player.assessmentContext, undefined);
    assert.equal(other.player.id, b.player.id);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); state.close(); }
});

test("metadata-only changes share the durable revision budget and leave canonical receipt and Elo unchanged", () => {
  let date = DATE;
  const state = fixture({ now: () => date });
  try {
    const a = state.store.createPlayer("context_budget", token());
    const first = state.store.assessment(a.player.id, aggregate).player.receipt!;
    for (const aiSystem of ["chatgpt", "claude", "gemini", "copilot"] as const) {
      const changed = state.store.assessment(a.player.id, { ...aggregate, ...context, aiSystem });
      assert.deepEqual(changed.player.receipt, first);
      const before = state.counts();
      assert.deepEqual(state.store.assessment(a.player.id, { ...aggregate, ...context, aiSystem }), changed);
      assert.deepEqual(state.store.importForm(a.player.id, first), changed);
      assert.deepEqual(state.counts(), before);
    }
    assert.deepEqual(state.counts(), { receipts: 1, imports: 5, assessment_context: 1 });
    const before = state.store.me(a.player.id);
    state.restart();
    assert.deepEqual(state.store.me(a.player.id), before);
    assert.throws(() => state.store.assessment(a.player.id, { ...aggregate, ...context, aiSystem: "codex" }), fails(429));
    assert.throws(() => state.store.assessment(a.player.id, aggregate), fails(429));
    assert.throws(() => state.store.assessment(a.player.id, { ...aggregate, formScore: 801 }), fails(429));
    assert.deepEqual(state.store.me(a.player.id), before);
    date = new Date("2026-09-21T12:00:00Z");
    const next = state.store.assessment(a.player.id, { ...aggregate, weekId: "2026-W38", ...context, aiSystem: "codex" });
    assert.equal(next.player.assessmentContext!.aiSystem, "codex");
    assert.deepEqual(next.player.receipt!.elo, first.elo);
  } finally { state.close(); }
});

test("queue locks metadata changes but permits exact retries and preserves context through both modes", () => {
  const state = fixture();
  try {
    const a = state.store.createPlayer("context_lock_a", token()), b = state.store.createPlayer("context_lock_b", token());
    state.store.assessment(a.player.id, { ...aggregate, ...context });
    state.store.assessment(b.player.id, { ...aggregate, formScore: 700 });
    state.store.joinQueue(a.player.id, "scalar");
    state.store.cancelQueue(a.player.id, "scalar");
    const before = state.counts();
    assert.throws(() => state.store.assessment(a.player.id, { ...aggregate, ...context, contextSource: "saved_memory" }), fails(409));
    assert.throws(() => state.store.assessment(a.player.id, aggregate), fails(409));
    assert.throws(() => state.store.assessment(a.player.id, { ...aggregate, formScore: 801 }), fails(409));
    assert.equal(state.store.assessment(a.player.id, { ...aggregate, ...context }).formLocked, true);
    assert.deepEqual(state.counts(), before);
    for (const mode of ["scalar", "binary"] as const) {
      state.store.joinQueue(a.player.id, mode);
      assert.equal(state.store.joinQueue(b.player.id, mode).status, "matched");
    }
    assert.deepEqual(state.store.me(a.player.id).player.assessmentContext, context);
    assert.equal(state.store.me(b.player.id).player.assessmentContext, undefined);
    assert.deepEqual(state.store.assessment(a.player.id, { ...aggregate, ...context }), state.store.me(a.player.id));
    assert.equal(state.store.me(a.player.id).player.receipt!.elo.scalar.rated_matches, 1);
    assert.equal(state.store.me(a.player.id).player.receipt!.elo.binary.rated_matches, 1);
  } finally { state.close(); }
});

test("assessment transactions roll back receipt, context and budget together", () => {
  let fail = false;
  const state = fixture({ beforeCommit: operation => { if (fail && operation === "importForm") throw new Error("injected context transaction failure"); } });
  try {
    const a = state.store.createPlayer("context_rollback", token());
    fail = true;
    assert.throws(() => state.store.assessment(a.player.id, { ...aggregate, ...context }), /injected/);
    assert.equal(state.store.me(a.player.id).player.receipt, null);
    assert.deepEqual(state.counts(), { receipts: 0, imports: 0, assessment_context: 0 });
    fail = false;
    const before = state.store.assessment(a.player.id, { ...aggregate, ...context });
    const totals = state.counts(); fail = true;
    for (const value of [{ ...aggregate, ...context, aiSystem: "claude" }, { ...aggregate, formScore: 801 }]) {
      assert.throws(() => state.store.assessment(a.player.id, value), /injected/);
      assert.deepEqual(state.store.me(a.player.id), before);
      assert.deepEqual(state.counts(), totals);
    }
    fail = false;
    assert.equal(state.store.assessment(a.player.id, { ...aggregate, formScore: 801 }).player.assessmentContext, undefined);
  } finally { state.close(); }
});

test("assessment omission clears labels without changing its receipt while canonical identical imports retain them", () => {
  for (const canonical of [false, true]) {
    const state = fixture();
    try {
      const a = state.store.createPlayer("context_legacy", token());
      const before = state.store.assessment(a.player.id, { ...aggregate, ...context });
      const submit = (score: number) => canonical ? state.store.importForm(a.player.id, buildPlayerReceipt({
        player_id: `p_${"1".repeat(32)}`, competition_id: `c_${"2".repeat(32)}`, week_id: WEEK, form_score: score,
        coverage_ppm: aggregate.coveragePpm, certainty_ppm: aggregate.certaintyPpm,
      })) : state.store.assessment(a.player.id, { ...aggregate, formScore: score });
      if (canonical) {
        assert.deepEqual(submit(800), before);
      } else {
        const optedOut = submit(800);
        assert.equal(optedOut.player.assessmentContext, undefined);
        assert.deepEqual(optedOut.player.receipt, before.player.receipt);
        assert.equal(state.counts().imports, 2);
        assert.equal(state.counts().assessment_context, 0);
        const counts = state.counts();
        assert.deepEqual(submit(800), optedOut);
        assert.deepEqual(state.counts(), counts);
        state.store.assessment(a.player.id, { ...aggregate, ...context });
      }
      const next = submit(801);
      assert.equal(next.player.assessmentContext, undefined);
      assert.equal(next.player.receipt!.form.score, 801);
      assert.deepEqual(next.player.receipt!.elo, before.player.receipt!.elo);
    } finally { state.close(); }
  }
});

test("context migration preserves old accounts and exposes categories only for the stored receipt week", () => {
  let date = DATE;
  const state = fixture({ now: () => date });
  try {
    const a = state.store.createPlayer("context_migration", token());
    const before = state.store.assessment(a.player.id, aggregate);
    const competitionId = state.store.competitionId;
    // Recreate the previous schema boundary: data exists but the additive table does not.
    state.db.exec("DROP TABLE assessment_context");
    state.restart();
    assert.equal(state.store.authenticate(a.token), a.player.id);
    assert.equal(state.store.competitionId, competitionId);
    assert.deepEqual(state.store.me(a.player.id), before);
    const withContext = state.store.assessment(a.player.id, { ...aggregate, ...context });
    state.restart(); assert.deepEqual(state.store.me(a.player.id), withContext);
    date = new Date("2026-09-21T12:00:00Z");
    assert.deepEqual(state.store.me(a.player.id).player.assessmentContext, context);
    const next = state.store.assessment(a.player.id, { ...aggregate, weekId: "2026-W38" });
    assert.equal(next.player.assessmentContext, undefined);
    assert.equal(next.player.receipt!.week_id, "2026-W38");
    assert.deepEqual(next.player.receipt!.elo, before.player.receipt!.elo);
    assert.equal(state.db.prepare("SELECT COUNT(*) AS n FROM assessment_context WHERE week_id=?").get(WEEK)!.n, 1);
    state.restart(); assert.equal(state.store.me(a.player.id).player.assessmentContext, undefined);
  } finally { state.close(); }
});
