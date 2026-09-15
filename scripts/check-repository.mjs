// Check indexed bytes and, before pushing, every reachable historical tree.
// Looking only at current filenames misses private files deleted in later commits.
import { execFileSync } from "node:child_process";

const git = args => execFileSync("git", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
const failures = new Set(), sizes = new Map();
let checked = 0;
function inspect(path, mode, oid, context) {
  checked++;
  if (!["100644", "100755"].includes(mode)) { failures.add(`Unsupported entry mode in ${context}: ${path}`); return; }
  if (/[\x00-\x1f\x7f]/.test(path) || path.split("/").includes("..")) { failures.add(`Unsafe filename in ${context}`); return; }
  const name = path.split("/").at(-1);
  const forbidden = /(^|\/)(?:node_modules|\.next|\.git|\.vercel|\.railway|\.ssh|artifacts|runs|data|var|coverage)(\/|$)/.test(path)
    || name.startsWith(".env") && name !== ".env.example"
    || [".npmrc", ".git-credentials"].includes(name)
    || /(?:\.sqlite(?:.*)?|\.db(?:-.*)?|\.pem|\.key|\.p12|\.pfx|\.tsbuildinfo|\.log)$/i.test(name)
    || /^(?:id_rsa|id_ed25519|credentials)/.test(name)
    || path === "apps/public/public/computer-elo-kit.zip"
    || /^docs\/(?:security-review-|robust-testing-|git-preparation-)/.test(path)
    || ["docs/ai-reference-security.md", "docs/one-page-design.md", "docs/public-launch-plan.md", "scripts/check-public-live.mjs", "scripts/check-robust-live.mjs"].includes(path);
  if (forbidden) failures.add(`Private/generated path in ${context}: ${path}`);
  if (!sizes.has(oid)) sizes.set(oid, Number(git(["cat-file", "-s", oid])));
  const bytes = sizes.get(oid);
  if (!Number.isSafeInteger(bytes) || bytes > 2 * 1024 * 1024) failures.add(`Review required for oversized blob in ${context}: ${path}`);
  if (name === ".env.example") {
    if (bytes > 16384) failures.add(`Environment example is too large in ${context}: ${path}`);
    else for (const line of git(["cat-file", "blob", oid]).split(/\r?\n/)) {
      const assignment = /^[ \t]*(?:export[ \t]+)?(?:ELO_)?SERVICE_KEY[ \t]*=(.*)$/.exec(line);
      if (!assignment) continue;
      const value = assignment[1].trim();
      if (value !== "" && value !== "''" && value !== '\"\"' && !value.startsWith("#")) failures.add(`Credential placeholder must be empty in ${context}: ${path}`);
    }
  }
}
for (const entry of git(["ls-files", "--stage", "-z"]).split("\0").filter(Boolean)) {
  const tab = entry.indexOf("\t"), metadata = entry.slice(0, tab).split(" "), path = entry.slice(tab + 1);
  if (tab < 0 || metadata[2] !== "0") { failures.add("Unresolved index entry"); continue; }
  inspect(path, metadata[0], metadata[1], "index");
}
let trees = 0;
if (process.argv.includes("--history")) {
  const revisions = process.argv.filter(arg => arg.startsWith("--revision=")).map(arg => arg.slice(11));
  if (revisions.some(oid => !/^[a-f0-9]{40,64}$/.test(oid))) throw new Error("Invalid revision");
  for (const tree of new Set(git(["log", "--all", ...revisions, "--format=%T"]).trim().split("\n").filter(Boolean))) {
    if (!/^[a-f0-9]{40,64}$/.test(tree)) throw new Error("Invalid Git tree object");
    trees++;
    for (const entry of git(["ls-tree", "-r", "-z", tree]).split("\0").filter(Boolean)) {
      const tab = entry.indexOf("\t"), metadata = entry.slice(0, tab).split(" "), path = entry.slice(tab + 1);
      if (tab < 0 || metadata[1] !== "blob") { failures.add("Unsupported historical entry"); continue; }
      inspect(path, metadata[0], metadata[2], `history ${tree.slice(0, 12)}`);
    }
  }
}
if (failures.size) { console.error([...failures].join("\n")); process.exitCode = 1; }
else console.log(`Repository boundary passed: ${checked} entries across index and ${trees} historical trees.`);
