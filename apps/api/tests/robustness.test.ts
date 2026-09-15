import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildMatchReceipt, type PlayerReceipt } from "../../../packages/elo-engine/src/receipts.ts";
import { createApiServer } from "../http.ts";
import { ApiError, createStore, type Store } from "../store.ts";

const DATE = new Date("2026-09-14T12:00:00Z");
const WEEK = "2026-W37";
const serviceKey = "s".repeat(48);
const clientId = "c".repeat(64);
const token = () => randomBytes(32).toString("hex");
const assessment = (score = 800, weekId = WEEK) => ({ weekId, formScore: score, coveragePpm: 900000, certaintyPpm: 900000 });
const root = resolve(import.meta.dirname, "../../..");
const storeModule = new URL("../store.ts", import.meta.url).href;
const apiFailure = (status: number) => (error: unknown) => error instanceof ApiError && error.status === status;

function disk(now = () => DATE) {
  const directory = mkdtempSync(join(tmpdir(), "elo-robustness-"));
  const databasePath = join(directory, "elo.sqlite");
  let store = createStore({ databasePath, now });
  return {
    databasePath, get store() { return store; },
    restart() { store.close(); store = createStore({ databasePath, now }); },
    close() { store.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
function counts(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return Object.fromEntries(["players", "receipts", "imports", "matches", "participation", "queue", "form_locks"].map(table => [table, db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n])); }
  finally { db.close(); }
}
async function serve(store: Store, bodyTimeoutMs = 5000) {
  const server = createApiServer({ store, serviceKey, bodyTimeoutMs });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  return {
    server, url,
    call(path: string, auth?: string, value?: unknown, method = value === undefined ? "GET" : "POST") {
      return fetch(`${url}${path}`, { method, headers: { "x-service-key": serviceKey, "x-client-id": clientId,
        ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(value === undefined ? {} : { "content-type": "application/json" }) },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }), signal: AbortSignal.timeout(3000) });
    },
    async close() { server.close(); server.closeAllConnections(); await once(server, "close"); },
  };
}

// Each child owns a real independent SQLite connection. A start barrier makes the
// writes contend across processes instead of merely scheduling synchronous calls.
async function parallel(path: string, jobs: Record<string, unknown>[]) {
  const source = `
    import{createStore,ApiError}from ${JSON.stringify(storeModule)};
    const store=createStore({databasePath:process.argv[1],now:()=>new Date(${JSON.stringify(DATE.toISOString())})});
    console.log('READY');
    let raw='';for await(const part of process.stdin) raw+=part;
    try {const job=JSON.parse(raw);let value;
      if(job.kind==='create')value=store.createPlayer(job.username,job.token);
      else if(job.kind==='import')value=store.assessment(store.authenticate(job.token),job.assessment);
      else {const id=store.authenticate(job.token);value=job.modes.map(mode=>store.joinQueue(id,mode));}
      console.log(JSON.stringify({ok:true,value}));
    }catch(error){console.log(JSON.stringify({ok:false,status:error instanceof ApiError?error.status:500}));}
    finally{store.close();}
  `;
  const children = jobs.map(job => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source, path], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    let readyResolve!: () => void, readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    let output = "", errorOutput = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", data => { output += data; if (output.includes("READY\n")) readyResolve(); });
    child.stderr.on("data", data => { errorOutput += data; });
    const result = new Promise<{ ok: boolean; status?: number; value?: unknown }>((resolve, reject) => {
      child.on("error", error => { readyReject(error); reject(error); });
      child.on("exit", code => {
        if (code !== 0) { const error = new Error(`SQLite worker exited ${code}: ${errorOutput.slice(0, 500)}`); readyReject(error); reject(error); return; }
        try { resolve(JSON.parse(output.trim().split("\n").at(-1)!)); } catch { reject(new Error("Invalid SQLite worker output")); }
      });
    });
    // Register failure handling before the barrier, including a child that fails to start.
    void result.catch(() => {});
    return { child, job, ready, result };
  });
  const deadline = setTimeout(() => { for (const { child } of children) child.kill("SIGKILL"); }, 12000);
  try {
    await Promise.all(children.map(worker => worker.ready));
    for (const worker of children) worker.child.stdin.end(JSON.stringify(worker.job));
    return await Promise.all(children.map(worker => worker.result));
  } finally { clearTimeout(deadline); for (const { child } of children) if (child.exitCode === null) child.kill("SIGKILL"); }
}

