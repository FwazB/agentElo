import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError } from "../store.ts";
import type { AntislopStore } from "./store.ts";

const ENTRY_BODY_BYTES = 96 * 1024;
const SMALL_BODY_BYTES = 16 * 1024;
const PREFIX = "/v1/antislop";

/** Unicode JSON with duplicate-key rejection at every depth, without revivers. */
export function parseAntislopJson(source: string): unknown {
  let cursor = 0;
  const invalid = (): never => { throw new ApiError(400, "Invalid JSON body."); };
  const whitespace = (): void => { while (/[ \t\r\n]/.test(source[cursor] ?? "")) cursor += 1; };
  function string(): string {
    if (source[cursor] !== '"') invalid();
    const start = cursor++;
    let escaped = false;
    while (cursor < source.length) {
      const character = source[cursor++];
      if (escaped) { escaped = false; continue; }
      if (character === "\\") { escaped = true; continue; }
      if (character === '"') {
        try { return JSON.parse(source.slice(start, cursor)) as string; } catch { invalid(); }
      }
    }
    return invalid();
  }
  function value(depth: number): unknown {
    if (depth > 32) invalid();
    whitespace();
    const character = source[cursor];
    if (character === '"') return string();
    if (character === "{") {
      cursor += 1; whitespace();
      const result = Object.create(null) as Record<string, unknown>;
      if (source[cursor] === "}") { cursor += 1; return result; }
      while (true) {
        whitespace(); const key = string();
        if (Object.hasOwn(result, key)) invalid();
        whitespace(); if (source[cursor++] !== ":") invalid();
        result[key] = value(depth + 1);
        whitespace(); const delimiter = source[cursor++];
        if (delimiter === "}") return result;
        if (delimiter !== ",") invalid();
      }
    }
    if (character === "[") {
      cursor += 1; whitespace(); const result: unknown[] = [];
      if (source[cursor] === "]") { cursor += 1; return result; }
      while (true) {
        result.push(value(depth + 1)); whitespace(); const delimiter = source[cursor++];
        if (delimiter === "]") return result;
        if (delimiter !== ",") invalid();
      }
    }
    for (const literal of ["true", "false", "null"]) {
      if (source.startsWith(literal, cursor)) { cursor += literal.length; return JSON.parse(literal) as unknown; }
    }
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(cursor));
    if (match) {
      cursor += match[0].length;
      const number = Number(match[0]);
      if (!Number.isFinite(number)) invalid();
      return number;
    }
    return invalid();
  }
  const result = value(0); whitespace(); if (cursor !== source.length) invalid(); return result;
}

async function body(req: IncomingMessage, allowed: readonly string[], timeoutMs: number, maximum: number): Promise<Record<string, unknown>> {
  if (req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    req.resume(); throw new ApiError(415, "Use application/json.");
  }
  if (Number(req.headers["content-length"]) > maximum) { req.resume(); throw new ApiError(413, "Request body is too large."); }
  const raw = await new Promise<Buffer>((resolve, reject) => {
    let length = 0, settled = false;
    const chunks: Buffer[] = [];
    const finish = (error?: ApiError): void => {
      if (settled) return; settled = true;
      clearTimeout(timer); req.off("data", onData); req.off("end", onEnd); req.off("aborted", onAborted);
      if (error) { chunks.length = 0; req.resume(); reject(error); }
      else resolve(Buffer.concat(chunks));
    };
    const onData = (chunk: Buffer): void => {
      length += chunk.length;
      if (length > maximum) finish(new ApiError(413, "Request body is too large."));
      else chunks.push(chunk);
    };
    const onEnd = (): void => finish();
    const onAborted = (): void => finish(new ApiError(400, "Incomplete request body."));
    const timer = setTimeout(() => finish(new ApiError(408, "Request body took too long.")), timeoutMs);
    req.on("data", onData); req.once("end", onEnd); req.once("aborted", onAborted);
    // Keep this listener for late stream errors after timeout or cancellation.
    req.once("error", () => finish(new ApiError(400, "Invalid request body.")));
  });
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(raw); }
  catch { throw new ApiError(400, "Use valid UTF-8 JSON."); }
  const parsed = parseAntislopJson(source);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new ApiError(400, "Invalid request body.");
  const keys = Object.keys(parsed);
  if (keys.length !== allowed.length || keys.some(key => !allowed.includes(key))) throw new ApiError(400, "Invalid request fields.");
  return parsed as Record<string, unknown>;
}

