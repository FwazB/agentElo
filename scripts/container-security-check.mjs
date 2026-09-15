import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const image = process.env.CONTAINER_TEST_IMAGE ?? "computer-elo-security:local";
const output = resolve(process.env.CONTAINER_REPORT_DIR ?? "artifacts/security");
await mkdir(output, { recursive: true });
const docker = async (args, env = {}) => (await execute("docker", args, {
  env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024,
})).stdout.trim();
const imageInfo = JSON.parse(await docker(["image", "inspect", image]))[0];
const runId = `elo-security-${randomBytes(6).toString("hex")}`;
const containers = new Set();
const volumes = new Set();
const checks = [];
const serviceKey = randomBytes(32).toString("hex");
const legacyToken = randomBytes(32).toString("hex");
const clientId = "c".repeat(64);
const legacyId = `p_${"1".repeat(32)}`;

async function volume(suffix) {
  const name = `${runId}-${suffix}`;
  await docker(["volume", "create", name]);
  volumes.add(name);
  return name;
}
async function helper(vol, code) {
  return docker(["run", "--rm", "--entrypoint", "node", "-e", "SEED_TOKEN", "--mount", `type=volume,source=${vol},target=/data`, imageInfo.Id, "-e", code], { SEED_TOKEN: legacyToken });
}
async function launch(vol, suffix, publish = false) {
  const name = `${runId}-${suffix}`;
  containers.add(name);
  await docker(["run", "--detach", "--name", name, "--mount", `type=volume,source=${vol},target=/data`,
    "-e", "SERVICE_KEY", ...(publish ? ["-p", "127.0.0.1::8787"] : []), imageInfo.Id], { SERVICE_KEY: serviceKey });
  return name;
}
async function healthy(url) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("Container health endpoint did not become ready.");
}