test("parallel processes atomically resolve username collisions and saved-key signup retries", { timeout: 15000 }, async () => {
  const state = disk();
  try {
    const keys = Array.from({ length: 4 }, token);
    const collisions = await parallel(state.databasePath, keys.map((key, i) => ({ kind: "create", username: i % 2 ? "Shared_Name" : "shared_name", token: key })));
    assert.equal(collisions.filter(result => result.ok).length, 1);
    assert.deepEqual(collisions.filter(result => !result.ok).map(result => result.status), [409, 409, 409]);
    const saved = token();
    const repeated = await parallel(state.databasePath, Array.from({ length: 4 }, () => ({ kind: "create", username: "saved_name", token: saved })));
    assert.ok(repeated.every(result => result.ok));
    assert.equal(new Set(repeated.map(result => (result.value as ReturnType<Store["createPlayer"]>).player.id)).size, 1);
    assert.equal(counts(state.databasePath).players, 2);
    state.restart();
    assert.equal(state.store.authenticate(saved), state.store.userView("saved_name").player.id);
  } finally { state.close(); }
});

test("concurrent identical imports are one write and the persistent revision limit is atomic", { timeout: 15000 }, async () => {
  const state = disk();
  try {
    const account = state.store.createPlayer("parallel_import", token());
    const repeat = await parallel(state.databasePath, Array.from({ length: 4 }, () => ({ kind: "import", token: account.token, assessment: assessment() })));
    assert.ok(repeat.every(result => result.ok));
    assert.equal(counts(state.databasePath).imports, 1);
    assert.equal(counts(state.databasePath).receipts, 1);
    const changes = await parallel(state.databasePath, [801, 802, 803, 804].map(score => ({ kind: "import", token: account.token, assessment: assessment(score) })));
    assert.ok(changes.every(result => result.ok));
    assert.equal(counts(state.databasePath).imports, 5);
    assert.throws(() => state.store.assessment(account.player.id, assessment(805)), apiFailure(429));
    const before = state.store.me(account.player.id);
    state.restart();
    assert.deepEqual(state.store.me(account.player.id), before);
    assert.throws(() => state.store.assessment(account.player.id, assessment(806)), apiFailure(429));
  } finally { state.close(); }
});

test("parallel opt-ins and queue retries create exactly one match per player per mode with replayable receipts", { timeout: 15000 }, async () => {
  const state = disk();
  try {
    const accounts = [900, 800, 700, 600].map((score, i) => {
      const account = state.store.createPlayer(`parallel_queue_${i}`, token());
      state.store.assessment(account.player.id, assessment(score)); return account;
    });
    const optins = await parallel(state.databasePath, accounts.map(account => ({ kind: "queue", token: account.token, modes: ["scalar", "binary", "scalar", "binary"] })));
    assert.ok(optins.every(result => result.ok));
    const totals = counts(state.databasePath);
    assert.equal(totals.matches, 4); assert.equal(totals.participation, 8); assert.equal(totals.queue, 0);
    for (const mode of ["scalar", "binary"] as const) {
      const overview = state.store.overview(mode);
      assert.equal(overview.stats.matches, 2);
      assert.equal(overview.players.reduce((sum, player) => sum + player.ratingMilli, 0), 4 * 1200000);
      for (const match of overview.matches) {
        assert.notEqual(match.players.a.player_id, match.players.b.player_id);
        const [replayed] = buildMatchReceipt({ receipt_a: state.store.receipt(match.players.a.source_receipt_fingerprint) as PlayerReceipt,
          receipt_b: state.store.receipt(match.players.b.source_receipt_fingerprint) as PlayerReceipt, mode, match_id: match.match_id });
        assert.deepEqual(replayed, match);
      }
      for (const account of accounts) {
        const me = state.store.me(account.player.id);
        assert.equal(me.player.receipt!.elo[mode].rated_matches, 1);
        assert.equal(me.matches.length, 2);
        assert.equal(me.formLocked, true);
        assert.equal(state.store.joinQueue(account.player.id, mode).status, "matched");
      }
    }
    const before = accounts.map(account => state.store.me(account.player.id)); state.restart();
    assert.deepEqual(accounts.map(account => state.store.me(account.player.id)), before);
    const db = new DatabaseSync(state.databasePath, { readOnly: true });
    try { assert.equal(db.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok"); } finally { db.close(); }
  } finally { state.close(); }
});

test("a real SQL failure midway through matching rolls back both accounts and recovers after restart", async () => {
  const state = disk();
  const a = state.store.createPlayer("sql_failure_a", token()), b = state.store.createPlayer("sql_failure_b", token());
  state.store.assessment(a.player.id, assessment(900)); state.store.assessment(b.player.id, assessment(700));
  state.store.joinQueue(a.player.id, "scalar");
  const before = [state.store.me(a.player.id), state.store.me(b.player.id)];
  const beforeCounts = counts(state.databasePath);
  const db = new DatabaseSync(state.databasePath);
  db.exec(`CREATE TRIGGER fail_second_player BEFORE UPDATE OF receipt ON players WHEN NEW.id='${b.player.id}' BEGIN SELECT RAISE(ABORT,'STORAGE_PRIVATE_CANARY'); END`);
  const app = await serve(state.store);
  try {
    try {
      const response = await app.call("/v1/queue", b.token, { mode: "scalar" });
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: "The request could not be completed." });
      assert.deepEqual([state.store.me(a.player.id), state.store.me(b.player.id)], before);
      assert.deepEqual(counts(state.databasePath), beforeCounts);
    } finally { await app.close(); db.exec("DROP TRIGGER fail_second_player"); db.close(); }
    state.restart();
    assert.deepEqual([state.store.me(a.player.id), state.store.me(b.player.id)], before);
    const result = state.store.joinQueue(b.player.id, "scalar");
    assert.equal(result.status, "matched"); assert.equal(counts(state.databasePath).matches, 1);
    assert.equal(state.store.me(a.player.id).player.receipt!.elo.scalar.rated_matches, 1);
    assert.equal(state.store.me(b.player.id).player.receipt!.elo.scalar.rated_matches, 1);
  } finally { state.close(); }
});

