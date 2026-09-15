import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { transform } from "esbuild";
import ipaddr from "ipaddr.js";

import {
  ENGINE_VERSION,
  FORMULA_BY_MODE,
  type EloMode,
  LOW_CONFIDENCE_THRESHOLD_PPM,
  MAX_CONFIDENCE_PPM,
  MAX_FORM_SCORE,
  MAX_SAFE_INTEGER,
  MIN_CONFIDENCE_PPM,
  MIN_FORM_SCORE,
  PROTOCOL_VERSION,
} from "../../packages/elo-engine/src/constants.ts";
import { calculateElo, MathInputError, type EloCalculation } from "../../packages/elo-engine/src/mathcore.ts";

export const API_VERSION = "computer-elo.demo-api.v1";
export const MAX_REQUEST_BYTES = 16_384;
const MAX_CONCURRENT_REQUESTS = 24;
const REQUEST_ID_PATTERN = /^[0-9a-f]{32}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const PLAYER_AGGREGATE_FIELDS = new Set(["certainty_ppm", "coverage_ppm", "form"]);

const WEB_ROOT = dirname(fileURLToPath(import.meta.url));

export const STATIC_FILES = new Map<string, readonly [string, string]>([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.ts", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonRecord = { [key: string]: JsonValue };
type Side = "a" | "b";
type Preset = "rated" | "low_confidence" | "established";

interface StreamState {
  rated_matches: number;
  rating_milli: number;
}

interface PlayerState {
  certainty_ppm: number;
  coverage_ppm: number;
  form: number;
  streams: Record<EloMode, StreamState>;
}

interface SnapshotPlayer extends PlayerState {
  effective_confidence_ppm: number;
}

interface HistoryEntry {
  applied_delta_milli_a: number;
  exhibition_reasons: string[];
  form_a: number;
  form_b: number;
  k: number;
  mode: EloMode;
  rating_effect: "rated" | "exhibition";
  sequence: number;
}

export interface ArenaSnapshot {
  api_version: string;
  history: HistoryEntry[];
  players: Record<Side, SnapshotPlayer>;
  privacy: {
    persistent_state: false;
    private_evidence_accepted: false;
    raw_activity_accepted: false;
  };
  protocol_version: string;
  revision: number;
}

interface AggregatePlayer {
  certainty_ppm: number;
  coverage_ppm: number;
  form: number;
}

interface DuelRequest {
  compatible: boolean;
  expected_revision: number;
  mode: EloMode;
  players: Record<Side, AggregatePlayer>;
  request_id: string;
}

interface ResetRequest {
  expected_revision: number;
  preset: Preset;
  request_id: string;
}

interface DuelPlayerResult {
  applied_delta_milli: number;
  effective_confidence_ppm: number;
  rated_matches_after: number;
  rated_matches_before: number;
  rating_after_milli: number;
  rating_before_milli: number;
}

export interface DuelResult {
  api_version: string;
  calculation: EloCalculation;
  exhibition_reasons: string[];
  formula_version: string;
  mode: EloMode;
  players: Record<Side, DuelPlayerResult>;
  protocol_version: string;
  rating_effect: "rated" | "exhibition";
  state: ArenaSnapshot;
}

interface ResetResult {
  reset: true;
  state: ArenaSnapshot;
}

type OperationResult = DuelResult | ResetResult;

interface CachedRequest {
  payload: string;
  response: OperationResult;
}

type Network = ReturnType<typeof ipaddr.parseCIDR>;

export class DemoInputError extends Error {
  override readonly name: string = "DemoInputError";
}

export class DemoConflictError extends DemoInputError {
  override readonly name: string = "DemoConflictError";

  constructor(
    readonly code: string,
    message: string,
    readonly state: ArenaSnapshot,
  ) {
    super(message);
  }
}

class CanonicalJsonError extends DemoInputError {
  override readonly name: string = "CanonicalJsonError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactRecord(value: unknown, fields: ReadonlySet<string>, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new DemoInputError(`${name} must be an object`);
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) {
    throw new DemoInputError(`${name} has unsupported or missing fields`);
  }
  return value;
}

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number") {
    throw new DemoInputError(`${name} must be an integer`);
  }
  if (value < minimum || value > maximum) {
    throw new DemoInputError(`${name} is outside its allowed range`);
  }
  return value;
}