function json(res: ServerResponse, status: number, payload: unknown): true {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(payload)); return true;
}

export interface AntislopHttpContext {
  store: AntislopStore;
  account: () => string;
  confirmAccount: (id: string) => void;
  bodyTimeoutMs: number;
}

/** Call only after the enclosing API verifies SERVICE_KEY and client limits.
 * Internal routes must never be included in the generic frontend proxy allowlist.
 */
export async function handleAntislop(req: IncomingMessage, res: ServerResponse, url: URL, context: AntislopHttpContext): Promise<boolean> {
  if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
  const { store, account, confirmAccount, bodyTimeoutMs } = context;
  if (!Number.isFinite(bodyTimeoutMs) || bodyTimeoutMs <= 0) throw new ApiError(500, "Invalid request timeout configuration.");
  if ([...url.searchParams].length !== 0) throw new ApiError(400, "Invalid query parameters.");
  const path = url.pathname.slice(PREFIX.length);
  const viewer = (): string | undefined => req.headers.authorization === undefined ? undefined : account();
  const writeBody = async (keys: readonly string[], maximum = SMALL_BODY_BYTES): Promise<{ id: string; input: Record<string, unknown> }> => {
    const id = account(); const input = await body(req, keys, bodyTimeoutMs, maximum); confirmAccount(id); return { id, input };
  };
  try {
    if (req.method === "GET" && path === "/arena") return json(res, 200, store.arena(viewer()));
    if (req.method === "GET" && path === "/me") return json(res, 200, store.me(account()));
    if (req.method === "POST" && path === "/privacy/erase") {
      const { id } = await writeBody([]);
      const expectedPlayer = req.headers["x-expected-player-id"];
      if (typeof expectedPlayer !== "string" || !/^p_[0-9a-f]{32}$/.test(expectedPlayer)) throw new ApiError(400, "Invalid expected player ID.");
      if (expectedPlayer !== id) throw new ApiError(409, "Your active player changed. Review this request before deleting private recaps.");
      return json(res, 200, store.erasePrivateEvidence(id));
    }
    const entry = /^\/entries\/(ae_[0-9a-f]{32})$/.exec(path);
    if (req.method === "GET" && entry?.[1]) return json(res, 200, store.entry(entry[1], viewer()));
    const duel = /^\/duels\/(ad_[0-9a-f]{32})$/.exec(path);
    if (req.method === "GET" && duel?.[1]) return json(res, 200, store.duel(duel[1], viewer()));
    if (req.method === "POST" && path === "/entries") {
      const { id, input } = await writeBody(["requestId", "draft", "refereeApproved", "publicSummary", "optedIn"], ENTRY_BODY_BYTES);
      const expectedPlayer = req.headers["x-expected-player-id"];
      if (expectedPlayer !== undefined) {
        if (typeof expectedPlayer !== "string" || expectedPlayer.length !== 34 || !/^p_[0-9a-f]{32}$/.test(expectedPlayer)) {
          throw new ApiError(400, "Invalid expected player ID.");
        }
        if (expectedPlayer !== id) throw new ApiError(409, "Your active player changed. Review this entry before submitting again.");
      }
      const result = store.submitEntry(id, input); return json(res, result.created ? 201 : 200, result.entry);
    }
    const participation = /^\/entries\/(ae_[0-9a-f]{32})\/participation$/.exec(path);
    if (req.method === "POST" && participation?.[1]) {
      const { id, input } = await writeBody(["optedIn"]); return json(res, 200, store.participation(id, participation[1], input));
    }
    if (req.method === "POST" && path === "/duels") {
      const { id, input } = await writeBody(["requestId", "entryId", "opponentEntryId"]);
      const result = store.createDuel(id, input); return json(res, result.created ? 202 : 200, result.duel);
    }
    const internal = /^\/internal\/duels\/(ad_[0-9a-f]{32})\/(claim|settle|fail)$/.exec(path);
    if (req.method === "POST" && internal?.[1]) {
      const action = internal[2];
      const keys = action === "claim" ? [] : action === "settle" ? ["leaseToken", "responseAB", "responseBA"] : ["leaseToken", "reason"];
      const { id, input } = await writeBody(keys);
      const result = action === "claim" ? store.claim(id, internal[1]) : action === "settle" ? store.settle(id, internal[1], input) : store.fail(id, internal[1], input);
      return json(res, 200, result);
    }
    throw new ApiError(404, "Route not found.");
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(500, "The AntiSlop request could not be completed.");
  }
}
