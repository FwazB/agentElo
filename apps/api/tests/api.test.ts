import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { attachFingerprint } from "../../../packages/elo-engine/src/canonical.ts";
import { buildMatchReceipt, buildPlayerReceipt, validatePlayerReceipt, type PlayerReceipt } from "../../../packages/elo-engine/src/receipts.ts";
import { createApiServer } from "../http.ts";
import { ApiError, createStore, lastCompletedWeek, normalizeUsername, type Store } from "../store.ts";
import { startServer } from "../server.ts";

const NOW = new Date("2026-09-14T12:00:00Z");
const WEEK = "2026-W37";
const SERVICE_KEY = "s".repeat(48);
const CLIENT_ID = "c".repeat(64);

test("new zero-evidence scores cannot publish or alter an existing grounded score", () => {
  const store = memory();
  try {
    const account = createAccount(store);
    for (const [coveragePpm, certaintyPpm] of [[0, 900000], [900000, 0], [0, 0]]) {
      assert.throws(() => store.assessment(account.player.id, { weekId: WEEK, formScore: 850, coveragePpm, certaintyPpm }), (error: unknown) => error instanceof ApiError && error.status === 422);
    }
    assert.equal(store.me(account.player.id).player.receipt, null);
    const valid = store.importForm(account.player.id, receipt(849, 430000));
    assert.equal(valid.player.receipt!.form.confidence.effective_ppm, 430000);
    assert.throws(() => store.importForm(account.player.id, receipt(1000, 0)), (error: unknown) => error instanceof ApiError && error.status === 422);
    assert.deepEqual(store.me(account.player.id), valid);
    assert.equal(store.overview("scalar").stats.ratedPlayers, 0);
  } finally { store.close(); }
});
function receipt(score = 850, confidence = 900_000, week = WEEK): PlayerReceipt {
  return buildPlayerReceipt({ player_id: `p_${"1".repeat(32)}`, competition_id: `c_${"2".repeat(32)}`,
    week_id: week, form_score: score, coverage_ppm: confidence, certainty_ppm: confidence });
}
function memory(options: { now?: () => Date; beforeCommit?: (operation: string) => void } = {}): Store {
  return createStore({ databasePath: ":memory:", now: () => NOW, ...options });
}
const token = () => randomBytes(32).toString("hex");
function newPlayer(store: Store, username: unknown) { return store.createPlayer(username, token()); }
let accountNumber = 0;
function createAccount(store: Store) { return newPlayer(store, `test_${++accountNumber}`); }
function players(store: Store, confidence = 900_000) {
  const a = createAccount(store);
  const b = createAccount(store);
  store.importForm(a.player.id, receipt(900, confidence));
  store.importForm(b.player.id, receipt(700, confidence));
  return [a, b] as const;
}
async function serve(store: Store = memory()) {
  const server = createApiServer({ store, serviceKey: SERVICE_KEY });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const call = (path: string, init: RequestInit = {}, authenticatedService = true) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    ...init, headers: { ...(authenticatedService ? { "x-service-key": SERVICE_KEY, "x-client-id": CLIENT_ID } : {}), ...init.headers },
  });
  const close = async () => { server.close(); server.closeAllConnections(); await once(server, "close"); store.close(); };
  return { store, call, close, server, url: `http://127.0.0.1:${address.port}` };
}
const jsonBody = (value: unknown, token?: string): RequestInit => ({ method: "POST", body: JSON.stringify(value),
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) } });

test("last completed ISO week uses UTC and handles year boundaries", () => {
  assert.equal(lastCompletedWeek(NOW), WEEK);
  assert.equal(lastCompletedWeek(new Date("2026-09-13T23:59:59Z")), "2026-W36");
  assert.equal(lastCompletedWeek(new Date("2021-01-04T00:00:00Z")), "2020-W53");
  assert.equal(lastCompletedWeek(new Date("2021-01-03T23:59:59Z")), "2020-W52");
  assert.equal(lastCompletedWeek(new Date("2020-01-06T00:00:00Z")), "2020-W01");
});

