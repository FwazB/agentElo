import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(join(tmpdir(), "computer-elo-kit-"));
const kit = join(stage, "computer-elo-kit");
const output = join(root, "apps/public/public/computer-elo-kit.zip");
const copy = (relative) => {
  mkdirSync(dirname(join(kit, relative)), { recursive: true });
  cpSync(join(root, relative), join(kit, relative));
};
try {
  for (const dir of ["packages/elo-engine/src", "protocol", "skills/computer-elo/references"]) {
    for (const file of readdirSync(join(root, dir)).sort()) if (/\.(ts|md|json)$/.test(file)) copy(`${dir}/${file}`);
  }
  for (const file of ["skills/computer-elo/SKILL.md", "skills/computer-elo/scripts/computer_elo.ts", "scripts/create-public-receipt.ts"]) copy(file);
  for (const file of ["package.json", "package-lock.json"]) {
    cpSync(join(root, "scripts/public-kit", file), join(kit, file));
  }
  writeFileSync(join(kit, "README.md"), readFileSync(join(root, "docs/public-kit.md")));
  mkdirSync(dirname(output), { recursive: true });
  rmSync(output, { force: true });
  // Stable source ordering and timestamps make local/CI/hosted builds identical.
  const files = [];
  function collect(directory) {
    for (const entry of readdirSync(join(stage, directory), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) collect(relative);
      else { utimesSync(join(stage, relative), 946684800, 946684800); files.push(relative); }
    }
  }
  collect("computer-elo-kit");
  execFileSync("zip", ["-qX", output, "-@"], { cwd: stage, input: files.join("\n") + "\n", env: { ...process.env, TZ: "UTC" } });
  console.log(output);
} finally { rmSync(stage, { recursive: true, force: true }); }