function requestId(value: unknown): string {
  if (typeof value !== "string" || !REQUEST_ID_PATTERN.test(value)) {
    throw new DemoInputError("request_id must be 32 lowercase hexadecimal characters");
  }
  return value;
}

function aggregatePlayer(value: unknown, name: string): AggregatePlayer {
  const player = exactRecord(value, PLAYER_AGGREGATE_FIELDS, name);
  return {
    form: integer(player.form, `${name}.form`, MIN_FORM_SCORE, MAX_FORM_SCORE),
    coverage_ppm: integer(
      player.coverage_ppm,
      `${name}.coverage_ppm`,
      MIN_CONFIDENCE_PPM,
      MAX_CONFIDENCE_PPM,
    ),
    certainty_ppm: integer(
      player.certainty_ppm,
      `${name}.certainty_ppm`,
      MIN_CONFIDENCE_PPM,
      MAX_CONFIDENCE_PPM,
    ),
  };
}

function parseDuelRequest(value: unknown): DuelRequest {
  const payload = exactRecord(
    value,
    new Set(["compatible", "expected_revision", "mode", "players", "request_id"]),
    "request",
  );
  if (payload.mode !== "binary" && payload.mode !== "scalar") {
    throw new DemoInputError("mode must be binary or scalar");
  }
  if (typeof payload.compatible !== "boolean") {
    throw new DemoInputError("compatible must be a boolean");
  }
  const players = exactRecord(payload.players, new Set(["a", "b"]), "players");
  return {
    compatible: payload.compatible,
    expected_revision: integer(payload.expected_revision, "expected_revision", 0, MAX_SAFE_INTEGER),
    mode: payload.mode,
    players: {
      a: aggregatePlayer(players.a, "players.a"),
      b: aggregatePlayer(players.b, "players.b"),
    },
    request_id: requestId(payload.request_id),
  };
}

function parseResetRequest(value: unknown): ResetRequest {
  const payload = exactRecord(
    value,
    new Set(["expected_revision", "preset", "request_id"]),
    "request",
  );
  if (
    payload.preset !== "rated" &&
    payload.preset !== "low_confidence" &&
    payload.preset !== "established"
  ) {
    throw new DemoInputError("preset must be rated, low_confidence, or established");
  }
  return {
    expected_revision: integer(payload.expected_revision, "expected_revision", 0, MAX_SAFE_INTEGER),
    preset: payload.preset,
    request_id: requestId(payload.request_id),
  };
}

function stream(rating_milli = 1_200_000, rated_matches = 0): StreamState {
  return { rated_matches, rating_milli };
}

function presetPlayers(preset: Preset): Record<Side, PlayerState> {
  const established = preset === "established";
  const ratingA = established ? 1_240_000 : 1_200_000;
  const ratingB = established ? 1_160_000 : 1_200_000;
  const matches = established ? 5 : 0;
  const coverageB = preset === "low_confidence" ? 490_000 : 750_000;
  return {
    a: {
      certainty_ppm: 800_000,
      coverage_ppm: 900_000,
      form: 700,
      streams: { binary: stream(ratingA, matches), scalar: stream(ratingA, matches) },
    },
    b: {
      certainty_ppm: 600_000,
      coverage_ppm: coverageB,
      form: 500,
      streams: { binary: stream(ratingB, matches), scalar: stream(ratingB, matches) },
    },
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new CanonicalJsonError("JSON integer is outside the safe range");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`)
      .join(",")}}`;
  }
  throw new CanonicalJsonError("unsupported JSON value");
}

class CanonicalJsonParser {
  private offset = 0;

  constructor(private readonly source: string) {}

