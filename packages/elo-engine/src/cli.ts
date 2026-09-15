import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { loadJson, writePrettyJson } from "./canonical.ts";
import {
  CardRenderError,
  matchCardSvg,
  playerCardSvg,
  requirePngRenderer,
  writeCard,
} from "./cards.ts";
import { type EloMode, ENGINE_VERSION, FORMULA_BY_MODE, LOW_CONFIDENCE_THRESHOLD_PPM } from "./constants.ts";
import { calculateElo, MathInputError } from "./mathcore.ts";
import {
  buildLeaderboardReceipt,
  buildMatchReceipt,
  buildPlayerReceipt,
  ReceiptValidationError,
  validatePlayerReceipt,
  validateReceipt,
  type PlayerReceipt,
  type Receipt,
} from "./receipts.ts";

interface ParsedArguments {
  readonly positionals: string[];
  readonly options: Map<string, string | true>;
}

function parseArguments(args: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const options = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index] ?? "";
    if (!item.startsWith("--")) {
      positionals.push(item);
      continue;
    }
    if (item === "--incompatible") {
      options.set(item, true);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new ReceiptValidationError(`${item} requires a value`);
    if (options.has(item)) throw new ReceiptValidationError(`${item} may only be provided once`);
    options.set(item, value);
    index += 1;
  }
  return { positionals, options };
}

function option(parsed: ParsedArguments, name: string, required = false): string | undefined {
  const value = parsed.options.get(name);
  if (value === true) throw new ReceiptValidationError(`${name} requires a value`);
  if (required && value === undefined) throw new ReceiptValidationError(`${name} is required`);
  return value;
}

function integerOption(parsed: ParsedArguments, name: string, required = false, fallback?: number): number {
  const value = option(parsed, name, required);
  if (value === undefined && fallback !== undefined) return fallback;
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new ReceiptValidationError(`${name} must be an integer`);
  return result;
}

function modeOption(parsed: ParsedArguments): EloMode {
  const value = option(parsed, "--mode", true);
  if (value !== "binary" && value !== "scalar") throw new ReceiptValidationError("--mode must be binary or scalar");
  return value;
}

function opaqueId(prefix: string): string {
  return `${prefix}${randomBytes(16).toString("hex")}`;
}

function prepareOutputDirectory(value: string): string {
  const path = resolve(value);
  if (existsSync(path)) {
    if (!statSync(path).isDirectory()) throw new ReceiptValidationError(`output path is not a directory: ${path}`);
    if (readdirSync(path).length > 0) throw new ReceiptValidationError(`output directory must be new or empty: ${path}`);
  } else {
    mkdirSync(path, { recursive: true });
  }
  return path;
}

function manifest(paths: readonly string[]): Record<string, string> {
  return Object.fromEntries(paths.filter(existsSync).map((path) => [
    basename(path).replaceAll("-", "_").replaceAll(".", "_"),
    resolve(path),
  ]));
}

function loadReceipt(path: string): Receipt {
  return validateReceipt(loadJson(resolve(path)));
}

function commandForm(parsed: ParsedArguments): Record<string, string> {
  const priorPath = option(parsed, "--prior-receipt");
  const prior = priorPath === undefined ? null : validatePlayerReceipt(loadReceipt(priorPath));
  const playerId = option(parsed, "--player-id") ?? prior?.player_id ?? opaqueId("p_");
  const competitionId = option(parsed, "--competition-id") ?? prior?.competition_id ?? opaqueId("c_");
  const receipt = buildPlayerReceipt({
    player_id: playerId,
    competition_id: competitionId,
    week_id: option(parsed, "--week", true) ?? "",
    form_score: integerOption(parsed, "--form-score", true),
    coverage_ppm: integerOption(parsed, "--coverage-ppm", true),
    certainty_ppm: integerOption(parsed, "--certainty-ppm", true),
    prior_receipt: prior,
  });
  requirePngRenderer();
  const out = prepareOutputDirectory(option(parsed, "--out-dir", true) ?? "");
  const receiptPath = resolve(out, "player.receipt.json");
  const svgPath = resolve(out, "player-card.svg");
  const pngPath = resolve(out, "player-card.png");
  writePrettyJson(receiptPath, receipt);
  writeCard(svgPath, pngPath, playerCardSvg(receipt));
  return manifest([receiptPath, svgPath, pngPath]);
}

function commandDuel(parsed: ParsedArguments): Record<string, string> {
  if (parsed.positionals.length !== 2) throw new ReceiptValidationError("duel requires two player receipt paths");
  const receiptA = validatePlayerReceipt(loadReceipt(parsed.positionals[0] ?? ""));
  const receiptB = validatePlayerReceipt(loadReceipt(parsed.positionals[1] ?? ""));
  const [match, updatedA, updatedB] = buildMatchReceipt({
    receipt_a: receiptA,
    receipt_b: receiptB,
    mode: modeOption(parsed),
    match_id: option(parsed, "--match-id") ?? opaqueId("m_"),
  });
  requirePngRenderer();
  const out = prepareOutputDirectory(option(parsed, "--out-dir", true) ?? "");
  const matchPath = resolve(out, "match.receipt.json");
  const svgPath = resolve(out, "match-card.svg");
  const pngPath = resolve(out, "match-card.png");
  writePrettyJson(matchPath, match);
  writeCard(svgPath, pngPath, matchCardSvg(match));
  const paths = [matchPath, svgPath, pngPath];
  if (updatedA !== null && updatedB !== null) {
    const aPath = resolve(out, "player-a.updated.receipt.json");
    const bPath = resolve(out, "player-b.updated.receipt.json");
    writePrettyJson(aPath, updatedA);
    writePrettyJson(bPath, updatedB);
    paths.push(aPath, bPath);
  }
  return manifest(paths);
}

