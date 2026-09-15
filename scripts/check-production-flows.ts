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
import { createApiServer } from "../apps/api/http.ts";
import { createStore } from "../apps/api/store.ts";
import { validateMatchReceipt, validatePlayerReceipt } from "../packages/elo-engine/src/receipts.ts";

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
const cert = join(scratch, "cert.pem"), key = join(scratch, "key.pem");
let backend: HttpsServer | undefined;
let child: ChildProcess | undefined;
let base = "";
async function startBackend(port = 0) {
  assert.ok(store);
  const api = createApiServer({ store, serviceKey, now: () => rateTime });
  backend = httpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, api.listeners("request")[0] as Parameters<typeof httpsServer>[1]);
  backend.listen(port, "127.0.0.1"); await once(backend, "listening");
  return (backend.address() as AddressInfo).port;
}
async function stopBackend() {
  const server = backend; backend = undefined;
  try {
    if (server?.listening) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  } finally { const current = store; store = undefined; current?.close(); }
}
const savedTokens: string[] = [];
type Client = { username: string; token: string; cookie: string; id: string };
async function call(path: string, status: number, client?: Client, value?: unknown, method = value === undefined ? "GET" : "POST", extra: Record<string, string> = {}) {
  const response = await fetch(base + path, { method, headers: { origin: base, "content-type": "application/json", ...(client ? { cookie: client.cookie } : {}), ...extra }, ...(value === undefined ? {} : { body: typeof value === "string" ? value : JSON.stringify(value) }), signal: AbortSignal.timeout(16000), redirect: "error" });
  assert.equal(response.status, status, `${method} ${path}: unexpected status`);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  return response;
}
function secureCookie(response: Response): string {
  const header = response.headers.get("set-cookie"); assert.ok(header);
  for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) assert.ok(header.includes(flag));
  return header.split(";")[0]!;
}
function privateAbsent(text: string) {
  for (const secret of [serviceKey, ...savedTokens]) assert.ok(!text.includes(secret), "A private test key reached public content");
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
    env: { ...process.env, NODE_ENV: "production", ELO_API_URL: `https://127.0.0.1:${backendPort}`, ELO_SERVICE_KEY: serviceKey, NODE_EXTRA_CA_CERTS: cert },
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
  }
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
  assert.match(html, /870\/1000 Computer Form/); assert.equal((html.match(/<main\b/g) ?? []).length, 1); assert.match(html, /data-view="profile"/);
  const csp = page.headers.get("content-security-policy")!; const nonce = /'nonce-([^']+)'/.exec(csp)?.[1]; assert.ok(nonce);
  for (const tag of html.match(/<script\b[^>]*>/g) ?? []) assert.ok(tag.includes(`nonce="${nonce}"`));
  const png = await call(`/u/${alice.username}/opengraph-image`, 200); const bytes = Buffer.from(await png.arrayBuffer());
  assert.equal(bytes.readUInt32BE(16), 1200); assert.equal(bytes.readUInt32BE(20), 630);
  writeFileSync(join(artifacts, "flow-scorecard.png"), bytes);
  pass("actual share metadata, embedded profile, nonce-bearing HTML, archived receipt, sandbox SVG and PNG");

  rateTime += 60001;
  const replacement = randomBytes(32).toString("hex"); savedTokens.push(replacement);
  const rotation = await call("/api/session/rotate", 200, alice, { replacementToken: replacement });
  const rotatedCookie = secureCookie(rotation); assert.equal((await rotation.json()).recoveryKey, replacement);
  const revoked = await call("/api/me", 401, alice); assert.match(revoked.headers.get("set-cookie")!, /Max-Age=0/);
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

  const summary = { checkedAt: new Date().toISOString(), passed: true, testOnly: true, productionDataChanged: false, localAccounts: 4, checks, transport: "Loopback HTTP Next + HTTPS API, manual cookie headers (not a browser)", persistedRestart: true };
  writeFileSync(join(artifacts, "production-flows.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify({ passed: true, checks: checks.length, localAccounts: 4, productionDataChanged: false }));
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
