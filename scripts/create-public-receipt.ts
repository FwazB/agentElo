import { randomBytes } from "node:crypto";
import { buildPlayerReceipt } from "../packages/elo-engine/src/receipts.ts";
import { canonicalJson } from "../packages/elo-engine/src/canonical.ts";

const allowed = new Set(["player-id", "competition-id", "week", "form-score", "coverage-ppm", "certainty-ppm"]);
const args = process.argv.slice(2);
try {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, "");
    const value = args[i + 1];
    if (!key || !args[i]?.startsWith("--") || !allowed.has(key) || values.has(key) || value === undefined) throw new Error("Invalid arguments.");
    values.set(key, value);
  }
  for (const key of ["week", "form-score", "coverage-ppm", "certainty-ppm"]) if (!values.has(key)) throw new Error(`Missing --${key}.`);
  const receipt = buildPlayerReceipt({
    player_id: values.get("player-id") ?? `p_${randomBytes(16).toString("hex")}`,
    competition_id: values.get("competition-id") ?? `c_${randomBytes(16).toString("hex")}`,
    week_id: values.get("week")!,
    form_score: Number(values.get("form-score")),
    coverage_ppm: Number(values.get("coverage-ppm")),
    certainty_ppm: Number(values.get("certainty-ppm")),
  });
  process.stdout.write(canonicalJson(receipt) + "\n");
} catch {
  process.stderr.write("Use: npm run --silent receipt -- --week YYYY-WNN --form-score 1..1000 --coverage-ppm 0..1000000 --certainty-ppm 0..1000000 [--player-id p_32hex] [--competition-id c_32hex]\n");
  process.exitCode = 1;
}
