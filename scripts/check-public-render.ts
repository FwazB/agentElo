import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as httpsServer } from "node:https";
import { createServer as portServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createApiServer } from "../apps/api/http.ts";
import { createStore } from "../apps/api/store.ts";

const root = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "elo-render-"));
const artifacts = join(root, process.env.ELO_RENDER_ARTIFACTS ?? "artifacts/security");
mkdirSync(artifacts, { recursive: true });
const serviceKey = randomBytes(32).toString("hex");
const store = createStore({ databasePath: ":memory:", now: () => new Date("2026-09-14T16:00:00Z") });
const username = "abcdefghijklmnopqrst";
const player = store.createPlayer(username, randomBytes(32).toString("hex"));
store.assessment(player.player.id, { weekId: "2026-W37", formScore: 1000, coveragePpm: 430000, certaintyPpm: 850000 });
const api = createApiServer({ store, serviceKey });
const cert = join(scratch, "cert.pem"), key = join(scratch, "key.pem");
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
const backend = httpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, api.listeners("request")[0] as Parameters<typeof httpsServer>[1]);
backend.listen(0, "127.0.0.1"); await once(backend, "listening");
const free = portServer(); free.listen(0, "127.0.0.1"); await once(free, "listening");
const port = (free.address() as AddressInfo).port; await new Promise<void>(resolve => free.close(() => resolve()));
const child = spawn(process.execPath, [join(root, "apps/public/node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(port)], {
  cwd: join(root, "apps/public"),
  env: { ...process.env, NODE_ENV: "production", ELO_API_URL: `https://127.0.0.1:${(backend.address() as AddressInfo).port}`, ELO_SERVICE_KEY: serviceKey, NODE_EXTRA_CA_CERTS: cert },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = ""; child.stdout.on("data", value => { logs += value; }); child.stderr.on("data", value => { logs += value; });
const base = `http://127.0.0.1:${port}`;
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await fetch(base); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(ready, logs);
  const response = await fetch(`${base}/u/${username}`, { headers: { "user-agent": "Twitterbot/1.0" } });
  const html = await response.text(); assert.equal(response.status, 200, logs);
  const csp = response.headers.get("content-security-policy")!;
  const nonce = /'nonce-([^']+)'/.exec(csp)?.[1]; assert.ok(nonce);
  const scripts = html.match(/<script\b[^>]*>/g) ?? []; assert.ok(scripts.length > 0);
  for (const tag of scripts) assert.ok(tag.includes(`nonce="${nonce}"`), tag);
  assert.match(html, /summary_large_image/); assert.match(html, /1000\/1000 Computer Form/);
  assert.ok(html.includes(`https://antislop.org/u/${username}/opengraph-image`));
  assert.ok(!html.includes(serviceKey));
  const second = await fetch(base); assert.notEqual(second.headers.get("content-security-policy"), csp);
  const png = await fetch(`${base}/u/${username}/opengraph-image`);
  assert.equal(png.status, 200, logs); assert.match(png.headers.get("content-type")!, /image\/png/);
  const bytes = Buffer.from(await png.arrayBuffer()); assert.equal(bytes.readUInt32BE(16), 1200); assert.equal(bytes.readUInt32BE(20), 630);
  writeFileSync(join(artifacts, "share-card-test.png"), bytes);
  assert.equal((await fetch(`${base}/u/not_registered`)).status, 404);
  const overview = await fetch(`${base}/api/overview`); assert.equal(overview.status, 200);
  const summary = { testOnly: true, productionDataChanged: false, profileStatus: response.status, matchingNonceScripts: scripts.length, freshNonce: true, socialMetadata: true, imageStatus: png.status, imageSize: "1200x630", missingUserStatus: 404, apiOverviewStatus: overview.status };
  writeFileSync(join(artifacts, "public-render-check.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary));
} catch (error) { console.error(logs); throw error; }
finally {
  if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
  backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve()));
  store.close(); rmSync(scratch, { recursive: true, force: true });
}