test("damaged or misassociated stored receipts fail closed in public reads and mutations", async () => {
  const state = disk();
  const a = state.store.createPlayer("damaged_a", token()), b = state.store.createPlayer("damaged_b", token());
  state.store.assessment(a.player.id, assessment(900)); state.store.assessment(b.player.id, assessment(700));
  const good = state.store.me(a.player.id).player.receipt!;
  const db = new DatabaseSync(state.databasePath);
  const app = await serve(state.store);
  try {
    const goodJson = JSON.stringify(good);
    const ambiguousJson = [
      goodJson.replace('"score":900', '"score":100,"score":900'),
      goodJson.replace('"score":900', '"score":100,"\\u0073core":900'),
      goodJson.replace('"score":900', '"score":900.0'),
    ];
    for (const damaged of ["{", ...ambiguousJson, JSON.stringify({ ...good, private_history: "STORED_PRIVATE_CANARY" }), JSON.stringify(state.store.me(b.player.id).player.receipt)]) {
      db.prepare("UPDATE players SET receipt=? WHERE id=?").run(damaged, a.player.id);
      for (const path of ["/v1/me", `/v1/players/${a.player.id}`, "/v1/overview?mode=scalar", `/v1/players/${a.player.id}/card.svg`]) {
        const response = await app.call(path, a.token); assert.equal(response.status, 500);
        assert.deepEqual(await response.json(), { error: "The request could not be completed." });
      }
      const response = await app.call("/v1/assessment", a.token, assessment(850)); assert.equal(response.status, 500);
      assert.equal(db.prepare("SELECT receipt FROM players WHERE id=?").get(a.player.id)!.receipt, damaged);
    }
    db.prepare("UPDATE players SET receipt=? WHERE id=?").run(JSON.stringify(good), a.player.id);
    for (const damaged of [...ambiguousJson, JSON.stringify({ ...good, private_history: "STORED_PRIVATE_CANARY" }), JSON.stringify(state.store.me(b.player.id).player.receipt)]) {
      db.prepare("UPDATE receipts SET receipt=? WHERE fingerprint=?").run(damaged, good.fingerprint);
      const response = await app.call(`/v1/receipts/${good.fingerprint}`); assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: "The request could not be completed." });
    }
    state.store.joinQueue(a.player.id, "scalar");
    const before = counts(state.databasePath);
    assert.throws(() => state.store.joinQueue(b.player.id, "scalar"));
    assert.deepEqual(counts(state.databasePath), before);
    db.prepare("UPDATE receipts SET receipt=? WHERE fingerprint=?").run(JSON.stringify(good), good.fingerprint);
    const match = state.store.joinQueue(b.player.id, "scalar").match!;
    for (const [column, value] of [
      ["receipt", JSON.stringify({ ...match, private_history: "STORED_PRIVATE_CANARY" })],
      ["receipt", JSON.stringify(match).replace('"mode":"scalar"', '"mode":"binary","mode":"scalar"')],
      ["week_id", "2026-W36"],
    ] as const) {
      db.prepare(`UPDATE matches SET ${column}=? WHERE id=?`).run(value, match.match_id);
      for (const path of [`/v1/matches/${match.match_id}/card.svg`, `/v1/players/${a.player.id}`, "/v1/overview?mode=scalar"]) {
        const response = await app.call(path); assert.equal(response.status, 500);
        assert.deepEqual(await response.json(), { error: "The request could not be completed." });
      }
      db.prepare("UPDATE matches SET receipt=?,week_id=? WHERE id=?").run(JSON.stringify(match), WEEK, match.match_id);
    }
    assert.equal((await app.call(`/v1/players/${a.player.id}`)).status, 200);
  } finally { await app.close(); db.close(); state.close(); }
});

