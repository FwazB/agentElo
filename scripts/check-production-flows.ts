/** Exercise the compiled Next server and a real HTTPS API + persistent SQLite.
 * Loopback-only test accounts, manual cookie transport; no browser or production writes.
 * Run with Node24 after `npm run public:build`.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as httpsServer, type Server as HttpsServer } from "node:https";
import { createServer as portServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createAntislopStore } from "../apps/api/antislop/store.ts";
import { createApiServer } from "../apps/api/http.ts";
import { createStore } from "../apps/api/store.ts";
import { validateMatchReceipt, validatePlayerReceipt } from "../packages/elo-engine/src/receipts.ts";
import type { AntiSlopMe, DuelView, OwnedEntry } from "../packages/public-api/antislop.ts";
import type { ReadyEntryDraft } from "../packages/referee/drafts.ts";
import { renderEntryGuide } from "../packages/public-api/entry-guide.ts";

const root = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "elo-production-flows-"));
const artifacts = join(root, "artifacts/robust-testing");
mkdirSync(artifacts, { recursive: true });
const checks: { name: string; passed: boolean }[] = [];
const serviceKey = randomBytes(32).toString("hex");
const databasePath = join(scratch, "league.sqlite");
const now = new Date();
let rateTime = now.getTime();
let store: ReturnType<typeof createStore> | undefined;
let antislop: ReturnType<typeof createAntislopStore> | undefined;
const cert = join(scratch, "cert.pem"), key = join(scratch, "key.pem");
let backend: HttpsServer | undefined;
let child: ChildProcess | undefined;
let base = "";
async function startBackend(port = 0) {
  assert.ok(store);
  antislop = createAntislopStore({ databasePath });
  const api = createApiServer({ store, antislop, serviceKey, now: () => rateTime });
  backend = httpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, api.listeners("request")[0] as Parameters<typeof httpsServer>[1]);
  backend.listen(port, "127.0.0.1"); await once(backend, "listening");
  return (backend.address() as AddressInfo).port;
}
async function stopBackend() {
  const server = backend; backend = undefined;
  try {
    if (server?.listening) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  } finally {
    const currentAntislop = antislop, currentStore = store;
    antislop = undefined; store = undefined;
    try { currentAntislop?.close(); } finally { currentStore?.close(); }
  }
}
const savedTokens: string[] = [];
const privateCanaries = ["PRIVATE_NOTE_CANARY", "PRIVATE_METADATA_CANARY"];
type Client = { username: string; token: string; cookie: string; id: string };
async function call(path: string, status: number, client?: Client, value?: unknown, method = value === undefined ? "GET" : "POST", extra: Record<string, string> = {}) {
  const response = await fetch(base + path, { method, headers: { origin: base, "content-type": "application/json", ...(client ? { cookie: client.cookie } : {}), ...(client && method === "POST" && path === "/api/antislop/entries" ? { "X-Expected-Player-Id": client.id } : {}), ...extra }, ...(value === undefined ? {} : { body: typeof value === "string" ? value : JSON.stringify(value) }), signal: AbortSignal.timeout(16000), redirect: "error" });
  assert.equal(response.status, status, `${method} ${path}: unexpected status`);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  return response;
}
function secureCookies(response: Response): string[] {
  const headers = response.headers.getSetCookie(); assert.ok(headers.length > 0);
  for (const header of headers) {
    for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) assert.ok(header.includes(flag));
  }
  return headers.map(header => header.split(";")[0]!);
}
function secureCookie(response: Response): string {
  return secureCookies(response)[0]!;
}
function privateAbsent(text: string) {
  for (const secret of [serviceKey, ...savedTokens, ...privateCanaries]) assert.ok(!text.includes(secret), "Private test content reached a public response");
}
async function createClient(username: string): Promise<Client> {
  const token = randomBytes(32).toString("hex"); savedTokens.push(token);
  const response = await call("/api/players", 201, undefined, { username, token });
  const cookie = secureCookie(response); const body = await response.json();
  assert.equal(body.recoveryKey, token); assert.equal(body.token, undefined);
  return { username, token, cookie, id: body.player.id };
}
const pass = (name: string) => checks.push({ name, passed: true });
try {
  store = createStore({ databasePath, now: () => now });
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore", timeout: 10000 });
  const backendPort = await startBackend();
  const free = portServer();
  let port: number;
  try {
    free.listen(0, "127.0.0.1"); await once(free, "listening");
    port = (free.address() as AddressInfo).port;
  } finally { if (free.listening) await new Promise<void>(resolve => free.close(() => resolve())); }
  child = spawn(process.execPath, [join(root, "apps/public/node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: join(root, "apps/public"),
    env: { ...process.env, NODE_ENV: "production", ELO_API_URL: `https://127.0.0.1:${backendPort}`, ELO_SERVICE_KEY: serviceKey, NODE_EXTRA_CA_CERTS: cert, VERCEL_OIDC_TOKEN: "" },
    stdio: "ignore",
  });
  let spawnFailed = false; child.on("error", () => { spawnFailed = true; });
  // NextURL canonicalizes loopback IPs to localhost. Use that origin without
  // relaxing the application's same-origin rules.
  base = `http://localhost:${port}`;
  let ready = false;
  const startupDeadline = Date.now() + 15000;
  while (Date.now() < startupDeadline) {
    assert.ok(!spawnFailed && child.exitCode === null, "Compiled Next process exited before readiness");
    try { const response = await fetch(base, { signal: AbortSignal.timeout(1000) }); await response.body?.cancel(); if (response.status === 200) { ready = true; break; } }
    catch { /* Retry only until the startup deadline. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, "Compiled Next server did not start");
  const entryReference = await call("/entry.md", 200);
  assert.equal(entryReference.headers.get("cache-control"), "no-store");
  const entryText = await entryReference.text();
  const entryEnd = /^Window: .+ inclusive to (.+) exclusive$/m.exec(entryText)?.[1];
  assert.ok(entryEnd);
  assert.equal(entryText, renderEntryGuide(new Date(entryEnd)));
  // The compiled production route rejects this test server's untrusted loopback
  // authority. Accepted modern/legacy sessions are covered by the SDK tests; the
  // live reference check exercises the deployed public authority separately.
  await call("/mcp", 403, undefined, { jsonrpc: "2.0", id: 1, method: "prompts/list" });
  pass("compiled canonical entry reference and MCP authority boundary");
  const firstOverview = await (await call("/api/overview", 200)).json();
  const weekId = firstOverview.weekId;
  assert.equal(firstOverview.stats.players, 0);
  const alice = await createClient("flow_alice"), bob = await createClient("flow_bob");
  const retry = await call("/api/players", 201, undefined, { username: alice.username, token: alice.token });
  assert.equal((await retry.json()).player.id, alice.id);
  await call("/api/players", 409, alice, { username: "another_person", token: randomBytes(32).toString("hex") });
  await call("/api/players", 409, undefined, { username: alice.username, token: randomBytes(32).toString("hex") });
  pass("real Next BFF signup, secure cookies, same-key retry and username/session collision");

  const assessment = (formScore: number, confidence = 850000) => ({ weekId, formScore, coveragePpm: confidence, certaintyPpm: 900000 });
  await call("/api/assessment", 401, undefined, assessment(850));
  await call("/api/assessment", 403, alice, assessment(850), "POST", { origin: "https://foreign.invalid" });
  await call("/api/assessment", 403, alice, assessment(850), "POST", { "sec-fetch-site": "cross-site" });
  await call("/api/assessment", 415, alice, JSON.stringify(assessment(850)), "POST", { "content-type": "text/plain" });
  const rejected = await call("/api/assessment", 400, alice, { ...assessment(850), notes: "PRIVATE_NOTE_CANARY" });
  assert.ok(!(await rejected.text()).includes("PRIVATE_NOTE_CANARY"));
  await call("/api/assessment", 413, alice, " ".repeat(16385));
  await call("/api/assessment", 422, alice, assessment(850, 0));
  const publicAlice = await (await call(`/api/users/${alice.username}`, 200)).text(); privateAbsent(publicAlice);
  assert.equal(JSON.parse(publicAlice).player.receipt, null);
  pass("BFF enforces authentication, same-origin, type/size/private-field boundaries and zero-evidence gate");

  rateTime += 60001;
  for (const [client, score] of [[alice, 870], [bob, 730]] as const) {
    const published = await (await call("/api/assessment", 200, client, assessment(score))).json();
    validatePlayerReceipt(published.player.receipt);
    assert.equal(published.player.receipt.form.score, score);
    assert.equal(published.player.assessmentContext, undefined);
  }
  const initialReceipt = (await (await call("/api/me", 200, alice)).json()).player.receipt;
  const context = { aiSystem: "codex", contextSource: "activity_records" };
  const labelledAssessment = { ...assessment(870), ...context };
  const labelled = await (await call("/api/assessment", 200, alice, labelledAssessment)).json();
  assert.deepEqual(labelled.player.assessmentContext, context);
  validatePlayerReceipt(labelled.player.receipt);
  assert.deepEqual(labelled.player.receipt, initialReceipt, "Adding labels must not change receipt math or fingerprint");
  for (const path of [`/api/users/${alice.username}`, `/api/players/${alice.id}`]) {
    const text = await (await call(path, 200)).text(); privateAbsent(text);
    const visible = JSON.parse(text);
    assert.deepEqual(visible.player.assessmentContext, context);
    assert.deepEqual(visible.player.receipt, initialReceipt);
  }
  const initialArchive = await (await call(`/api/receipts/${encodeURIComponent(initialReceipt.fingerprint)}`, 200)).json();
  assert.deepEqual(initialArchive, initialReceipt, "Optional labels must remain outside canonical receipts");
  for (const invalid of [
    { ...labelledAssessment, aiSystem: "PRIVATE_METADATA_CANARY" },
    { ...labelledAssessment, contextSource: "PRIVATE_METADATA_CANARY" },
    { ...labelledAssessment, aiSystem: { notes: "PRIVATE_METADATA_CANARY" } },
    { ...assessment(870), aiSystem: "codex" },
    { ...labelledAssessment, notes: "PRIVATE_METADATA_CANARY" },
  ]) {
    const response = await call("/api/assessment", 400, alice, invalid);
    privateAbsent(await response.text());
  }
  const unchangedPublicText = await (await call(`/api/users/${alice.username}`, 200)).text(); privateAbsent(unchangedPublicText);
  const unchangedPublic = JSON.parse(unchangedPublicText);
  assert.deepEqual(unchangedPublic.player.assessmentContext, context);
  assert.deepEqual(unchangedPublic.player.receipt, initialReceipt);

  const optedOut = await (await call("/api/assessment", 200, alice, assessment(870))).json();
  assert.equal(optedOut.player.assessmentContext, undefined, "The four-field opt-out must clear labels even when its score is identical");
  assert.deepEqual(optedOut.player.receipt, initialReceipt);
  for (const path of ["/api/me", `/api/users/${alice.username}`, `/api/players/${alice.id}`]) {
    const visible = await (await call(path, 200, path === "/api/me" ? alice : undefined)).json();
    assert.equal(visible.player.assessmentContext, undefined);
    assert.deepEqual(visible.player.receipt, initialReceipt);
  }
  await call("/api/assessment", 200, alice, labelledAssessment);
  pass("four/six-field assessment compatibility, public AI/context labels, same-score opt-out, private metadata rejection and unchanged receipts");

  const before = await (await call("/api/me", 200, alice)).json();
  const attack = await call("/api/assessment", 400, alice, { ...assessment(999), playerId: bob.id });
  privateAbsent(await attack.text());
  const bobAfter = await (await call("/api/me", 200, bob)).json(); assert.equal(bobAfter.player.receipt.form.score, 730);
  assert.equal((await (await call("/api/queue", 200, alice, { mode: "scalar" })).json()).status, "queued");
  await call("/api/queue?mode=scalar", 200, alice, undefined, "DELETE");
  await call("/api/assessment", 409, alice, assessment(999));
  await call("/api/queue", 200, alice, { mode: "scalar" });
  const pair = await (await call("/api/queue", 200, bob, { mode: "scalar" })).json();
  validateMatchReceipt(pair.match); assert.equal(pair.match.rating_effect, "rated");
  assert.equal(pair.match.players.a.applied_delta_milli + pair.match.players.b.applied_delta_milli, 0);
  const replay = await (await call("/api/queue", 200, alice, { mode: "scalar" })).json();
  assert.equal(replay.match.fingerprint, pair.match.fingerprint);
  for (const client of [alice, bob]) await call("/api/queue", 200, client, { mode: "binary" });
  const afterBoth = await (await call("/api/me", 200, alice)).json();
  assert.equal(afterBoth.player.receipt.elo.scalar.rated_matches, 1); assert.equal(afterBoth.player.receipt.elo.binary.rated_matches, 1);
  assert.equal(before.player.receipt.elo.scalar.rated_matches, 0);
  pass("explicit queue/cancel locks, both mode ratings, receipt validation, replay and cross-account isolation");

  const archive = await (await call(`/api/receipts/${encodeURIComponent(pair.match.fingerprint)}`, 200)).json();
  validateMatchReceipt(archive); assert.equal(archive.fingerprint, pair.match.fingerprint);
  const svg = await call(`/api/matches/${pair.match.match_id}/card.svg`, 200);
  assert.match(svg.headers.get("content-type")!, /image\/svg\+xml/); assert.match(svg.headers.get("content-security-policy")!, /sandbox/); privateAbsent(await svg.text());
  const page = await call(`/u/${alice.username}`, 200); const html = await page.text(); privateAbsent(html);
  assert.match(html, /<title>@flow_alice · 870\/1000 · AntiSlop<\/title>/);
  assert.match(html, /My AI rated me with a 870\/1000\. What’s your Elo\?/);
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
  assert.match(html, /name="twitter:image" content="https:\/\/antislop\.org\/u\/flow_alice\/opengraph-image"/);
  assert.equal((html.match(/<main\b/g) ?? []).length, 1); assert.match(html, /data-view="profile"/);
  const csp = page.headers.get("content-security-policy")!; const nonce = /'nonce-([^']+)'/.exec(csp)?.[1]; assert.ok(nonce);
  for (const tag of html.match(/<script\b[^>]*>/g) ?? []) assert.ok(tag.includes(`nonce="${nonce}"`));
  const png = await call(`/u/${alice.username}/opengraph-image`, 200); const bytes = Buffer.from(await png.arrayBuffer());
  assert.equal(bytes.readUInt32BE(16), 1200); assert.equal(bytes.readUInt32BE(20), 630);
  writeFileSync(join(artifacts, "flow-scorecard.png"), bytes);
  pass("actual share metadata, embedded profile, nonce-bearing HTML, archived receipt, sandbox SVG and PNG");

  // Synthetic local entries only. The child has no Gateway credential, and this
  // group never starts judging or sends evidence to an external provider.
  rateTime += 60001;
  const beforeAntislopReceipt = (await (await call("/api/me", 200, alice)).json()).player.receipt;
  const prompt: { prompt: string; window: ReadyEntryDraft["window"] } = await (await call("/api/antislop/prompt", 200)).json();
  assert.equal(Date.parse(prompt.window.endsAt) - Date.parse(prompt.window.startsAt), 604800000);
  assert.ok(prompt.prompt.includes(prompt.window.endsAt));
  const antiCanaries = ["ANTISLOP_ALICE_PRIVATE_CANARY", "ANTISLOP_BOB_PRIVATE_CANARY"];
  privateCanaries.push(...antiCanaries);
  const entries: OwnedEntry[] = [];
  for (const [index, client] of [alice, bob].entries()) {
    const draft: ReadyEntryDraft = {
      version: "antislop.entry-draft.v1", status: "ready", window: { ...prompt.window },
      summary: `${antiCanaries[index]}: synthetic local repair fixture.`,
      accomplishments: [{ id: "a1", outcome: "Synthetic keyboard repair completed.", evidenceIds: ["e1"] }],
      evidence: [{ id: "e1", kind: "check", excerpt: `${antiCanaries[index]}: synthetic local check passed.`, occurredAt: prompt.window.endsAt.slice(0, 10) }],
      publicSummary: null,
    };
    const request = { requestId: `flow-entry-${index}`, draft, refereeApproved: true, publicSummary: index === 0 ? { text: "A synthetic public repair summary.", approved: true } : null, optedIn: false };
    if (index === 0) {
      await call("/api/antislop/entries", 400, client, { ...request, refereeApproved: false });
      await call("/api/antislop/entries", 400, client, request, "POST", { "X-Expected-Player-Id": "" });
      // Reproduce another tab changing the browser cookie after Alice approved
      // the draft. The private upload must never be stored under Bob's player.
      await call("/api/antislop/entries", 409, client, request, "POST", { cookie: bob.cookie });
      const wrongOwner: AntiSlopMe = await (await call("/api/antislop/me", 200, bob)).json();
      assert.equal(wrongOwner.entries.length, 0);
    }
    const entry: OwnedEntry = await (await call("/api/antislop/entries", 201, client, request)).json();
    assert.equal(entry.entry.participantId, client.id);
    assert.equal(entry.entry.entryId, entry.entryId);
    assert.equal(entry.entry.evidence[0]!.occurredAt, draft.evidence[0]!.occurredAt);
    assert.equal(entry.optedIn, false);
    assert.ok(entry.entry.summary.includes(antiCanaries[index]!));
    privateAbsent(await (await call(`/api/antislop/entries/${entry.entryId}`, 404)).text());
    if (index === 0) assert.deepEqual(await (await call("/api/antislop/entries", 200, client, request)).json(), entry);
    entries.push(entry);
  }
  const [aliceEntry, bobEntry] = entries; assert.ok(aliceEntry && bobEntry);
  const publicParticipation = await (await call(`/api/antislop/entries/${aliceEntry.entryId}/participation`, 200, alice, { optedIn: true })).text();
  privateAbsent(publicParticipation);
  assert.equal(JSON.parse(publicParticipation).entry, undefined);
  await call(`/api/antislop/entries/${aliceEntry.entryId}/participation`, 404, bob, { optedIn: false });
  const duelRequest = { requestId: "flow-duel-1", entryId: aliceEntry.entryId, opponentEntryId: bobEntry.entryId };
  await call("/api/antislop/duels", 409, alice, duelRequest);
  privateAbsent(await (await call(`/api/antislop/entries/${bobEntry.entryId}/participation`, 200, bob, { optedIn: true })).text());
  const antiDuel: DuelView = await (await call("/api/antislop/duels", 202, alice, duelRequest)).json();
  assert.equal(antiDuel.state, "pending"); assert.equal(antiDuel.outcome, null); assert.equal(antiDuel.ratingEligible, false);
  assert.equal(antiDuel.a.publicSummary, "A synthetic public repair summary."); assert.equal(antiDuel.b.publicSummary, null);
  assert.equal(Object.hasOwn(antiDuel.a, "entry"), false); assert.equal(Object.hasOwn(antiDuel, "privateVerdicts"), false);
  const antiReplay: DuelView = await (await call("/api/antislop/duels", 200, bob, { requestId: "flow-duel-reverse", entryId: bobEntry.entryId, opponentEntryId: aliceEntry.entryId })).json();
  assert.equal(antiReplay.duelId, antiDuel.duelId);
  for (const path of ["/api/antislop/arena", `/api/antislop/entries/${aliceEntry.entryId}`, `/api/antislop/duels/${antiDuel.duelId}`, `/challenge/${aliceEntry.entryId}`, `/duel/${antiDuel.duelId}`]) {
    privateAbsent(await (await call(path, 200)).text());
  }
  const beforeAntislopRestart: AntiSlopMe = await (await call("/api/antislop/me", 200, alice)).json();
  assert.equal(beforeAntislopRestart.entries[0]!.entryId, aliceEntry.entryId);
  assert.ok(JSON.stringify(beforeAntislopRestart).includes(antiCanaries[0]!));
  assert.ok(!JSON.stringify(beforeAntislopRestart).includes(antiCanaries[1]!));
  for (const operation of ["claim", "settle", "fail"]) await call(`/api/antislop/internal/duels/${antiDuel.duelId}/${operation}`, 404, alice, {});
  assert.deepEqual((await (await call("/api/me", 200, alice)).json()).player.receipt, beforeAntislopReceipt);
  pass("AntiSlop BFF approval and expected-player binding, immutable retry, opt-in ownership, on-demand pair replay, public privacy and internal-route isolation without provider calls");

  rateTime += 60001;
  const replacement = randomBytes(32).toString("hex"); savedTokens.push(replacement);
  const rotation = await call("/api/session/rotate", 200, alice, { replacementToken: replacement });
  const rotatedCookie = secureCookie(rotation); assert.equal((await rotation.json()).recoveryKey, replacement);
  const revoked = await call("/api/me", 401, alice); assert.equal(revoked.headers.get("set-cookie"), null);
  await call("/api/session", 401, undefined, { token: alice.token });
  const restored = await call("/api/session", 200, undefined, { token: replacement });
  const restoredCookie = secureCookie(restored); assert.equal(restoredCookie, rotatedCookie);
  assert.equal((await restored.json()).player.id, alice.id); alice.cookie = restoredCookie; alice.token = replacement;
  const beforeRestart = await (await call("/api/me", 200, alice)).json();
  await stopBackend();
  const unavailable = await call("/api/overview", 502); const unavailableText = await unavailable.text(); privateAbsent(unavailableText);
  assert.match(unavailableText, /temporarily unavailable/);
  const signedOut = await call("/api/session", 200, alice, undefined, "DELETE"); assert.match(signedOut.headers.get("set-cookie")!, /Max-Age=0/);
  store = createStore({ databasePath, now: () => now }); await startBackend(backendPort);
  const afterRestart = await (await call("/api/me", 200, alice)).json(); assert.deepEqual(afterRestart, beforeRestart);
  const afterAntislopRestart: AntiSlopMe = await (await call("/api/antislop/me", 200, alice)).json();
  assert.deepEqual(afterAntislopRestart, beforeAntislopRestart, "The same SQLite restart must preserve AntiSlop snapshots, participation and duel state");
  assert.equal((await (await call("/api/overview", 200)).json()).competitionId, firstOverview.competitionId);
  pass("rotation revokes old key, saved replacement recovers account, outage is explicit, logout works offline, SQLite restart preserves ledger");

  const charlie = await createClient("flow_charlie"), dana = await createClient("flow_dana");
  for (const [client, score] of [[charlie, 900], [dana, 300]] as const) await call("/api/assessment", 200, client, assessment(score, 430000));
  await call("/api/queue", 200, charlie, { mode: "scalar" });
  const exhibition = await (await call("/api/queue", 200, dana, { mode: "scalar" })).json();
  validateMatchReceipt(exhibition.match); assert.equal(exhibition.match.rating_effect, "exhibition");
  assert.equal(exhibition.match.players.a.applied_delta_milli, 0); assert.equal(exhibition.match.players.b.applied_delta_milli, 0);
  assert.equal((await (await call("/api/me", 200, charlie)).json()).player.receipt.elo.scalar.rated_matches, 0);
  pass("grounded 43% confidence stays shareable and exhibition-only through the compiled production proxy");

  rateTime += 60001;
  const playersBeforeGuest = (await (await call("/api/overview", 200)).json()).stats.players;
  const bootstrap = await call("/api/guest/session", 200, undefined, {});
  const bootstrapCookies = secureCookies(bootstrap);
  assert.ok(bootstrapCookies.length >= 2, "Guest bootstrap needs a session and its signed pending marker");
  const sessionCookie = bootstrapCookies.find(cookie => cookie.startsWith("elo_session="));
  assert.ok(sessionCookie && /^elo_session=[0-9a-f]{64}$/.test(sessionCookie), "Guest session must be an opaque credential");
  const guestToken = sessionCookie.slice("elo_session=".length); savedTokens.push(guestToken);
  const cookieJar = new Map(bootstrapCookies.map(cookie => [cookie.slice(0, cookie.indexOf("=")), cookie.slice(cookie.indexOf("=") + 1)]));
  const guestCookies = () => [...cookieJar].map(([name, value]) => `${name}=${value}`).join("; ");
  const updateGuestCookies = (response: Response) => {
    const headers = response.headers.getSetCookie();
    if (headers.length === 0) return;
    const pairs = secureCookies(response);
    for (const [index, pair] of pairs.entries()) {
      const separator = pair.indexOf("="), name = pair.slice(0, separator);
      if (/\bMax-Age=0\b/i.test(headers[index]!)) cookieJar.delete(name);
      else cookieJar.set(name, pair.slice(separator + 1));
    }
  };
  const bootstrapText = await bootstrap.text(); privateAbsent(bootstrapText);
  for (const cookie of bootstrapCookies) assert.ok(!bootstrapText.includes(cookie.slice(cookie.indexOf("=") + 1)), "Guest acknowledgement must not expose cookie contents");
  const acknowledgement = JSON.parse(bootstrapText);
  for (const field of ["token", "recoveryKey", "player"]) assert.ok(!Object.hasOwn(acknowledgement, field), "Guest bootstrap must acknowledge without exposing credentials or allocating a player");
  assert.equal((await (await call("/api/overview", 200)).json()).stats.players, playersBeforeGuest);
  const guestName = { username: "flow_guest" };
  await call("/api/guest/player", 401, undefined, guestName);
  for (const [path, body] of [["/api/guest/session", {}], ["/api/guest/player", guestName]] as const) {
    const headers = { cookie: guestCookies() };
    assert.equal((await call(`${path}?unexpected=1`, 400, undefined, body, "POST", headers)).headers.get("set-cookie"), null);
    assert.equal((await call(path, 403, undefined, body, "POST", { ...headers, origin: "https://foreign.invalid" })).headers.get("set-cookie"), null);
    assert.equal((await call(path, 403, undefined, body, "POST", { ...headers, "sec-fetch-site": "cross-site" })).headers.get("set-cookie"), null);
  }
  const namedGuestResponse = await call("/api/guest/player", 201, undefined, guestName, "POST", { cookie: guestCookies() });
  updateGuestCookies(namedGuestResponse);
  assert.ok(!cookieJar.has("elo_pending"), "Naming a guest must retire the pending marker before the account retry");
  assert.ok(cookieJar.get("elo_session") === guestToken, "Naming a guest must preserve the browser session credential");
  const namedGuestText = await namedGuestResponse.text(); privateAbsent(namedGuestText);
  const namedGuest = JSON.parse(namedGuestText);
  for (const field of ["token", "recoveryKey"]) assert.ok(!Object.hasOwn(namedGuest, field), "Naming a guest returns the account view, never credentials");
  assert.equal(namedGuest.player.username, guestName.username);
  assert.equal(namedGuest.player.receipt, null);
  const guest: Client = { ...guestName, id: namedGuest.player.id, token: guestToken, cookie: guestCookies() };
  const retriedGuest = await call("/api/guest/player", 201, guest, guestName);
  const retriedGuestText = await retriedGuest.text(); privateAbsent(retriedGuestText);
  assert.equal(JSON.parse(retriedGuestText).player.id, guest.id);
  await call("/api/guest/player", 409, guest, { username: "flow_guest_other" });
  assert.equal((await (await call("/api/me", 200, guest)).json()).player.id, guest.id);
  const localAccounts = (await (await call("/api/overview", 200)).json()).stats.players;
  assert.equal(localAccounts, playersBeforeGuest + 1); assert.equal(localAccounts, 5);
  pass("guest bootstrap allocates no player, secures both cookies without exposing credentials, and binds one idempotent username behind origin/query/session guards");

  const summary = { checkedAt: new Date().toISOString(), passed: true, testOnly: true, productionDataChanged: false, localAccounts, checks, transport: "Loopback HTTP Next + HTTPS API, manual cookie headers (not a browser)", persistedRestart: true };
  writeFileSync(join(artifacts, "production-flows.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify({ passed: true, checks: checks.length, localAccounts, productionDataChanged: false }));
} catch (error) {
  const summary = { checkedAt: new Date().toISOString(), passed: false, testOnly: true, checks, error: error instanceof Error ? error.message : "Failed", productionDataChanged: false };
  writeFileSync(join(artifacts, "production-flows.json"), JSON.stringify(summary, null, 2) + "\n");
  throw error;
} finally {
  try {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const processToStop = child;
      let deadline: ReturnType<typeof setTimeout>;
      const stopped = once(processToStop, "exit");
      const forced = new Promise<void>(resolve => { deadline = setTimeout(() => { processToStop.kill("SIGKILL"); resolve(); }, 4000); });
      processToStop.kill("SIGTERM");
      try { await Promise.race([stopped, forced]); } finally { clearTimeout(deadline!); }
    }
  } finally { try { await stopBackend(); } finally { rmSync(scratch, { recursive: true, force: true }); } }
}
