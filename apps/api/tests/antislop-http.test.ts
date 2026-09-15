import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AntiSlopJudgeClaim, AntiSlopMe, DuelView, OwnedEntry, SubmitEntryRequest } from "../../../packages/public-api/antislop.ts";
import { parseAntislopJson } from "../antislop/http.ts";
import { createAntislopStore } from "../antislop/store.ts";
import { createApiServer } from "../http.ts";
import { ApiError, createStore } from "../store.ts";

const NOW = new Date("2026-09-15T12:00:00.000Z");
const SERVICE_KEY = "s".repeat(64), CLIENT_ID = "c".repeat(64);
let sequence = 0;

function submission(marker: string, optedIn = true): SubmitEntryRequest {
  return {
    requestId: randomUUID(), refereeApproved: true, optedIn,
    publicSummary: { text: `Approved ${marker}`, approved: true },
    draft: {
      version: "antislop.entry-draft.v1", status: "ready",
      window: { startsAt: "2026-09-08T12:00:00.000Z", endsAt: NOW.toISOString() },
      summary: `Private résumé 修正 ${marker}`,
      accomplishments: [{ id: "a1", outcome: `Completed ${marker}`, evidenceIds: ["e1"] }],
      evidence: [{ id: "e1", kind: "check", excerpt: `PRIVATE-HTTP-${marker} passed`, occurredAt: "2026-09-14" }],
      publicSummary: null,
    },
  };
}

async function serve(bodyTimeoutMs = 500) {
  const directory = mkdtempSync(join(tmpdir(), "antislop-http-")), databasePath = join(directory, "elo.sqlite");
  const legacy = createStore({ databasePath, now: () => NOW });
  const arena = createAntislopStore({ databasePath, now: () => NOW });
  const server = createApiServer({ store: legacy, antislop: arena, serviceKey: SERVICE_KEY, now: () => NOW.getTime(), bodyTimeoutMs });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    legacy, arena, server, url,
    player: () => legacy.createPlayer(`httptester${++sequence}`, randomBytes(32).toString("hex")),
    call: (path: string, init: RequestInit = {}) => fetch(`${url}/v1/antislop${path}`, {
      ...init, headers: { "x-service-key": SERVICE_KEY, "x-client-id": CLIENT_ID, ...Object.fromEntries(new Headers(init.headers)) },
    }),
    close: async () => { server.closeIdleConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); arena.close(); legacy.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

function post(value: unknown, token?: string): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(value) };
}

test("Unicode JSON rejects nested/escaped duplicate keys, unsafe nesting and malformed syntax", () => {
  const result = parseAntislopJson('{"summary":"café 修正 🧪","nested":{"__proto__":{"polluted":true}}}') as Record<string, unknown>;
  assert.equal(result.summary, "café 修正 🧪");
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  for (const source of ['{"a":1,"a":2}', '{"nested":{"a":1,"\\u0061":2}}', '{"__proto__":1,"__proto__":2}',
    '[1,]', '{"a":}', '{"a":01}', '{"a":Infinity}', '"unterminated', "true false", '[1e999]', "[".repeat(34) + "0" + "]".repeat(34)]) {
    assert.throws(() => parseAntislopJson(source), (error: unknown) => error instanceof ApiError && error.status === 400);
  }
});

test("authenticated entry uploads accept Unicode and bounded bodies above the legacy 16 KiB cap", async () => {
  const app = await serve();
  try {
    const account = app.player(), input = submission("large-unicode");
    input.draft.evidence = Array.from({ length: 4 }, (_, index) => ({ id: `e${index + 1}`, kind: "artifact", excerpt: "é".repeat(2_900), occurredAt: "2026-09-14" }));
    input.draft.accomplishments[0]!.evidenceIds = ["e1", "e2", "e3", "e4"];
    assert(Buffer.byteLength(JSON.stringify(input)) > 16_384);
    const response = await app.call("/entries", post(input, account.token));
    assert.equal(response.status, 201);
    const entry = await response.json() as OwnedEntry;
    assert.equal(entry.entry.summary, input.draft.summary); assert.equal(entry.entry.evidence[0]!.occurredAt, "2026-09-14");
    assert.equal(entry.participantId, account.player.id);
    const replay = await app.call("/entries", post(input, account.token));
    assert.equal(replay.status, 200); assert.equal((await replay.json() as OwnedEntry).entryId, entry.entryId);
    const publicEntry = await app.call(`/entries/${entry.entryId}`);
    const serialized = JSON.stringify(await publicEntry.json());
    assert.equal(publicEntry.status, 200); assert.equal(serialized.includes("é".repeat(20)), false); assert.equal(serialized.includes(input.draft.summary), false);
  } finally { await app.close(); }
});