test("misassociated participation cannot disclose another match or satisfy a queue retry", async () => {
  let now = DATE;
  const state = disk(() => now);
  const a = state.store.createPlayer("participation_a", token()), b = state.store.createPlayer("participation_b", token());
  const outsider = state.store.createPlayer("participation_c", token());
  state.store.assessment(a.player.id, assessment(900)); state.store.assessment(b.player.id, assessment(700));
  state.store.joinQueue(a.player.id, "scalar");
  const match = state.store.joinQueue(b.player.id, "scalar").match!;
  const db = new DatabaseSync(state.databasePath);
  const app = await serve(state.store);
  try {
    for (const kind of ["player", "mode", "week"] as const) {
      const affected = kind === "player" ? outsider : a;
      const mode = kind === "mode" ? "binary" : "scalar";
      const weekId = kind === "week" ? "2026-W38" : WEEK;
      now = kind === "week" ? new Date("2026-09-21T12:00:00Z") : DATE;
      db.prepare("UPDATE participation SET player_id=?,week_id=?,mode=? WHERE player_id=? AND match_id=?")
        .run(affected.player.id, weekId, mode, a.player.id, match.match_id);
      const before = counts(state.databasePath);
      for (const path of ["/v1/me", `/v1/players/${affected.player.id}`]) {
        const response = await app.call(path, affected.token);
        assert.equal(response.status, 500, `${kind}: ${path}`);
        assert.deepEqual(await response.json(), { error: "The request could not be completed." });
      }
      const retry = await app.call("/v1/queue", affected.token, { mode });
      assert.equal(retry.status, 500, kind);
      assert.deepEqual(await retry.json(), { error: "The request could not be completed." });
      assert.deepEqual(counts(state.databasePath), before);
      db.prepare("UPDATE participation SET player_id=?,week_id=?,mode='scalar' WHERE player_id=? AND match_id=?")
        .run(a.player.id, WEEK, affected.player.id, match.match_id);
    }
    now = DATE;
    assert.equal((await app.call(`/v1/players/${a.player.id}`)).status, 200);
    assert.equal(state.store.joinQueue(a.player.id, "scalar").match!.fingerprint, match.fingerprint);
    assert.deepEqual(state.store.me(outsider.player.id).matches, []);
  } finally { await app.close(); db.close(); state.close(); }
});