  parse(): JsonValue {
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.offset !== this.source.length) throw new CanonicalJsonError("invalid trailing JSON data");
    return value;
  }

  private parseValue(): JsonValue {
    this.skipWhitespace();
    const character = this.source[this.offset];
    if (character === "{") return this.parseObject();
    if (character === "[") return this.parseArray();
    if (character === '"') return this.parseString();
    if (character === "t") return this.parseLiteral("true", true);
    if (character === "f") return this.parseLiteral("false", false);
    if (character === "n") return this.parseLiteral("null", null);
    if (character === "-" || (character !== undefined && /[0-9]/.test(character))) {
      return this.parseInteger();
    }
    throw new CanonicalJsonError("invalid JSON value");
  }

  private parseObject(): JsonRecord {
    this.offset += 1;
    const result: JsonRecord = {};
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.source[this.offset] === "}") {
      this.offset += 1;
      return result;
    }
    while (true) {
      this.skipWhitespace();
      if (this.source[this.offset] !== '"') throw new CanonicalJsonError("object key must be a string");
      const key = this.parseString();
      if (keys.has(key)) throw new CanonicalJsonError(`duplicate JSON key: ${key}`);
      keys.add(key);
      this.skipWhitespace();
      if (this.source[this.offset] !== ":") throw new CanonicalJsonError("object key must be followed by a colon");
      this.offset += 1;
      result[key] = this.parseValue();
      this.skipWhitespace();
      const delimiter = this.source[this.offset];
      if (delimiter === "}") {
        this.offset += 1;
        return result;
      }
      if (delimiter !== ",") throw new CanonicalJsonError("object members must be comma separated");
      this.offset += 1;
    }
  }

  private parseArray(): JsonValue[] {
    this.offset += 1;
    const result: JsonValue[] = [];
    this.skipWhitespace();
    if (this.source[this.offset] === "]") {
      this.offset += 1;
      return result;
    }
    while (true) {
      result.push(this.parseValue());
      this.skipWhitespace();
      const delimiter = this.source[this.offset];
      if (delimiter === "]") {
        this.offset += 1;
        return result;
      }
      if (delimiter !== ",") throw new CanonicalJsonError("array values must be comma separated");
      this.offset += 1;
    }
  }

  private parseString(): string {
    const start = this.offset;
    this.offset += 1;
    let escaped = false;
    while (this.offset < this.source.length) {
      const character = this.source[this.offset];
      if (escaped) {
        escaped = false;
        this.offset += 1;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        this.offset += 1;
        continue;
      }
      if (character === '"') {
        this.offset += 1;
        let value: unknown;
        try {
          value = JSON.parse(this.source.slice(start, this.offset));
        } catch {
          throw new CanonicalJsonError("invalid JSON string");
        }
        if (typeof value !== "string") throw new CanonicalJsonError("invalid JSON string");
        for (const point of value) {
          const code = point.codePointAt(0);
          if (code === undefined || code > 127) throw new CanonicalJsonError("non-ASCII strings are forbidden");
          if (code < 32 || code === 127) throw new CanonicalJsonError("control characters are forbidden");
        }
        return value;
      }
      this.offset += 1;
    }
    throw new CanonicalJsonError("unterminated JSON string");
  }

  private parseInteger(): number {
    const remainder = this.source.slice(this.offset);
    const match = /^-?(?:0|[1-9][0-9]*)/.exec(remainder);
    if (match === null) throw new CanonicalJsonError("invalid JSON integer");
    const token = match[0];
    const next = remainder[token.length];
    if (next !== undefined && !/[\s,}\]]/.test(next)) {
      throw new CanonicalJsonError("floating JSON numbers are forbidden");
    }
    if (token === "-0") throw new CanonicalJsonError("negative-zero JSON integers are forbidden");
    const value = Number(token);
    if (!Number.isSafeInteger(value)) throw new CanonicalJsonError("JSON integer is outside the safe range");
    this.offset += token.length;
    return value;
  }

  private parseLiteral<T extends JsonPrimitive>(source: string, value: T): T {
    if (!this.source.startsWith(source, this.offset)) throw new CanonicalJsonError("invalid JSON literal");
    this.offset += source.length;
    return value;
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.source[this.offset] ?? "")) this.offset += 1;
  }
}

export function parseCanonicalJson(source: string): JsonValue {
  return new CanonicalJsonParser(source).parse();
}

export class ArenaState {
  private revision = 0;
  private players = presetPlayers("rated");
  private history: HistoryEntry[] = [];
  private readonly requestCache = new Map<string, CachedRequest>();

  snapshot(): ArenaSnapshot {
    const players = clone(this.players) as Record<Side, SnapshotPlayer>;
    for (const side of ["a", "b"] as const) {
      players[side].effective_confidence_ppm = Math.min(
        players[side].coverage_ppm,
        players[side].certainty_ppm,
      );
    }
    return {
      api_version: API_VERSION,
      history: clone(this.history),
      players,
      privacy: {
        persistent_state: false,
        private_evidence_accepted: false,
        raw_activity_accepted: false,
      },
      protocol_version: PROTOCOL_VERSION,
      revision: this.revision,
    };
  }