function commandValidate(parsed: ParsedArguments): Record<string, string | boolean> {
  if (parsed.positionals.length !== 1) throw new ReceiptValidationError("validate requires one receipt path");
  const receipt = loadReceipt(parsed.positionals[0] ?? "");
  return {
    fingerprint: receipt.fingerprint,
    receipt_type: receipt.receipt_type,
    schema_version: receipt.schema_version,
    valid: true,
  };
}

function commandLeaderboard(parsed: ParsedArguments): Record<string, string> {
  if (parsed.positionals.length < 2) throw new ReceiptValidationError("leaderboard requires at least two player receipts");
  const mode = modeOption(parsed);
  const receipts = parsed.positionals.map((path) => validatePlayerReceipt(loadReceipt(path)));
  const leaderboard = buildLeaderboardReceipt(receipts, mode);
  const out = prepareOutputDirectory(option(parsed, "--out-dir", true) ?? "");
  const receiptPath = resolve(out, "leaderboard.receipt.json");
  const markdownPath = resolve(out, "leaderboard.md");
  writePrettyJson(receiptPath, leaderboard);
  const lines = [
    `# Computer Elo leaderboard - ${mode}`,
    "",
    `Competition \`${leaderboard.competition_id}\``,
    "",
    "| Rank | Player | Elo | Rated matches |",
    "| ---: | --- | ---: | ---: |",
    ...leaderboard.entries.map((entry) => {
      const rating = entry.rating_milli;
      const sign = rating < 0 ? "-" : "";
      const absolute = Math.abs(rating);
      return `| ${entry.rank} | \`${entry.player_id}\` | ${sign}${Math.floor(absolute / 1000)}.${String(absolute % 1000).padStart(3, "0")} | ${entry.rated_matches} |`;
    }),
    "",
    "Public aggregate receipt only; no raw activity or private evidence.",
  ];
  writeFileSync(markdownPath, `${lines.join("\n")}\n`, "utf8");
  return manifest([receiptPath, markdownPath]);
}

function commandSimulate(parsed: ParsedArguments): object {
  const mode = modeOption(parsed);
  const input = {
    mode,
    rating_milli_a: integerOption(parsed, "--rating-milli-a", true),
    rating_milli_b: integerOption(parsed, "--rating-milli-b", true),
    form_a: integerOption(parsed, "--form-a", true),
    form_b: integerOption(parsed, "--form-b", true),
    confidence_ppm_a: integerOption(parsed, "--confidence-ppm-a", true),
    confidence_ppm_b: integerOption(parsed, "--confidence-ppm-b", true),
    rated_matches_a: integerOption(parsed, "--rated-matches-a", false, 0),
    rated_matches_b: integerOption(parsed, "--rated-matches-b", false, 0),
  };
  const calculation = calculateElo(input);
  const reasons: string[] = [];
  if (Math.min(input.confidence_ppm_a, input.confidence_ppm_b) < LOW_CONFIDENCE_THRESHOLD_PPM) reasons.push("low_confidence");
  if (parsed.options.get("--incompatible") === true) reasons.push("incompatible");
  const rated = reasons.length === 0;
  const applied = rated ? calculation.candidate_delta_milli_a : 0;
  return {
    calculation,
    exhibition_reasons: reasons,
    formula_version: FORMULA_BY_MODE[mode],
    rating_effect: rated ? "rated" : "exhibition",
    ratings_after_milli: { a: input.rating_milli_a + applied, b: input.rating_milli_b - applied },
  };
}

function usage(): string {
  return `Computer Elo ${ENGINE_VERSION}\n\nCommands:\n  form        Create a public-safe Form/Elo receipt\n  duel        Run a binary or scalar duel\n  validate    Validate a public receipt\n  leaderboard Build a deterministic leaderboard\n  simulate    Calculate without receipts`;
}

export function run(argv: readonly string[]): object {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") return { help: usage() };
  if (command === "--version") return { version: ENGINE_VERSION };
  const parsed = parseArguments(rest);
  if (command === "form") return commandForm(parsed);
  if (command === "duel") return commandDuel(parsed);
  if (command === "validate") return commandValidate(parsed);
  if (command === "leaderboard") return commandLeaderboard(parsed);
  if (command === "simulate") return commandSimulate(parsed);
  throw new ReceiptValidationError(`unknown command: ${command}`);
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  try {
    const result = run(argv);
    if ("help" in result && typeof result.help === "string") console.log(result.help);
    else if ("version" in result && typeof result.version === "string") console.log(result.version);
    else console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    if (
      error instanceof CardRenderError ||
      error instanceof MathInputError ||
      error instanceof ReceiptValidationError ||
      error instanceof Error
    ) {
      console.error(`error: ${error.message}`);
      return 2;
    }
    console.error("error: unknown failure");
    return 2;
  }
}