test("invalid competition metadata and non-SQLite files never silently create a replacement league", () => {
  const state = disk();
  const db = new DatabaseSync(state.databasePath);
  db.prepare("UPDATE metadata SET value=? WHERE key='competition_id'").run("INVALID_PRIVATE_METADATA"); db.close();
  try {
    assert.throws(() => createStore({ databasePath: state.databasePath }), /Invalid database competition metadata/);
    const unchanged = new DatabaseSync(state.databasePath, { readOnly: true });
    try { assert.equal(unchanged.prepare("SELECT value FROM metadata WHERE key='competition_id'").get()!.value, "INVALID_PRIVATE_METADATA"); } finally { unchanged.close(); }
  } finally { state.close(); }
  const directory = mkdtempSync(join(tmpdir(), "elo-invalid-db-")), path = join(directory, "not-sqlite");
  try {
    const bytes = Buffer.from("not a database: keep this recoverable"); writeFileSync(path, bytes);
    assert.throws(() => createStore({ databasePath: path }));
    assert.deepEqual(readFileSync(path), bytes);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("missing competition metadata preserves existing accounts and orphaned archives instead of replacing the league", () => {
  const state = disk();
  const competitionId = state.store.competitionId;
  const account = state.store.createPlayer("metadata_account", token());
  const db = new DatabaseSync(state.databasePath);
  try {
    db.prepare("DELETE FROM metadata WHERE key='competition_id'").run();
    assert.throws(() => createStore({ databasePath: state.databasePath }), /Missing database competition metadata/);
    assert.equal(db.prepare("SELECT value FROM metadata WHERE key='competition_id'").get(), undefined);
    assert.equal(db.prepare("SELECT id FROM players").get()!.id, account.player.id);
    db.prepare("INSERT INTO metadata VALUES ('competition_id',?)").run(competitionId);
    state.restart();
    assert.equal(state.store.authenticate(account.token), account.player.id);
    assert.equal(state.store.competitionId, competitionId);

    state.store.assessment(account.player.id, assessment());
    const archived = state.store.me(account.player.id).player.receipt!;
    db.exec("DELETE FROM imports; DELETE FROM players; DELETE FROM metadata WHERE key='competition_id'");
    assert.throws(() => createStore({ databasePath: state.databasePath }), /Missing database competition metadata/);
    assert.equal(db.prepare("SELECT value FROM metadata WHERE key='competition_id'").get(), undefined);
    assert.equal(db.prepare("SELECT receipt FROM receipts WHERE fingerprint=?").get(archived.fingerprint)!.receipt, JSON.stringify(archived));

    db.exec("DELETE FROM receipts");
    state.restart();
    assert.match(state.store.competitionId, /^c_[0-9a-f]{32}$/);
    assert.equal(state.store.overview("scalar").stats.players, 0);
  } finally { db.close(); state.close(); }
});

test("simultaneous HTTP rotation permits one winner and cannot replace another account's key", async () => {
  const state = disk();
  const a = state.store.createPlayer("rotation_a", token()), b = state.store.createPlayer("rotation_b", token());
  const beforeB = state.store.me(b.player.id);
  const app = await serve(state.store);
  try {
    const conflict = await app.call("/v1/session/rotate", a.token, { replacementToken: b.token }); assert.equal(conflict.status, 409);
    assert.equal(state.store.authenticate(a.token), a.player.id); assert.equal(state.store.authenticate(b.token), b.player.id);
    const replacements = [token(), token()];
    const responses = await Promise.all(replacements.map(replacementToken => app.call("/v1/session/rotate", a.token, { replacementToken })));
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 401]);
    const winner = replacements[responses.findIndex(response => response.status === 200)]!;
    const loser = replacements[responses.findIndex(response => response.status === 401)]!;
    assert.equal(state.store.authenticate(winner), a.player.id);
    assert.throws(() => state.store.authenticate(a.token), apiFailure(401)); assert.throws(() => state.store.authenticate(loser), apiFailure(401));
    assert.deepEqual(state.store.me(b.player.id), beforeB);
    for (const path of ["/v1/assessment", "/v1/queue", "/v1/username", "/v1/session/rotate"]) {
      assert.equal((await app.call(path, winner, { playerId: b.player.id })).status, 400);
    }
    assert.deepEqual(state.store.me(b.player.id), beforeB);
  } finally { await app.close(); state.close(); }
});

test("slow or abandoned request bodies release resources without publishing or revoking an account", { timeout: 3000 }, async () => {
  const store = createStore({ databasePath: ":memory:", now: () => DATE });
  const account = store.createPlayer("upload_deadline", token());
  const before = store.me(account.player.id);
  const app = await serve(store, 25);
  try {
    const slow = httpRequest(`${app.url}/v1/session/rotate`, { method: "POST", headers: {
      "x-service-key": serviceKey, "x-client-id": clientId, authorization: `Bearer ${account.token}`, "content-type": "application/json", "content-length": "100",
    } });
    const response = once(slow, "response"); slow.write("{");
    const [received] = await response;
    const chunks: Buffer[] = []; received.on("data", (chunk: Buffer) => chunks.push(chunk)); await once(received, "end");
    assert.equal(received.statusCode, 408); assert.equal(received.headers.connection, "close");
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { error: "Request body took too long." });
    slow.destroy();
    assert.equal(store.authenticate(account.token), account.player.id); assert.deepEqual(store.me(account.player.id), before);
    const aborted = httpRequest(`${app.url}/v1/assessment`, { method: "POST", headers: {
      "x-service-key": serviceKey, "x-client-id": clientId, authorization: `Bearer ${account.token}`, "content-type": "application/json", "content-length": "200",
    } });
    aborted.on("error", () => {});
    const started = once(app.server, "request"); aborted.write("{"); const [incoming] = await started;
    const closed = once(incoming, "close").catch(() => {}); aborted.destroy(); await closed;
    assert.deepEqual(store.me(account.player.id), before);
    assert.equal((await app.call("/v1/assessment", account.token, assessment())).status, 200);
  } finally { await app.close(); store.close(); }
});