  duel(value: unknown): DuelResult {
    const payload = parseDuelRequest(value);
    const cached = this.cached("duel", payload.request_id, payload);
    if (cached !== undefined) return cached as DuelResult;
    if (payload.expected_revision !== this.revision) {
      throw new DemoConflictError(
        "stale_state",
        "The arena changed in another browser; current state was returned",
        this.snapshot(),
      );
    }
    for (const side of ["a", "b"] as const) Object.assign(this.players[side], payload.players[side]);
    const playerA = this.players.a;
    const playerB = this.players.b;
    const streamA = playerA.streams[payload.mode];
    const streamB = playerB.streams[payload.mode];
    const effectiveA = Math.min(playerA.coverage_ppm, playerA.certainty_ppm);
    const effectiveB = Math.min(playerB.coverage_ppm, playerB.certainty_ppm);
    const calculation = calculateElo({
      mode: payload.mode,
      rating_milli_a: streamA.rating_milli,
      rating_milli_b: streamB.rating_milli,
      form_a: playerA.form,
      form_b: playerB.form,
      confidence_ppm_a: effectiveA,
      confidence_ppm_b: effectiveB,
      rated_matches_a: streamA.rated_matches,
      rated_matches_b: streamB.rated_matches,
    });
    const reasons: string[] = [];
    if (!payload.compatible) reasons.push("incompatible_context");
    if (Math.min(effectiveA, effectiveB) < LOW_CONFIDENCE_THRESHOLD_PPM) reasons.push("low_confidence");
    reasons.sort();
    const rated = reasons.length === 0;
    const deltaA = rated ? calculation.candidate_delta_milli_a : 0;
    const deltaB = -deltaA;
    const beforeA = clone(streamA);
    const beforeB = clone(streamB);
    if (rated) {
      streamA.rating_milli += deltaA;
      streamB.rating_milli += deltaB;
      streamA.rated_matches += 1;
      streamB.rated_matches += 1;
    }
    this.revision += 1;
    this.history.unshift({
      applied_delta_milli_a: deltaA,
      exhibition_reasons: reasons,
      form_a: playerA.form,
      form_b: playerB.form,
      k: calculation.k,
      mode: payload.mode,
      rating_effect: rated ? "rated" : "exhibition",
      sequence: this.revision,
    });
    this.history = this.history.slice(0, 12);
    const result: DuelResult = {
      api_version: API_VERSION,
      calculation,
      exhibition_reasons: reasons,
      formula_version: FORMULA_BY_MODE[payload.mode],
      mode: payload.mode,
      players: {
        a: {
          applied_delta_milli: deltaA,
          effective_confidence_ppm: effectiveA,
          rated_matches_after: streamA.rated_matches,
          rated_matches_before: beforeA.rated_matches,
          rating_after_milli: streamA.rating_milli,
          rating_before_milli: beforeA.rating_milli,
        },
        b: {
          applied_delta_milli: deltaB,
          effective_confidence_ppm: effectiveB,
          rated_matches_after: streamB.rated_matches,
          rated_matches_before: beforeB.rated_matches,
          rating_after_milli: streamB.rating_milli,
          rating_before_milli: beforeB.rating_milli,
        },
      },
      protocol_version: PROTOCOL_VERSION,
      rating_effect: rated ? "rated" : "exhibition",
      state: this.snapshot(),
    };
    this.remember("duel", payload.request_id, payload, result);
    return clone(result);
  }

  reset(value: unknown): ResetResult {
    const payload = parseResetRequest(value);
    const cached = this.cached("reset", payload.request_id, payload);
    if (cached !== undefined) return cached as ResetResult;
    if (payload.expected_revision !== this.revision) {
      throw new DemoConflictError(
        "stale_state",
        "The arena changed in another browser; current state was returned",
        this.snapshot(),
      );
    }
    this.players = presetPlayers(payload.preset);
    this.history = [];
    this.revision += 1;
    const result: ResetResult = { reset: true, state: this.snapshot() };
    this.remember("reset", payload.request_id, payload, result);
    return clone(result);
  }