if (!process.argv.includes("--scan-only")) try {
  const data = await volume("data");
  const seeded = JSON.parse(await helper(data, `
    const { DatabaseSync } = require('node:sqlite');
    const fs = require('node:fs');
    const crypto = require('node:crypto');
    const db = new DatabaseSync('/data/elo.sqlite');
    db.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE players(id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,receipt TEXT,import_fingerprint TEXT,created_at INTEGER NOT NULL);');
    db.prepare('INSERT INTO metadata VALUES (?,?)').run('competition_id','c_${"2".repeat(32)}');
    db.prepare('INSERT INTO players VALUES (?,?,?,?,?)').run('${legacyId}',crypto.createHash('sha256').update(process.env.SEED_TOKEN).digest('hex'),null,null,0);
    db.close();
    fs.writeFileSync('/data/untouched.txt','sentinel');
    fs.chmodSync('/data',0o755); fs.chmodSync('/data/elo.sqlite',0o666);
    console.log(JSON.stringify({directoryUid:fs.statSync('/data').uid,databaseUid:fs.statSync('/data/elo.sqlite').uid}));
  `));
  assert.equal(seeded.directoryUid, 0);
  assert.equal(seeded.databaseUid, 0);
  const container = await launch(data, "api", true);
  const address = await docker(["port", container, "8787/tcp"]);
  let url = `http://${address}`;
  await healthy(url);
  const state = JSON.parse(await docker(["exec", container, "node", "-e", `
    const fs=require('node:fs');
    const status=fs.readFileSync('/proc/1/status','utf8');
    const fields=Object.fromEntries(status.split(String.fromCharCode(10)).filter(line=>/^(Uid|Gid|Groups|CapEff|CapPrm):/.test(line)).map(line=>{const i=line.indexOf(':');return[line.slice(0,i),line.slice(i+1).trim()]}));
    const stat=path=>{const s=fs.statSync(path);return {uid:s.uid,gid:s.gid,mode:s.mode&0o777}};
    console.log(JSON.stringify({process:fields,directory:stat('/data'),database:stat('/data/elo.sqlite'),untouched:stat('/data/untouched.txt')}));
  `]));
  assert(state.process.Uid.split(/\s+/).every(value => value === "1000"));
  assert(state.process.Gid.split(/\s+/).every(value => value === "1000"));
  assert.equal(state.process.CapEff, "0000000000000000");
  assert.equal(state.process.CapPrm, "0000000000000000");
  assert.equal(state.process.Groups, "");
  assert.deepEqual(state.directory, { uid: 1000, gid: 1000, mode: 0o700 });
  assert.deepEqual(state.database, { uid: 1000, gid: 1000, mode: 0o600 });
  assert.equal(state.untouched.uid, 0);
  checks.push({ name: "root-owned volume and legacy schema migrate before non-root application startup", passed: true, state });

  async function api(path, token, value, method = value === undefined ? "GET" : "POST") {
    const response = await fetch(`${url}${path}`, { method, headers: {
      "x-service-key": serviceKey, "x-client-id": clientId,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(value !== undefined ? { "content-type": "application/json" } : {}),
    }, ...(value !== undefined ? { body: JSON.stringify(value) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  const legacy = await api("/v1/me", legacyToken);
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.player.id, legacyId);
  assert.equal(legacy.body.player.username, null);
  assert.equal((await api("/v1/username", legacyToken, { username: "legacy_player" })).status, 200);
  const savedToken = randomBytes(32).toString("hex");
  const signup = await api("/v1/players", null, { username: "fresh_player", token: savedToken });
  assert.equal(signup.status, 201);
  assert.equal(signup.body.token, savedToken);
  const overview = await api("/v1/overview");
  for (const [token, score] of [[legacyToken, 900], [savedToken, 700]]) {
    assert.equal((await api("/v1/assessment", token, { weekId: overview.body.weekId, formScore: score, coveragePpm: 900000, certaintyPpm: 900000 })).status, 200);
    assert.equal((await api("/v1/queue", token, { mode: "scalar" })).status, 200);
  }
  const before = await api("/v1/me", savedToken);
  assert.equal(before.body.player.receipt.elo.scalar.rated_matches, 1);
  assert.equal(before.body.player.receipt.elo.binary.rated_matches, 0);
  const replacementToken = randomBytes(32).toString("hex");
  const rotation = await api("/v1/session/rotate", savedToken, { replacementToken });
  assert.equal(rotation.status, 200);
  assert.equal(rotation.body.token, replacementToken);
  assert.equal((await api("/v1/me", savedToken)).status, 401);
  await docker(["restart", "--time", "5", container]);
  // Docker may choose a different ephemeral host port after restart.
  url = `http://${await docker(["port", container, "8787/tcp"])}`;
  await healthy(url);
  const after = await api("/v1/me", replacementToken);
  assert.deepEqual(after.body, before.body);
  assert.equal((await api("/v1/me", savedToken)).status, 401);
  checks.push({ name: "real bundled API supports client-known keys, assessment, rated match, rotation and durable restart", passed: true,
    persistedRatedMatches: after.body.player.receipt.elo.scalar.rated_matches });

  for (const link of ["symlink", "hardlink", "wal-symlink"]) {
    const invalidVolume = await volume(link);
    await helper(invalidVolume, `
      const fs=require('node:fs');fs.writeFileSync('/data/target','unchanged');fs.chmodSync('/data/target',0o644);
      ${link === "symlink" ? "fs.symlinkSync('/data/target','/data/elo.sqlite');" : link === "hardlink" ? "fs.linkSync('/data/target','/data/elo.sqlite');" : "fs.writeFileSync('/data/elo.sqlite','');fs.symlinkSync('/data/target','/data/elo.sqlite-wal');"}
    `);
    const invalidContainer = await launch(invalidVolume, link);
    const exit = Number(await docker(["wait", invalidContainer]));
    assert.notEqual(exit, 0);
    const logsResult = await execute("docker", ["logs", invalidContainer]);
    const logs = `${logsResult.stdout}${logsResult.stderr}`;
    assert.match(logs, /Invalid database file/);
    assert(!logs.includes("API process runs"));
    const target = JSON.parse(await helper(invalidVolume, `const fs=require('node:fs');const s=fs.statSync('/data/target');console.log(JSON.stringify({uid:s.uid,mode:s.mode&0o777,text:fs.readFileSync('/data/target','utf8')}));`));
    assert.deepEqual(target, { uid: 0, mode: 0o644, text: "unchanged" });
    checks.push({ name: `${link} database admission fails closed without touching link target`, passed: true, exitCode: exit });
  }
  const report = { checkedAt: new Date().toISOString(), image: imageInfo.Id, imageCreated: imageInfo.Created, checks };
  await writeFile(join(output, "container-runtime-check.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ image: imageInfo.Id, passed: checks.length, report: join(output, "container-runtime-check.json") }));
} finally {
  for (const container of containers) await docker(["rm", "--force", container]).catch(() => {});
  for (const vol of volumes) await docker(["volume", "rm", vol]).catch(() => {});
}

if (process.argv.includes("--scan") || process.argv.includes("--scan-only")) {
  const scratch = await mkdtemp(join(tmpdir(), "elo-trivy-"));
  try {
    const cache = join(tmpdir(), "computer-elo-trivy-cache");
    await mkdir(cache, { recursive: true });
    const scanner = process.env.TRIVY_IMAGE ?? "aquasec/trivy:latest";
    const scannerInfo = JSON.parse(await docker(["image", "inspect", scanner]))[0];
    await docker(["image", "save", "--output", join(scratch, "image.tar"), imageInfo.Id]);
    const isolation = ["run", "--rm", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--tmpfs", "/tmp:rw,nosuid,noexec,size=512m", "--mount", `type=bind,source=${scratch},target=/scan,readonly`,
      "--mount", `type=bind,source=${cache},target=/cache`, "--mount", `type=bind,source=${output},target=/out`, scannerInfo.Id];
    await docker([...isolation, "image", "--input", "/scan/image.tar", "--cache-dir", "/cache", "--scanners", "vuln", "--format", "json",
      ...(process.env.TRIVY_DB_REPOSITORY ? ["--db-repository", process.env.TRIVY_DB_REPOSITORY] : []),
      ...(process.env.TRIVY_SKIP_DB_UPDATE === "1" ? ["--skip-db-update"] : []),
      "--output", "/out/trivy-container.json", "--timeout", "10m"]);
    const version = JSON.parse(await docker([...isolation, "version", "--cache-dir", "/cache", "--format", "json"]));
    const report = JSON.parse(await readFile(join(output, "trivy-container.json"), "utf8"));
    assert.equal(report.Metadata.ImageID, imageInfo.Id);
    const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
    const findings = [];
    for (const result of report.Results ?? []) for (const entry of result.Vulnerabilities ?? []) {
      counts[entry.Severity] = (counts[entry.Severity] ?? 0) + 1;
      if (["CRITICAL", "HIGH"].includes(entry.Severity)) findings.push({ target: result.Target, id: entry.VulnerabilityID,
        package: entry.PkgName, installedVersion: entry.InstalledVersion, fixedVersion: entry.FixedVersion ?? null, severity: entry.Severity });
    }
    const summary = { scannedAt: new Date().toISOString(), image: imageInfo.Id, scannerImage: scannerInfo.Id,
      platform: `${imageInfo.Os}/${imageInfo.Architecture}`,
      scannerRepoDigests: scannerInfo.RepoDigests, scanner: version, counts, highAndCritical: findings,
      detectedOs: report.Metadata.OS,
      targets: (report.Results ?? []).map(result => ({ target: result.Target, class: result.Class, type: result.Type })),
      vulnerabilityDatabaseAgeMinutes: Math.round((Date.now() - Date.parse(version.VulnerabilityDB.UpdatedAt)) / 60000),
      limitation: "Runtime image scan covers detectable OS/global npm packages. Bundled application dependencies need the separate package-lock audit." };
    await writeFile(join(output, "trivy-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify({ image: imageInfo.Id, counts, vulnerabilityDatabaseAgeMinutes: summary.vulnerabilityDatabaseAgeMinutes,
      report: join(output, "trivy-container.json"), summary: join(output, "trivy-summary.json") }));
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
