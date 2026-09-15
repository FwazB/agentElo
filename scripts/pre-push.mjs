// Git supplies the exact local OIDs on stdin, including raw-SHA pushes not
// reachable from a named local ref. Include those objects in both scans.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const revisions = new Set();
const input = readFileSync(0, "utf8");
if (input.length > 1024 * 1024) throw new Error("Too many refs in one push");
for (const line of input.trim().split("\n").filter(Boolean)) {
  const fields = line.split(/\s+/);
  if (fields.length !== 4 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(fields[1])) throw new Error("Invalid Git pre-push input");
  if (!/^0+$/.test(fields[1])) revisions.add(fields[1]);
}
function run(command, args) {
  const result = spawnSync(command, args, { stdio: ["ignore", "inherit", "inherit"], timeout: 120000 });
  if (result.error || result.status !== 0) {
    console.error(command === "gitleaks" ? "Secret scan failed or Gitleaks is unavailable; see SECURITY.md." : "Repository safety check failed.");
    process.exit(result.status || 1);
  }
}
run(process.execPath, ["scripts/check-repository.mjs", "--history", ...[...revisions].map(oid => `--revision=${oid}`)]);
run("gitleaks", ["git", `--log-opts=--all ${[...revisions].join(" ")}`, "--redact", "--no-banner", "--timeout", "60"]);