  private cached(operation: string, requestIdValue: string, payload: unknown): OperationResult | undefined {
    const key = `${operation}:${requestIdValue}`;
    const cached = this.requestCache.get(key);
    if (cached === undefined) return undefined;
    if (cached.payload !== canonicalStringify(payload)) {
      throw new DemoConflictError(
        "request_id_reused",
        "request_id was already used for different input",
        this.snapshot(),
      );
    }
    this.requestCache.delete(key);
    this.requestCache.set(key, cached);
    return clone(cached.response);
  }

  private remember(operation: string, requestIdValue: string, payload: unknown, response: OperationResult): void {
    const key = `${operation}:${requestIdValue}`;
    this.requestCache.set(key, { payload: canonicalStringify(payload), response: clone(response) });
    while (this.requestCache.size > 128) {
      const oldest = this.requestCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.requestCache.delete(oldest);
    }
  }
}

export interface DemoServerOptions {
  readonly host: string;
  readonly port: number;
  readonly allowedCidrs: readonly string[];
  readonly token: string;
}

interface DemoContext {
  readonly arena: ArenaState;
  readonly token: string;
  readonly allowedNetworks: readonly Network[];
  readonly rateEvents: Map<string, number[]>;
  readonly allowedHosts: Set<string>;
  activeRequests: number;
}

function normalizeAddress(address: string): ipaddr.IPv4 | ipaddr.IPv6 {
  return ipaddr.process(address);
}

function addressAllowed(address: string, networks: readonly Network[]): boolean {
  try {
    const parsed = normalizeAddress(address);
    return networks.some(([network, prefix]) => parsed.kind() === network.kind() && parsed.match(network, prefix));
  } catch {
    return false;
  }
}

export function allowedNetworks(values: readonly string[]): Network[] {
  return values.map((value) => {
    let network: Network;
    try {
      network = ipaddr.parseCIDR(value);
    } catch {
      throw new DemoInputError(`invalid allowed CIDR: ${value}`);
    }
    const [address, prefix] = network;
    const allowedRanges = new Set(["private", "loopback", "linkLocal", "uniqueLocal"]);
    if (prefix === 0 || !allowedRanges.has(address.range())) {
      throw new DemoInputError(`allowed CIDR must be private, loopback, or link-local: ${value}`);
    }
    return network;
  });
}

function headerValues(request: IncomingMessage, name: string): readonly string[] {
  return request.headersDistinct[name.toLowerCase()] ?? [];
}

function remoteAddress(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? "";
}

function safeTokenEqual(supplied: string, expected: string): boolean {
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
}

function rateAllowed(context: DemoContext, address: string): boolean {
  const now = Date.now();
  const recent = (context.rateEvents.get(address) ?? []).filter((timestamp) => now - timestamp <= 60_000);
  if (recent.length >= 120) return false;
  recent.push(now);
  context.rateEvents.set(address, recent);
  return true;
}

function setBaseHeaders(response: ServerResponse, contentType: string, contentLength: number): void {
  response.setHeader("Content-Type", contentType);
  response.setHeader("Content-Length", String(contentLength));
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Connection", "close");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function sendBytes(
  response: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  includeBody = true,
): void {
  response.statusCode = status;
  setBaseHeaders(response, contentType, body.byteLength);
  response.end(includeBody ? body : undefined);
}

function sendJson(response: ServerResponse, status: number, value: unknown, includeBody = true): void {
  sendBytes(
    response,
    status,
    Buffer.from(JSON.stringify(value), "utf8"),
    "application/json; charset=utf-8",
    includeBody,
  );
}

function sendError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
  state?: ArenaSnapshot,
): void {
  sendJson(response, status, state === undefined ? { error: { code, message } } : { error: { code, message }, state });
}

function authorize(
  request: IncomingMessage,
  response: ServerResponse,
  context: DemoContext,
  requireToken: boolean,
): boolean {
  const client = remoteAddress(request);
  if (!addressAllowed(client, context.allowedNetworks)) {
    sendError(response, 403, "network_denied", "Network denied");
    return false;
  }
  const hosts = headerValues(request, "host");
  if (hosts.length !== 1 || !context.allowedHosts.has(hosts[0] ?? "")) {
    sendError(response, 403, "host_denied", "Host denied");
    return false;
  }
  if (requireToken) {
    const tokens = headerValues(request, "x-computer-elo-token");
    const supplied = tokens.length === 1 ? tokens[0] ?? "" : "";
    if (!safeTokenEqual(supplied, context.token)) {
      sendError(response, 401, "token_required", "Valid demo token required");
      return false;
    }
    if (!rateAllowed(context, client)) {
      sendError(response, 429, "rate_limited", "Too many requests");
      return false;
    }
  }
  return true;
}