test("private entry uploads enforce the expected player without storing under a different authenticated owner", async () => {
  const app = await serve();
  try {
    const expected = app.player(), active = app.player(), input = submission("expected-owner", false);
    const upload = (token: string, expectedPlayer: string) => {
      const init = post(input, token);
      return app.call("/entries", { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), "x-expected-player-id": expectedPlayer } });
    };
    const mismatch = await upload(active.token, expected.player.id);
    assert.equal(mismatch.status, 409);
    assert.equal((await mismatch.text()).includes(input.draft.summary), false);
    assert.equal(app.arena.me(active.player.id).entries.length, 0);
    assert.equal(app.arena.me(expected.player.id).entries.length, 0);
    for (const malformed of ["", "p_short", `p_${"A".repeat(32)}`, `${expected.player.id}, ${active.player.id}`, `${expected.player.id}x`]) {
      assert.equal((await upload(expected.token, malformed)).status, 400);
    }
    assert.equal(app.arena.me(expected.player.id).entries.length, 0);
    const accepted = await upload(expected.token, expected.player.id);
    assert.equal(accepted.status, 201);
    const entry = await accepted.json() as OwnedEntry;
    assert.equal(entry.participantId, expected.player.id);
    assert.equal(app.arena.me(expected.player.id).entries[0]!.entry.summary, input.draft.summary);
    assert.equal(app.arena.me(active.player.id).entries.length, 0);
  } finally { await app.close(); }
});

test("HTTP enforces account/service access, private visibility, content type, exact fields and query restrictions", async () => {
  const app = await serve();
  try {
    const account = app.player();
    assert.equal((await app.call("/me")).status, 401);
    assert.equal((await app.call("/entries", post(submission("auth")))).status, 401);
    assert.equal((await app.call("/arena", { headers: { "x-service-key": "wrong" } })).status, 401);
    assert.equal((await app.call("/arena?private=true")).status, 400);
    assert.equal((await app.call("/entries", { ...post(submission("type"), account.token), headers: { authorization: `Bearer ${account.token}`, "content-type": "text/plain" } })).status, 415);
    const extra = await app.call("/entries", post({ ...submission("extra"), private_filename: "do-not-echo-secret.txt" }, account.token));
    assert.equal(extra.status, 400); assert.equal((await extra.text()).includes("do-not-echo-secret"), false);
    const input = submission("private", false);
    const response = await app.call("/entries", post(input, account.token));
    const entry = await response.json() as OwnedEntry;
    assert.equal((await app.call(`/entries/${entry.entryId}`)).status, 404);
    assert.equal((await app.call(`/entries/${entry.entryId}`, { headers: { authorization: `Bearer ${account.token}` } })).status, 404);
    const me = await app.call("/me", { headers: { authorization: `Bearer ${account.token}` } });
    assert.equal((await me.json() as AntiSlopMe).entries[0]!.entry.summary, input.draft.summary);
    const opted = await app.call(`/entries/${entry.entryId}/participation`, post({ optedIn: true }, account.token));
    assert.equal(opted.status, 200); assert.equal((await app.call(`/entries/${entry.entryId}`)).status, 200);
    assert.equal((await app.call("/unknown")).status, 404);
  } finally { await app.close(); }
});

