import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { parseWorkEntry } from "./entries.ts";
import { evaluateCalibration } from "./evaluation.ts";
import { adjudicatePair, buildJudgePacket, judgeFingerprint, parseJudgeConfig } from "./judge.ts";
import { parseRefereeJson } from "./json.ts";

const USAGE = `Offline AntiSlop referee tools (no network calls or Elo updates):
  referee config --config FILE
  referee packet --entry-a FILE --entry-b FILE --config FILE --order ab|ba
  referee adjudicate --entry-a FILE --entry-b FILE --config FILE --response-ab FILE --response-ba FILE
  referee evaluate --input FILE
Packets and adjudications contain PRIVATE evidence or explanations. Save them under ignored runs/referee/.`;

export function readInput(path: string, maxBytes: number): unknown {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { throw new Error("Cannot open input file."); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("Input must be a bounded regular JSON file.");
    const bytes = Buffer.alloc(maxBytes + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, null);
      if (read === 0) break;
      count += read;
    }
    if (count > maxBytes) throw new Error("Input file exceeds the size limit.");
    let source: string;
    try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count)); } catch { throw new Error("Input is not valid UTF-8."); }
    return parseRefereeJson(source);
  } finally { closeSync(fd); }
}

export function runCommand(args: string[]): unknown {
  const [command, ...rest] = args;
  const required: Record<string, readonly string[]> = {
    config: ["config"],
    packet: ["entry-a", "entry-b", "config", "order"],
    adjudicate: ["entry-a", "entry-b", "config", "response-ab", "response-ba"],
    evaluate: ["input"],
  };
  if (!command || !Object.hasOwn(required, command)) throw new Error(USAGE);
  const keys = required[command]!;
  const { values, tokens } = parseArgs({ args: rest, options: Object.fromEntries(keys.map(key => [key, { type: "string" as const }])), strict: true, allowPositionals: false, tokens: true });
  const names = tokens.filter(token => token.kind === "option").map(token => token.name);
  if (names.length !== keys.length || new Set(names).size !== names.length || keys.some(key => typeof values[key] !== "string" || values[key] === "")) throw new Error("Supply every required flag exactly once.");
  const get = (key: string): string => values[key] as string;
  if (command === "evaluate") return evaluateCalibration(readInput(get("input"), 8 * 1024 * 1024));
  const config = parseJudgeConfig(readInput(get("config"), 8192));
  if (command === "config") return { config, judgeFingerprint: judgeFingerprint(config), ratingEligible: false };
  const a = parseWorkEntry(readInput(get("entry-a"), 65536));
  const b = parseWorkEntry(readInput(get("entry-b"), 65536));
  if (command === "packet") {
    const order = get("order");
    if (order !== "ab" && order !== "ba") throw new Error("Order must be ab or ba.");
    return buildJudgePacket(a, b, config, order);
  }
  return adjudicatePair(a, b, config, readInput(get("response-ab"), 16384), readInput(get("response-ba"), 16384));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(`${JSON.stringify(runCommand(process.argv.slice(2)), null, 2)}\n`); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Referee command failed."}\n`);
    process.exitCode = 1;
  }
}