function originAllowed(request: IncomingMessage): boolean {
  const hosts = headerValues(request, "host");
  const origins = headerValues(request, "origin");
  return hosts.length === 1 && origins.length === 1 && origins[0] === `http://${hosts[0]}`;
}

async function staticBody(filename: string): Promise<Buffer> {
  const path = join(WEB_ROOT, filename);
  if (filename !== "app.ts") return readFile(path);
  const source = await readFile(path, "utf8");
  const output = await transform(source, {
    format: "esm",
    loader: "ts",
    sourcefile: path,
    target: "es2022",
  });
  return Buffer.from(output.code, "utf8");
}

async function serveGet(
  request: IncomingMessage,
  response: ServerResponse,
  context: DemoContext,
  includeBody: boolean,
): Promise<void> {
  const path = new URL(request.url ?? "/", "http://local").pathname;
  const api = path.startsWith("/api/");
  if (!authorize(request, response, context, api && path !== "/api/health")) return;
  if (path === "/api/health") {
    sendJson(
      response,
      200,
      {
        api_version: API_VERSION,
        engine_version: ENGINE_VERSION,
        persistence: false,
        protocol_version: PROTOCOL_VERSION,
        runtime: "typescript",
        status: "ok",
      },
      includeBody,
    );
    return;
  }
  if (path === "/api/state") {
    sendJson(response, 200, context.arena.snapshot(), includeBody);
    return;
  }
  if (path === "/favicon.ico") {
    sendBytes(response, 204, Buffer.alloc(0), "image/x-icon", includeBody);
    return;
  }
  const staticEntry = STATIC_FILES.get(path);
  if (staticEntry === undefined) {
    sendError(response, 404, "not_found", "Not found");
    return;
  }
  const [filename, contentType] = staticEntry;
  sendBytes(response, 200, await staticBody(filename), contentType, includeBody);
}

async function readJsonBody(request: IncomingMessage): Promise<JsonValue> {
  if (headerValues(request, "transfer-encoding").length > 0) {
    throw new DemoInputError("Chunked requests are not supported");
  }
  const contentTypes = headerValues(request, "content-type");
  if (contentTypes.length !== 1) throw new DemoInputError("Exactly one Content-Type is required");
  if ((contentTypes[0] ?? "").split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new DemoInputError("Content-Type must be application/json");
  }
  const lengths = headerValues(request, "content-length");
  if (lengths.length !== 1) throw new DemoInputError("Exactly one Content-Length is required");
  const length = Number(lengths[0]);
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_REQUEST_BYTES) {
    throw new DemoInputError("Request body is too large");
  }
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    received += buffer.byteLength;
    if (received > MAX_REQUEST_BYTES) throw new DemoInputError("Request body is too large");
    chunks.push(buffer);
  }
  if (received !== length) throw new DemoInputError("Content-Length does not match request body");
  return parseCanonicalJson(Buffer.concat(chunks).toString("utf8"));
}