test("account tokens are opaque and hashed; state and competition survive restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "elo-api-"));
  const databasePath = join(directory, "elo.sqlite");
  let store = createStore({ databasePath, now: () => NOW });
  try {
    const [a, b] = players(store);
    assert.match(a.token, /^[0-9a-f]{64}$/);
    assert.equal(store.authenticate(a.token), a.player.id);
    assert.throws(() => store.authenticate("0".repeat(64)), ApiError);
    assert.throws(() => store.authenticate("bad"), ApiError);
    const competition = store.competitionId;
    store.joinQueue(a.player.id, "scalar");
    const match = store.joinQueue(b.player.id, "scalar").match!;
    const before = store.me(a.player.id);
    const archived = store.receipt(match.players.a.source_receipt_fingerprint);
    store.close();
    store = createStore({ databasePath, now: () => NOW });
    assert.equal(store.competitionId, competition);
    assert.equal(store.authenticate(a.token), a.player.id);
    assert.deepEqual(store.me(a.player.id), before);
    assert.deepEqual(store.receipt(match.fingerprint), match);
    assert.deepEqual(store.receipt(archived.fingerprint), archived);
    assert.deepEqual(store.receipt(receipt(900).fingerprint), receipt(900));
    assert.deepEqual(store.joinQueue(a.player.id, "scalar").match, match);
    const db = new DatabaseSync(databasePath, { readOnly: true });
    const row = db.prepare("SELECT token_hash FROM players WHERE id=?").get(a.player.id)!;
    assert.equal(row.token_hash, createHash("sha256").update(a.token).digest("hex"));
    assert.notEqual(row.token_hash, a.token);
    db.close();
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("import trusts only Form and confidence; forged Elo and IDs never enter server state", () => {
  const store = memory();
  try {
    const account = createAccount(store);
    const forged = receipt();
    forged.elo.scalar.rating_milli = 9_999_999;
    forged.elo.scalar.rated_matches = 900;
    forged.elo.scalar.last_match_fingerprint = `sha256:${"a".repeat(64)}`;
    forged.parent_fingerprint = `sha256:${"b".repeat(64)}`;
    const validForged = validatePlayerReceipt(attachFingerprint(forged));
    const imported = store.importForm(account.player.id, validForged).player.receipt!;
    assert.equal(imported.player_id, account.player.id);
    assert.equal(imported.competition_id, store.competitionId);
    assert.equal(imported.form.score, 850);
    assert.equal(imported.elo.scalar.rating_milli, 1_200_000);
    assert.equal(imported.elo.scalar.rated_matches, 0);
    assert.equal(imported.elo.binary.rating_milli, 1_200_000);
    assert.equal(imported.parent_fingerprint, null);
    assert.throws(() => store.importForm(account.player.id, receipt(850, 900_000, "2026-W36")), /last completed/);
    assert.throws(() => store.importForm(account.player.id, receipt(850, 900_000, "2026-W38")), /last completed/);
  } finally { store.close(); }
});

test("queue requires both players' consent and enforces weekly idempotency and separate streams", () => {
  const store = memory();
  try {
    const [a, b] = players(store);
    const aId = a.player.id, bId = b.player.id;
    assert.deepEqual(store.joinQueue(aId, "scalar"), { status: "queued", match: null });
    assert.equal(store.me(bId).matches.length, 0);
    assert.deepEqual(store.joinQueue(aId, "scalar"), { status: "queued", match: null });
    const first = store.joinQueue(bId, "scalar");
    assert.equal(first.match!.rating_effect, "rated");
    assert.equal(store.me(aId).player.receipt!.elo.binary.rating_milli, 1_200_000);
    assert.equal(store.me(aId).player.receipt!.elo.scalar.rated_matches, 1);
    assert.deepEqual(store.joinQueue(aId, "scalar"), first);
    assert.deepEqual(store.joinQueue(bId, "scalar"), first);
    assert.equal(store.overview("scalar").stats.matches, 1);
    assert.deepEqual(store.me(aId).queue, []);
    const exactImport = store.importForm(aId, receipt(900));
    assert.equal(exactImport.player.receipt!.elo.scalar.rated_matches, 1);
    assert.throws(() => store.importForm(aId, receipt(901)), /locked/);
    store.joinQueue(aId, "binary");
    store.joinQueue(bId, "binary");
    const final = store.me(aId).player.receipt!;
    assert.equal(final.elo.binary.rated_matches, 1);
    assert.equal(final.elo.scalar.rated_matches, 1);
    assert.equal(final.elo.scalar.rating_milli, exactImport.player.receipt!.elo.scalar.rating_milli);
  } finally { store.close(); }
});

test("queue cancellation keeps Form locked and cannot revoke a completed match", () => {
  const store = memory();
  try {
    const [a, b] = players(store);
    assert.equal(store.me(a.player.id).formLocked, false);
    store.joinQueue(a.player.id, "scalar");
    assert.equal(store.me(a.player.id).formLocked, true);
    const canceled = store.cancelQueue(a.player.id, "scalar");
    assert.deepEqual(canceled.queue, []);
    assert.equal(canceled.formLocked, true);
    assert.throws(() => store.importForm(a.player.id, receipt(999)), /locked/);
    assert.equal(store.joinQueue(b.player.id, "scalar").status, "queued");
    const result = store.joinQueue(a.player.id, "scalar");
    store.cancelQueue(a.player.id, "scalar");
    assert.deepEqual(store.joinQueue(a.player.id, "scalar"), result);
  } finally { store.close(); }
});

test("confidence below 50% forms exhibitions and cannot consume a rated opponent", () => {
  const store = memory();
  try {
    const [a, b] = players(store, 499_999);
    const rated = createAccount(store);
    store.importForm(rated.player.id, receipt(800, 500_000));
    store.joinQueue(a.player.id, "scalar");
    assert.equal(store.joinQueue(rated.player.id, "scalar").status, "queued");
    const result = store.joinQueue(b.player.id, "scalar");
    assert.equal(result.match!.rating_effect, "exhibition");
    assert.deepEqual(result.match!.exhibition_reasons, ["low_confidence"]);
    assert.equal(store.me(a.player.id).player.receipt!.elo.scalar.rated_matches, 0);
    assert.equal(store.me(a.player.id).player.receipt!.elo.scalar.rating_milli, 1_200_000);
    assert.deepEqual(store.joinQueue(a.player.id, "scalar"), result);
    assert.equal(store.me(rated.player.id).queue.length, 1);
    const boundary = createAccount(store);
    store.importForm(boundary.player.id, receipt(750, 500_000));
    assert.equal(store.joinQueue(boundary.player.id, "scalar").match!.rating_effect, "rated");
  } finally { store.close(); }
});

test("weekly rollover requires fresh Form, ignores stale queues, and carries both Elo streams", () => {
  let time = NOW;
  const store = memory({ now: () => time });
  try {
    const [a, b] = players(store);
    store.joinQueue(a.player.id, "scalar");
    store.joinQueue(b.player.id, "scalar");
    store.joinQueue(a.player.id, "binary");
    store.joinQueue(b.player.id, "binary");
    const prior = store.me(a.player.id).player.receipt!;
    const stale = createAccount(store);
    store.importForm(stale.player.id, receipt());
    store.joinQueue(stale.player.id, "scalar");
    time = new Date("2026-09-21T00:00:00Z");
    assert.equal(store.currentWeek(), "2026-W38");
    assert.equal(store.overview("scalar").stats.queued, 0);
    assert.deepEqual(store.me(stale.player.id).queue, []);
    assert.equal(store.me(stale.player.id).formLocked, false);
    assert.equal(store.me(a.player.id).formLocked, false);
    assert.throws(() => store.joinQueue(a.player.id, "scalar"), /Import this week's/);
    const next = store.importForm(a.player.id, receipt(810, 850_000, "2026-W38")).player.receipt!;
    assert.deepEqual(next.elo, prior.elo);
    assert.equal(next.parent_fingerprint, prior.fingerprint);
    store.importForm(b.player.id, receipt(710, 850_000, "2026-W38"));
    assert.equal(store.joinQueue(a.player.id, "scalar").status, "queued");
    assert.equal(store.joinQueue(b.player.id, "scalar").match!.rating_effect, "rated");
    assert.equal(store.me(a.player.id).player.receipt!.elo.scalar.rated_matches, 2);
    assert.equal(store.me(a.player.id).player.receipt!.elo.binary.rated_matches, 1);
  } finally { store.close(); }
});

test("matching transaction rollback restores queue, players, match slots and receipt archive", () => {
  let fail = false;
  const store = memory({ beforeCommit: operation => { if (fail && operation === "joinQueue") throw new Error("injected commit failure"); } });
  try {
    const [a, b] = players(store);
    store.joinQueue(a.player.id, "scalar");
    const beforeA = store.me(a.player.id), beforeB = store.me(b.player.id);
    fail = true;
    assert.throws(() => store.joinQueue(b.player.id, "scalar"), /injected/);
    assert.deepEqual(store.me(a.player.id), beforeA);
    assert.deepEqual(store.me(b.player.id), beforeB);
    assert.equal(store.overview("scalar").stats.matches, 0);
    fail = false;
    const result = store.joinQueue(b.player.id, "scalar");
    assert.equal(result.status, "matched");
    assert.equal(store.overview("scalar").stats.matches, 1);
    const sourceA = store.receipt(result.match!.players.a.source_receipt_fingerprint) as PlayerReceipt;
    const sourceB = store.receipt(result.match!.players.b.source_receipt_fingerprint) as PlayerReceipt;
    const [replayed] = buildMatchReceipt({ receipt_a: sourceA, receipt_b: sourceB, mode: "scalar", match_id: result.match!.match_id });
    assert.deepEqual(replayed, result.match);
  } finally { store.close(); }
});

test("import transaction rollback does not retain the source or publish state", () => {
  let fail = false;
  const store = memory({ beforeCommit: operation => { if (fail && operation === "importForm") throw new Error("injected commit failure"); } });
  try {
    const account = createAccount(store);
    const source = receipt();
    fail = true;
    assert.throws(() => store.importForm(account.player.id, source), /injected/);
    assert.equal(store.me(account.player.id).player.receipt, null);
    assert.throws(() => store.receipt(source.fingerprint), /not found/);
    fail = false;
    assert.equal(store.importForm(account.player.id, source).player.receipt!.form.score, 850);
  } finally { store.close(); }
});

test("overview is empty on first boot and bounded with unrated accounts unranked", () => {
  const store = memory();
  try {
    assert.deepEqual(store.overview("scalar").players, []);
    assert.deepEqual(store.overview("scalar").matches, []);
    const [a, b] = players(store);
    store.joinQueue(a.player.id, "scalar");
    store.joinQueue(b.player.id, "scalar");
    for (let index = 0; index < 105; index++) createAccount(store);
    const overview = store.overview("scalar");
    assert.equal(overview.players.length, 100);
    assert.equal(overview.stats.players, 107);
    assert.equal(overview.stats.ratedPlayers, 2);
    assert.equal(overview.players[0]!.rank, 1);
    assert.equal(overview.players[1]!.rank, 2);
    assert.equal(overview.players[2]!.rank, null);
    assert.equal(store.overview("binary").stats.ratedPlayers, 0);
    assert(store.overview("binary").players.every(player => player.rank === null));
  } finally { store.close(); }
});

test("HTTP health, service auth, account auth and public views", async () => {
  const app = await serve();
  try {
    assert.equal((await app.call("/health", {}, false)).status, 200);
    assert.equal((await app.call("/v1/overview", {}, false)).status, 401);
    assert.equal((await app.call("/v1/overview", { headers: { "x-service-key": "bad" } })).status, 401);
    assert.equal((await app.call("/v1/overview", { headers: { "x-client-id": "untrusted raw IP" } })).status, 400);
    assert.equal((await app.call("/v1/me")).status, 401);
    assert.equal((await app.call("/v1/me", { headers: { authorization: `Bearer ${"a".repeat(64)}` } })).status, 401);
    const creation = await app.call("/v1/players", jsonBody({ username: "New_Player", token: token() }));
    assert.equal(creation.status, 201);
    const account = await creation.json() as ReturnType<Store["createPlayer"]>;
    assert.equal(account.formLocked, false);
    assert.equal((await app.call("/v1/me", { headers: { authorization: `Bearer ${account.token}` } })).status, 200);
    const publicView = await app.call(`/v1/players/${account.player.id}`);
    assert.equal(publicView.status, 200);
    assert.equal(publicView.headers.get("cache-control"), "no-store");
    assert.equal(publicView.headers.get("x-content-type-options"), "nosniff");
    assert(!JSON.stringify(await publicView.json()).includes(account.token));
    assert.equal((await app.call(`/v1/players/${account.player.id}/card.svg`)).status, 404);
    assert.equal((await app.call(`/v1/matches/m_${"0".repeat(32)}/card.svg`)).status, 404);
  } finally { await app.close(); }
});

test("HTTP rejects private fields and oversized JSON without echoing input", async () => {
  const app = await serve();
  try {
    const account = createAccount(app.store);
    const secret = "secret-person-private-activity.txt";
    const payload = { ...receipt(), [secret]: "raw private evidence" };
    const rejected = await app.call("/v1/form", jsonBody({ receipt: payload }, account.token));
    assert.equal(rejected.status, 400);
    const text = await rejected.text();
    assert(!text.includes(secret));
    assert(!text.includes("raw private evidence"));
    assert.equal(app.store.me(account.player.id).player.receipt, null);
    const nested = receipt() as unknown as Record<string, unknown>;
    (nested.form as Record<string, unknown>).evidence = secret;
    assert.equal((await app.call("/v1/form", jsonBody({ receipt: nested }, account.token))).status, 400);
    const extra = await app.call("/v1/players", jsonBody({ [secret]: "private" }));
    assert.equal(extra.status, 400);
    assert(!(await extra.text()).includes(secret));
    assert.equal((await app.call("/v1/form", jsonBody({ receipt: "x".repeat(16_385) }, account.token))).status, 413);
    assert.equal((await app.call("/v1/form", { method: "POST", body: "{}", headers: { authorization: `Bearer ${account.token}` } })).status, 415);
    assert.equal((await app.call("/v1/overview?mode=scalar&mode=binary")).status, 400);
    assert.equal((await app.call("/v1/overview?unexpected=private")).status, 400);
    for (const replacement of ['"score":850.0', '"score":850,"score":850', '"score":-0']) {
      const raw = JSON.stringify({ receipt: receipt() }).replace('"score":850', replacement);
      const response = await app.call("/v1/form", { method: "POST", body: raw,
        headers: { "content-type": "application/json", authorization: `Bearer ${account.token}` } });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "Invalid JSON body." });
    }
  } finally { await app.close(); }
});

test("HTTP aggregate import, queue, receipt replay and SVG endpoints", async () => {
  const app = await serve();
  try {
    const a = createAccount(app.store), b = createAccount(app.store);
    for (const [account, score] of [[a, 900], [b, 700]] as const) {
      assert.equal((await app.call("/v1/form", jsonBody({ receipt: receipt(score) }, account.token))).status, 200);
    }
    assert.equal((await (await app.call("/v1/queue", jsonBody({ mode: "scalar" }, a.token))).json() as { status: string }).status, "queued");
    const matched = await (await app.call("/v1/queue", jsonBody({ mode: "scalar" }, b.token))).json() as ReturnType<Store["joinQueue"]>;
    const match = matched.match!;
    const archived = await app.call(`/v1/receipts/${encodeURIComponent(match.fingerprint)}`);
    assert.deepEqual(await archived.json(), match);
    const card = await app.call(`/v1/matches/${match.match_id}/card.svg`);
    assert.match(card.headers.get("content-type")!, /image\/svg\+xml/);
    assert.match(await card.text(), /<svg/);
    const playerCard = await app.call(`/v1/players/${a.player.id}/card.svg`);
    assert.match(await playerCard.text(), /<svg/);
    const canceled = await app.call("/v1/queue?mode=scalar", { method: "DELETE", headers: { authorization: `Bearer ${a.token}` } });
    assert.equal(canceled.status, 200);
    assert.equal((await app.call("/v1/queue", jsonBody({ mode: "fake" }, a.token))).status, 400);
  } finally { await app.close(); }
});

test("HTTP limits anonymous account creation and requires strong service key", async () => {
  const app = await serve();
  try {
    for (let index = 0; index < 5; index++) assert.equal((await app.call("/v1/players", jsonBody({ username: `new_${index}`, token: token() }))).status, 201);
    const limited = await app.call("/v1/players", jsonBody({ username: "limited", token: token() }));
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "60");
    assert.throws(() => createApiServer({ store: app.store, serviceKey: "short" }), /32/);
  } finally { await app.close(); }
});