test("HTTP rejects duplicate JSON keys, invalid UTF-8, oversized uploads and stale approvals without reflecting content", async () => {
  const app = await serve();
  try {
    const account = app.player(), input = submission("malformed");
    const valid = JSON.stringify(input);
    const duplicates = [valid.replace('"refereeApproved":true', '"refereeApproved":false,"refereeApproved":true'),
      valid.replace('"status":"ready"', '"status":"ready","\\u0073tatus":"ready"')];
    for (const body of duplicates) {
      const response = await app.call("/entries", { ...post({}, account.token), body });
      assert.equal(response.status, 400); assert.equal((await response.text()).includes("PRIVATE-HTTP"), false);
    }
    const badUtf8 = await app.call("/entries", { ...post({}, account.token), body: new Uint8Array([0xff, 0xfe]) });
    assert.equal(badUtf8.status, 400);
    const oversized = await app.call("/entries", { ...post({}, account.token), body: "x".repeat(96 * 1024 + 1) });
    assert.equal(oversized.status, 413);
    const rejected = await app.call("/entries", post({ ...input, refereeApproved: false }, account.token));
    assert.equal(rejected.status, 400); assert.equal(app.arena.me(account.player.id).entries.length, 0);
  } finally { await app.close(); }
});

test("HTTP challenge and private claim/settle expose only structured public outcomes", async () => {
  const app = await serve();
  try {
    const a = app.player(), b = app.player(), outsider = app.player();
    const entryA = await (await app.call("/entries", post(submission("a"), a.token))).json() as OwnedEntry;
    const entryB = await (await app.call("/entries", post(submission("b"), b.token))).json() as OwnedEntry;
    const input = { requestId: randomUUID(), entryId: entryA.entryId, opponentEntryId: entryB.entryId };
    const accepted = await app.call("/duels", post(input, a.token)); assert.equal(accepted.status, 202);
    const duel = await accepted.json() as DuelView; assert.equal(duel.canJudge, true);
    assert.equal((await app.call("/duels", post(input, a.token))).status, 200);
    const internal = `/internal/duels/${duel.duelId}`;
    assert.equal((await app.call(`${internal}/claim`, post({}))).status, 401);
    assert.equal((await app.call(`${internal}/claim`, post({}, outsider.token))).status, 403);
    assert.equal((await app.call(`${internal}/claim`, { ...post({}, a.token), headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json", "x-service-key": "wrong" } })).status, 401);
    const claimed = await app.call(`${internal}/claim`, post({}, a.token)); assert.equal(claimed.status, 200);
    const claim = await claimed.json() as AntiSlopJudgeClaim;
    assert.equal((await app.call(`${internal}/claim`, post({}, b.token))).status, 409);
    const responseFor = (order: "ab" | "ba") => ({ version: "antislop.judge-response.v1", judgeFingerprint: claim.judgeFingerprint, pairFingerprint: claim.pairFingerprint, order,
      verdict: { outcome: order === "ab" ? "a_wins" : "b_wins", reason: "stronger_work", explanation: "PRIVATE-REFEREE contains an opponent detail", evidenceRefs: { a: ["e1"], b: ["e1"] } } });
    const settled = await app.call(`${internal}/settle`, post({ leaseToken: claim.leaseToken, responseAB: responseFor("ab"), responseBA: responseFor("ba") }, a.token));
    assert.equal(settled.status, 200);
    const result = await settled.json() as DuelView; assert.equal(result.outcome, "a_wins"); assert.equal(result.ratingEligible, false);
    for (const path of ["/arena", `/duels/${duel.duelId}`, `/entries/${entryA.entryId}`]) {
      const publicResponse = await app.call(path); const serialized = await publicResponse.text();
      assert.equal(serialized.includes("PRIVATE-HTTP"), false); assert.equal(serialized.includes("PRIVATE-REFEREE"), false); assert.equal(serialized.includes(claim.leaseToken), false);
    }
    const own = await app.call("/me", { headers: { authorization: `Bearer ${a.token}` } }); const ownText = await own.text();
    assert.equal(ownText.includes("PRIVATE-HTTP-b"), false); assert.equal(ownText.includes("PRIVATE-REFEREE"), false);
    assert.equal((await app.call(`/duels/${duel.duelId}`, { method: "DELETE" })).status, 404);
  } finally { await app.close(); }
});

test("account rotation revokes an already-started private upload before persistence", async () => {
  const app = await serve();
  try {
    const account = app.player(), raw = JSON.stringify(submission("rotation"));
    const started = once(app.server, "request");
    let finish: (status: number) => void = () => {};
    const responseStatus = new Promise<number>(resolve => { finish = resolve; });
    const held = httpRequest(`${app.url}/v1/antislop/entries`, { method: "POST", headers: {
      "content-type": "application/json", "content-length": Buffer.byteLength(raw), "x-service-key": SERVICE_KEY, "x-client-id": CLIENT_ID,
      authorization: `Bearer ${account.token}`, "x-expected-player-id": account.player.id,
    } }, response => { response.resume(); response.on("end", () => finish(response.statusCode!)); });
    held.write(raw.slice(0, 1)); await started;
    app.legacy.rotateToken(account.player.id, randomBytes(32).toString("hex")); held.end(raw.slice(1));
    assert.equal(await responseStatus, 401); assert.equal(app.arena.me(account.player.id).entries.length, 0);
  } finally { await app.close(); }
});

test("slow private uploads time out without storing an entry", async () => {
  const app = await serve(40);
  try {
    const account = app.player();
    let finish: (status: number) => void = () => {};
    const responseStatus = new Promise<number>(resolve => { finish = resolve; });
    const held = httpRequest(`${app.url}/v1/antislop/entries`, { method: "POST", headers: {
      "content-type": "application/json", "content-length": 1000, "x-service-key": SERVICE_KEY, "x-client-id": CLIENT_ID,
      authorization: `Bearer ${account.token}`,
    } }, response => { response.resume(); response.on("end", () => finish(response.statusCode!)); });
    held.on("error", () => {}); held.write("{");
    assert.equal(await responseStatus, 408); held.destroy();
    assert.equal(app.arena.me(account.player.id).entries.length, 0);
  } finally { await app.close(); }
});

test("owner-wide privacy erasure requires exact intent and current account binding", async () => {
  const app = await serve();
  try {
    const owner = app.player(), other = app.player();
    const entry = app.arena.submitEntry(owner.player.id, submission("erase-owner", false)).entry;
    const keep = app.arena.submitEntry(other.player.id, submission("erase-other", false)).entry;
    const erase = (body: unknown, token?: string, expected?: string) => {
      const init = post(body, token);
      return app.call("/privacy/erase", { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), ...(expected === undefined ? {} : { "x-expected-player-id": expected }) } });
    };
    assert.equal((await erase({}, undefined, owner.player.id)).status, 401);
    assert.equal((await erase({}, owner.token)).status, 400);
    assert.equal((await erase({}, owner.token, "p_invalid")).status, 400);
    assert.equal((await erase({}, other.token, owner.player.id)).status, 409);
    const extra = await erase({ playerId: other.player.id, privateText: "PRIVATE-ERASE-CANARY" }, owner.token, owner.player.id);
    assert.equal(extra.status, 400); assert.equal((await extra.text()).includes("PRIVATE-ERASE-CANARY"), false);
    assert.equal(app.arena.me(owner.player.id).entries[0]!.entryId, entry.entryId);
    for (let index = 0; index < 2; index++) {
      const response = await erase({}, owner.token, owner.player.id);
      assert.equal(response.status, 200); assert.deepEqual(await response.json(), { erased: true });
    }
    assert.equal(app.arena.me(owner.player.id).entries.length, 0);
    assert.equal(app.arena.me(other.player.id).entries[0]!.entryId, keep.entryId);
    assert.equal((await app.call("/entries", post(submission("erase-after"), owner.token))).status, 201, "deletion keeps the account usable");
  } finally { await app.close(); }
});

test("privacy erasure rechecks a bearer revoked while its request is in flight", async () => {
  const app = await serve();
  try {
    const account = app.player(); app.arena.submitEntry(account.player.id, submission("erase-revoked", false));
    const started = once(app.server, "request");
    let finish: (status: number) => void = () => {};
    const responseStatus = new Promise<number>(resolve => { finish = resolve; });
    const held = httpRequest(`${app.url}/v1/antislop/privacy/erase`, { method: "POST", headers: {
      "content-type": "application/json", "content-length": 2, "x-service-key": SERVICE_KEY, "x-client-id": CLIENT_ID,
      authorization: `Bearer ${account.token}`, "x-expected-player-id": account.player.id,
    } }, response => { response.resume(); response.on("end", () => finish(response.statusCode!)); });
    held.write("{"); await started;
    app.legacy.rotateToken(account.player.id, randomBytes(32).toString("hex")); held.end("}");
    assert.equal(await responseStatus, 401); assert.equal(app.arena.me(account.player.id).entries.length, 1);
  } finally { await app.close(); }
});