async function servePost(
  request: IncomingMessage,
  response: ServerResponse,
  context: DemoContext,
): Promise<void> {
  if (!authorize(request, response, context, true)) return;
  const path = new URL(request.url ?? "/", "http://local").pathname;
  if (path !== "/api/duel" && path !== "/api/reset") {
    sendError(response, 404, "not_found", "Not found");
    return;
  }
  if (!originAllowed(request)) {
    sendError(response, 403, "origin_denied", "Origin denied");
    return;
  }
  try {
    const payload = await readJsonBody(request);
    const result = path === "/api/duel" ? context.arena.duel(payload) : context.arena.reset(payload);
    sendJson(response, 200, result);
  } catch (error) {
    if (error instanceof DemoConflictError) {
      sendError(response, 409, error.code, error.message, error.state);
      return;
    }
    if (error instanceof CanonicalJsonError) {
      sendError(response, 400, "invalid_request", "Request JSON is not in the accepted canonical subset");
      return;
    }
    if (error instanceof DemoInputError || error instanceof MathInputError) {
      sendError(response, 400, "invalid_request", error.message);
      return;
    }
    throw error;
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: DemoContext,
): Promise<void> {
  if (context.activeRequests >= MAX_CONCURRENT_REQUESTS) {
    sendError(response, 503, "busy", "Too many concurrent requests");
    return;
  }
  context.activeRequests += 1;
  try {
    if (request.method === "GET") {
      await serveGet(request, response, context, true);
    } else if (request.method === "HEAD") {
      await serveGet(request, response, context, false);
    } else if (request.method === "POST") {
      await servePost(request, response, context);
    } else if (authorize(request, response, context, false)) {
      sendError(response, 405, "method_not_allowed", "Method not allowed");
    }
  } catch {
    if (!response.headersSent) sendError(response, 500, "internal_error", "Internal server error");
    else response.destroy();
  } finally {
    context.activeRequests -= 1;
  }
}

export function createDemoServer(options: DemoServerOptions): Server {
  const networks = allowedNetworks(options.allowedCidrs);
  const hostAddress = normalizeAddress(options.host);
  if (!networks.some(([network, prefix]) => hostAddress.kind() === network.kind() && hostAddress.match(network, prefix))) {
    throw new DemoInputError("the bound host must belong to an allowed CIDR");
  }
  const allowedHosts = new Set([options.host, `${options.host}:${options.port}`]);
  if (hostAddress.range() === "loopback") {
    allowedHosts.add("127.0.0.1");
    allowedHosts.add(`127.0.0.1:${options.port}`);
    allowedHosts.add("localhost");
    allowedHosts.add(`localhost:${options.port}`);
  }
  const context: DemoContext = {
    activeRequests: 0,
    allowedHosts,
    allowedNetworks: networks,
    arena: new ArenaState(),
    rateEvents: new Map(),
    token: options.token,
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response, context);
  });
  server.requestTimeout = 8_000;
  server.headersTimeout = 8_000;
  return server;
}

interface CliOptions {
  host: string;
  port: number;
  allowedCidrs: string[];
  token: string;
}

function parseCliOptions(argv: readonly string[]): CliOptions {
  let host = "127.0.0.1";
  let port = 8765;
  let token = "";
  const allowedCidrs: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (option === "--host" || option === "--port" || option === "--allow-cidr" || option === "--token") {
      if (value === undefined) throw new DemoInputError(`${option} requires a value`);
      index += 1;
      if (option === "--host") host = value;
      else if (option === "--port") port = Number(value);
      else if (option === "--allow-cidr") allowedCidrs.push(value);
      else token = value;
    } else {
      throw new DemoInputError(`unknown option: ${option}`);
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new DemoInputError("port must be between 1 and 65535");
  }
  if (isIP(host) === 0) throw new DemoInputError("--host must be a specific numeric IP address");
  const hostAddress = normalizeAddress(host);
  if (hostAddress.toString() === "0.0.0.0" || hostAddress.toString() === "::") {
    throw new DemoInputError("wildcard hosts are not allowed; use this computer's LAN IP");
  }
  if (hostAddress.range() !== "loopback" && allowedCidrs.length === 0) {
    throw new DemoInputError("--allow-cidr is required when serving beyond loopback");
  }
  for (const cidr of ["127.0.0.0/8", "::1/128"]) {
    if (!allowedCidrs.includes(cidr)) allowedCidrs.push(cidr);
  }
  const generatedToken = token || randomBytes(32).toString("base64url");
  if (!TOKEN_PATTERN.test(generatedToken)) {
    throw new DemoInputError("token must be 32-128 URL-safe characters");
  }
  return { host, port, allowedCidrs, token: generatedToken };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const options = parseCliOptions(argv);
    const server = createDemoServer(options);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.host, resolve);
    });
    console.log(`Room URL: http://${options.host}:${options.port}/#${options.token}`);
    console.log("TypeScript in-memory demo only. Press Ctrl-C to stop and erase the room.");
    const close = (): void => {
      server.close(() => process.exit(0));
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown startup failure";
    console.error(`error: could not start server: ${message}`);
    return 2;
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  process.exitCode = await main();
}