test("production startup rejects missing, relative and in-memory database configuration", () => {
  for (const databasePath of [undefined, "relative.sqlite", ":memory:"]) {
    assert.throws(() => startServer({ NODE_ENV: "production", SERVICE_KEY, ...(databasePath ? { DATABASE_PATH: databasePath } : {}) }), /DATABASE_PATH/);
  }
  assert.throws(() => startServer({ NODE_ENV: "production", DATABASE_PATH: "/data/elo.sqlite" }), /SERVICE_KEY/);
});

test("usernames normalize ASCII handles and reject unsafe or reserved input", () => {
  assert.equal(normalizeUsername("  @Some_Player7  "), "some_player7");
  assert.equal(normalizeUsername("a".repeat(20)), "a".repeat(20));
  for (const invalid of [null, 123, {}, "", "ab", "a".repeat(21), "1player", "two words", "<script>",
    "alice/bob", "../alice", "alice?x", "alice#x", "alice%2fbob", "a\u0000lice", "@@alice", "ａｌｉｃｅ", "Kelvin", "álîce", "alice\u200b", "admin", "API", "@support"]) {
    assert.throws(() => normalizeUsername(invalid), ApiError);
  }
});

test("usernames are unique case-insensitively, immutable and separate from auth and receipts", () => {
  const store = memory();
  try {
    const a = newPlayer(store, " @Alice_123 ");
    assert.equal(a.player.username, "alice_123");
    assert.deepEqual(a.usernames, { [a.player.id]: "alice_123" });
    assert.throws(() => newPlayer(store, "ALICE_123"), (error: unknown) => error instanceof ApiError && error.status === 409);
    assert.equal(store.overview("scalar").stats.players, 1);
    assert.equal(store.userView("ALICE_123").player.id, a.player.id);
    assert.equal(store.authenticate(a.token), a.player.id);
    assert.throws(() => store.authenticate(a.player.username!), ApiError);
    assert.deepEqual(store.claimUsername(a.player.id, "Alice_123"), store.me(a.player.id));
    assert.throws(() => store.claimUsername(a.player.id, "new_alice"), /cannot be changed/);
    const normalized = store.importForm(a.player.id, receipt()).player.receipt!;
    assert.equal(normalized.player_id, a.player.id);
    assert(!JSON.stringify(normalized).includes("alice_123"));
    assert.deepEqual(store.receipt(normalized.fingerprint), normalized);
  } finally { store.close(); }
});

test("additive username migration preserves old account, token, both Elo streams and archives", () => {
  const directory = mkdtempSync(join(tmpdir(), "elo-username-migration-"));
  const databasePath = join(directory, "elo.sqlite");
  const sourceA = receipt(900);
  const sourceB = buildPlayerReceipt({ player_id: `p_${"3".repeat(32)}`, competition_id: sourceA.competition_id,
    week_id: WEEK, form_score: 700, coverage_ppm: 900_000, certainty_ppm: 900_000 });
  const [match, ratedA] = buildMatchReceipt({ receipt_a: sourceA, receipt_b: sourceB, mode: "scalar", match_id: `m_${"4".repeat(32)}` });
  const token = "b".repeat(64);
  const old = new DatabaseSync(databasePath);
  old.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE players(id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,receipt TEXT,import_fingerprint TEXT,created_at INTEGER NOT NULL);
    CREATE TABLE receipts(fingerprint TEXT PRIMARY KEY,receipt TEXT NOT NULL);`);
  old.prepare("INSERT INTO metadata VALUES ('competition_id',?)").run(sourceA.competition_id);
  old.prepare("INSERT INTO players VALUES (?,?,?,?,?)").run(sourceA.player_id, createHash("sha256").update(token).digest("hex"), JSON.stringify(ratedA), sourceA.fingerprint, NOW.getTime());
  for (const archived of [sourceA, sourceB, match, ratedA!]) old.prepare("INSERT INTO receipts VALUES (?,?)").run(archived.fingerprint, JSON.stringify(archived));
  old.close();
  let store = createStore({ databasePath, now: () => NOW });
  try {
    assert.equal(store.me(sourceA.player_id).player.username, null);
    assert.deepEqual(store.me(sourceA.player_id).usernames, {});
    assert.equal(store.competitionId, sourceA.competition_id);
    assert.equal(store.authenticate(token), sourceA.player_id);
    assert.deepEqual(store.me(sourceA.player_id).player.receipt, ratedA);
    assert.deepEqual(store.receipt(match.fingerprint), match);
    const taken = newPlayer(store, "existing_player");
    assert.throws(() => store.claimUsername(sourceA.player_id, "EXISTING_PLAYER"), (error: unknown) => error instanceof ApiError && error.status === 409);
    assert.equal(store.me(sourceA.player_id).player.username, null);
    assert.equal(store.claimUsername(sourceA.player_id, "Legacy_Player").player.username, "legacy_player");
    assert.deepEqual(store.me(sourceA.player_id).player.receipt, ratedA);
    assert.equal(store.me(taken.player.id).player.username, "existing_player");
    store.close();
    store = createStore({ databasePath, now: () => NOW });
    assert.equal(store.authenticate(token), sourceA.player_id);
    assert.equal(store.userView("legacy_player").player.id, sourceA.player_id);
    assert.deepEqual(store.me(sourceA.player_id).player.receipt!.elo, ratedA!.elo);
    assert.throws(() => store.claimUsername(sourceA.player_id, "another_name"), /cannot be changed/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("match username mappings include shown participants and omit unrelated accounts", () => {
  const store = memory();
  try {
    const a = newPlayer(store, "alice"), b = newPlayer(store, "bobby"), hidden = newPlayer(store, "charlie");
    store.importForm(a.player.id, receipt(900));
    store.importForm(b.player.id, receipt(700));
    store.joinQueue(a.player.id, "scalar");
    const match = store.joinQueue(b.player.id, "scalar").match!;
    const view = store.userView("alice");
    assert.deepEqual(view.usernames, { [a.player.id]: "alice", [b.player.id]: "bobby" });
    assert(!Object.hasOwn(view.usernames, hidden.player.id));
    assert.equal(view.matches[0]!.fingerprint, match.fingerprint);
    assert(!JSON.stringify(match).includes("alice"));
    const overview = store.overview("scalar");
    assert.equal(overview.players.find(player => player.id === a.player.id)!.username, "alice");
    assert.equal(overview.usernames[a.player.id], "alice");
    assert.equal(overview.usernames[b.player.id], "bobby");
  } finally { store.close(); }
});

test("HTTP signup requires username; name claims require auth and public name lookup works", async () => {
  const app = await serve();
  try {
    assert.equal((await app.call("/v1/players", jsonBody({}))).status, 400);
    const created = await app.call("/v1/players", jsonBody({ username: "@Http_Player", token: token() }));
    assert.equal(created.status, 201);
    const account = await created.json() as ReturnType<Store["createPlayer"]>;
    assert.equal(account.player.username, "http_player");
    const duplicate = await app.call("/v1/players", jsonBody({ username: "HTTP_PLAYER", token: token() }));
    assert.equal(duplicate.status, 409);
    assert.equal((await app.call("/v1/username", jsonBody({ username: "some_name" }))).status, 401);
    assert.equal((await app.call("/v1/username", jsonBody({ username: "other_name" }, account.token))).status, 409);
    assert.equal((await app.call("/v1/username", jsonBody({ username: "HTTP_PLAYER" }, account.token))).status, 200);
    const view = await app.call("/v1/users/HTTP_PLAYER");
    assert.equal(view.status, 200);
    assert.equal((await view.json() as { player: { id: string } }).player.id, account.player.id);
    assert.equal((await app.call(`/v1/players/${account.player.id}`)).status, 200);
    assert.equal((await app.call("/v1/users/missing_player")).status, 404);
    assert.equal((await app.call("/v1/users/alice%2fbob")).status, 400);
    assert.equal((await app.call("/v1/users/%E2%84%AAelvin")).status, 400);
    assert.equal((await app.call("/v1/players", jsonBody({ username: "<script>" }))).status, 400);
    assert.equal((await app.call("/v1/players", jsonBody({ username: "valid_name", receipt: "private" }))).status, 400);
  } finally { await app.close(); }
});

test("HTTP legacy username claim is authorized only by that account's token", async () => {
  const directory = mkdtempSync(join(tmpdir(), "elo-legacy-claim-"));
  const databasePath = join(directory, "elo.sqlite");
  const setup = createStore({ databasePath, now: () => NOW });
  const legacy = newPlayer(setup, "legacy_setup");
  setup.importForm(legacy.player.id, receipt());
  const prior = setup.me(legacy.player.id).player.receipt;
  const other = newPlayer(setup, "other_player");
  setup.close();
  const db = new DatabaseSync(databasePath);
  db.prepare("UPDATE players SET username=NULL WHERE id=?").run(legacy.player.id);
  db.close();
  const app = await serve(createStore({ databasePath, now: () => NOW }));
  try {
    assert.equal((await app.call("/v1/username", jsonBody({ username: "legacy_name" }))).status, 401);
    assert.equal((await app.call("/v1/username", jsonBody({ username: "legacy_name", playerId: legacy.player.id }, other.token))).status, 400);
    assert.equal(app.store.me(legacy.player.id).player.username, null);
    const claimed = await app.call("/v1/username", jsonBody({ username: "Legacy_Name" }, legacy.token));
    assert.equal(claimed.status, 200);
    const result = await claimed.json() as ReturnType<Store["me"]>;
    assert.equal(result.player.username, "legacy_name");
    assert.deepEqual(result.player.receipt, prior);
    assert.equal(app.store.me(other.player.id).player.username, "other_player");
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("persisted weekly import budget caps changes and identical aggregates cannot grow the archive", () => {
  const directory = mkdtempSync(join(tmpdir(), "elo-import-budget-"));
  const databasePath = join(directory, "elo.sqlite");
  let time = NOW;
  let store = createStore({ databasePath, now: () => time });
  try {
    const account = newPlayer(store, "bounded_player");
    for (let index = 0; index < 5; index++) store.importForm(account.player.id, receipt(850 + index));
    const before = store.me(account.player.id);
    const alternate = buildPlayerReceipt({ player_id: `p_${"5".repeat(32)}`, competition_id: `c_${"6".repeat(32)}`,
      week_id: WEEK, form_score: 854, coverage_ppm: 900_000, certainty_ppm: 900_000 });
    assert.deepEqual(store.importForm(account.player.id, alternate), before);
    assert.throws(() => store.receipt(alternate.fingerprint), /not found/);
    assert.deepEqual(store.importForm(account.player.id, receipt(854)), before);
    assert.throws(() => store.importForm(account.player.id, receipt(855)), (error: unknown) => error instanceof ApiError && error.status === 429);
    store.close();
    store = createStore({ databasePath, now: () => time });
    assert.throws(() => store.importForm(account.player.id, receipt(856)), (error: unknown) => error instanceof ApiError && error.status === 429);
    const inspect = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(inspect.prepare("SELECT COUNT(*) AS count FROM imports").get()!.count, 5);
    assert.equal(inspect.prepare("SELECT COUNT(*) AS count FROM receipts").get()!.count, 10);
    inspect.close();
    store.joinQueue(account.player.id, "scalar");
    assert.equal(store.importForm(account.player.id, alternate).formLocked, true);
    time = new Date("2026-09-21T00:00:00Z");
    const next = store.importForm(account.player.id, receipt(855, 900_000, "2026-W38"));
    assert.equal(next.player.receipt!.form.score, 855);
    assert.equal(next.formLocked, false);
    assert.deepEqual(next.player.receipt!.elo, before.player.receipt!.elo);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("simple assessment builds strict receipts and shares import budget and locks", () => {
  const store = memory();
  try {
    const account = newPlayer(store, "simple_player");
    const value = { weekId: WEEK, formScore: 850, coveragePpm: 750_000, certaintyPpm: 900_000 };
    const me = store.assessment(account.player.id, value);
    const source = me.player.receipt!;
    validatePlayerReceipt(source);
    assert.equal(source.player_id, account.player.id);
    assert.equal(source.competition_id, store.competitionId);
    assert.equal(source.form.score, 850);
    assert.equal(source.form.confidence.effective_ppm, 750_000);
    assert.deepEqual(store.assessment(account.player.id, value), me);
    for (const patch of [{ formScore: 850.5 }, { formScore: "850" }, { coveragePpm: -1 }, { certaintyPpm: 1_000_001 }, { weekId: "2026-W99" }]) {
      assert.throws(() => store.assessment(account.player.id, { ...value, ...patch }), ApiError);
    }
    store.joinQueue(account.player.id, "scalar");
    assert.deepEqual(store.assessment(account.player.id, value), store.me(account.player.id));
    assert.throws(() => store.assessment(account.player.id, { ...value, formScore: 851 }), /locked/);
  } finally { store.close(); }
});

test("rotating token revokes old key durably and transaction failure preserves old key", () => {
  const directory = mkdtempSync(join(tmpdir(), "elo-token-rotate-"));
  const databasePath = join(directory, "elo.sqlite");
  let fail = false;
  let store = createStore({ databasePath, now: () => NOW,
    beforeCommit: operation => { if (fail && operation === "rotateToken") throw new Error("injected rotation failure"); } });
  try {
    const account = newPlayer(store, "rotate_player");
    store.importForm(account.player.id, receipt());
    const before = store.me(account.player.id);
    fail = true;
    assert.throws(() => store.rotateToken(account.player.id, token()), /injected/);
    assert.equal(store.authenticate(account.token), account.player.id);
    fail = false;
    const replacement = token();
    const rotated = store.rotateToken(account.player.id, replacement);
    assert.equal(rotated.token, replacement);
    assert.match(rotated.token, /^[0-9a-f]{64}$/);
    assert.notEqual(rotated.token, account.token);
    assert.deepEqual(rotated.player, before.player);
    assert.throws(() => store.authenticate(account.token), ApiError);
    assert.equal(store.authenticate(rotated.token), account.player.id);
    store.close();
    store = createStore({ databasePath, now: () => NOW });
    assert.throws(() => store.authenticate(account.token), ApiError);
    assert.equal(store.authenticate(rotated.token), account.player.id);
    assert.deepEqual(store.me(account.player.id), before);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("HTTP simple assessment rejects extras and token rotation requires auth", async () => {
  const app = await serve();
  try {
    const account = newPlayer(app.store, "http_simple");
    const value = { weekId: WEEK, formScore: 810, coveragePpm: 850_000, certaintyPpm: 900_000 };
    assert.equal((await app.call("/v1/assessment", jsonBody(value))).status, 401);
    const valid = await app.call("/v1/assessment", jsonBody(value, account.token));
    assert.equal(valid.status, 200);
    assert.equal((await valid.json() as ReturnType<Store["me"]>).player.receipt!.form.score, 810);
    const rejected = await app.call("/v1/assessment", jsonBody({ ...value, private_filename: "secret.txt" }, account.token));
    assert.equal(rejected.status, 400);
    assert(!JSON.stringify(await rejected.json()).includes("secret.txt"));
    assert.equal((await app.call("/v1/session/rotate", jsonBody({}))).status, 401);
    assert.equal((await app.call("/v1/session/rotate", jsonBody({ token: "unwanted" }, account.token))).status, 400);
    const rotatedResponse = await app.call("/v1/session/rotate", jsonBody({ replacementToken: token() }, account.token));
    assert.equal(rotatedResponse.status, 200);
    const rotated = await rotatedResponse.json() as ReturnType<Store["rotateToken"]>;
    assert.equal((await app.call("/v1/me", { headers: { authorization: `Bearer ${account.token}` } })).status, 401);
    assert.equal((await app.call("/v1/me", { headers: { authorization: `Bearer ${rotated.token}` } })).status, 200);
  } finally { await app.close(); }
});

test("rotation revokes already-started account writes before their bodies finish", { timeout: 10_000 }, async () => {
  const app = await serve();
  try {
    const endpoints = [
      ["/v1/session/rotate", { replacementToken: token() }],
      ["/v1/username", { username: "unused_name" }],
      ["/v1/form", { receipt: receipt() }],
      ["/v1/assessment", { weekId: WEEK, formScore: 850, coveragePpm: 900_000, certaintyPpm: 900_000 }],
      ["/v1/queue", { mode: "scalar" }],
    ] as const;
    for (const [path, value] of endpoints) {
      const account = createAccount(app.store);
      const before = app.store.me(account.player.id);
      const raw = JSON.stringify(value);
      let finish: (status: number) => void;
      const staleStatus = new Promise<number>(resolve => { finish = resolve; });
      const started = once(app.server, "request");
      const held = httpRequest(`${app.url}${path}`, { method: "POST", headers: {
        "content-type": "application/json", "content-length": Buffer.byteLength(raw),
        "x-service-key": SERVICE_KEY, "x-client-id": CLIENT_ID, authorization: `Bearer ${account.token}`,
      } }, response => { response.resume(); response.on("end", () => finish(response.statusCode!)); });
      held.write(raw.slice(0, 1));
      await started;
      const rotatedResponse = await app.call("/v1/session/rotate", jsonBody({ replacementToken: token() }, account.token));
      assert.equal(rotatedResponse.status, 200);
      const rotated = await rotatedResponse.json() as ReturnType<Store["rotateToken"]>;
      held.end(raw.slice(1));
      assert.equal(await staleStatus, 401);
      assert.equal(app.store.authenticate(rotated.token), account.player.id);
      assert.deepEqual(app.store.me(account.player.id), before);
    }
  } finally { await app.close(); }
});

test("client-known keys make signup retryable and cannot take over another account", () => {
  const store = memory();
  try {
    const saved = token();
    const first = store.createPlayer("saved_player", saved);
    assert.equal(first.token, saved);
    // A missing signup response can be recovered by retrying the saved request or using its token.
    assert.deepEqual(store.createPlayer("SAVED_PLAYER", saved), first);
    assert.equal(store.overview("scalar").stats.players, 1);
    assert.equal(store.authenticate(saved), first.player.id);
    assert.throws(() => store.createPlayer("other_name", saved), (error: unknown) => error instanceof ApiError && error.status === 409);
    assert.throws(() => store.createPlayer("saved_player", token()), (error: unknown) => error instanceof ApiError && error.status === 409);
    const other = newPlayer(store, "other_player");
    assert.throws(() => store.rotateToken(first.player.id, other.token), (error: unknown) => error instanceof ApiError && error.status === 409);
    assert.equal(store.authenticate(saved), first.player.id);
    assert.equal(store.authenticate(other.token), other.player.id);
    for (const invalid of [undefined, null, 123, "a".repeat(63), "a".repeat(65), "A".repeat(64), "z".repeat(64), ` ${token()}`]) {
      assert.throws(() => store.createPlayer("invalid_key", invalid), ApiError);
      assert.throws(() => store.rotateToken(first.player.id, invalid), ApiError);
    }
  } finally { store.close(); }
});
