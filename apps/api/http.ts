import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { matchCardSvg, playerCardSvg } from "../../packages/elo-engine/src/cards.ts";
import { parseJsonText } from "../../packages/elo-engine/src/canonical.ts";
import type { EloMode } from "../../packages/elo-engine/src/constants.ts";
import { ApiError, type Store } from "./store.ts";
import { handleAntislop } from "./antislop/http.ts";
import type { AntislopStore } from "./antislop/store.ts";

const MAX_BODY_BYTES = 16_384;
const digest = (value: string) => createHash("sha256").update(value).digest();

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

async function body(req: IncomingMessage, allowed: readonly string[], timeoutMs: number, optional: readonly string[] = []): Promise<Record<string, unknown>> {
  if (req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    req.resume();
    throw new ApiError(415, "Use application/json.");
  }
  const raw = await new Promise<string>((resolve, reject) => {
    let length = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    const finish = (error?: ApiError, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("aborted", onAborted);
      chunks.length = 0;
      if (error) { req.resume(); reject(error); } else resolve(value!);
    };
    const onData = (chunk: Buffer) => {
      length += chunk.length;
      if (length > MAX_BODY_BYTES) finish(new ApiError(413, "Request body is too large."));
      else chunks.push(chunk);
    };
    const onEnd = () => finish(undefined, Buffer.concat(chunks).toString("utf8"));
    const onAborted = () => finish(new ApiError(400, "Incomplete request body."));
    const timer = setTimeout(() => finish(new ApiError(408, "Request body took too long.")), timeoutMs);
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("aborted", onAborted);
    // Keep the error listener after timeout: closing an incomplete request can emit a later stream error.
    req.once("error", () => finish(new ApiError(400, "Invalid request body.")));
  });
  let parsed: unknown;
  try { parsed = parseJsonText(raw); } catch { throw new ApiError(400, "Invalid JSON body."); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new ApiError(400, "Invalid request body.");
  const keys = Object.keys(parsed);
  if (allowed.some(key => !Object.hasOwn(parsed, key)) || keys.some(key => !allowed.includes(key) && !optional.includes(key))) throw new ApiError(400, "Invalid request fields.");
  return parsed as Record<string, unknown>;
}

function mode(value: unknown): EloMode {
  if (value !== "scalar" && value !== "binary") throw new ApiError(400, "Mode must be scalar or binary.");
  return value;
}

function query(url: URL, allowed: readonly string[]) {
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new ApiError(400, "Invalid query parameters.");
  }
}

/** A bounded fixed-window limiter. Full active tables reject new keys instead of evicting protection. */
function rateLimiter(now: () => number) {
  const buckets = new Map<string, { count: number; expires: number }>();
  return (key: string, limit: number, windowMs = 60_000) => {
    const time = now();
    let bucket = buckets.get(key);
    if (bucket && bucket.expires <= time) { buckets.delete(key); bucket = undefined; }
    if (!bucket) {
      if (buckets.size >= 10_000) {
        for (const [entry, value] of buckets) if (value.expires <= time) buckets.delete(entry);
        if (buckets.size >= 10_000) throw new ApiError(503, "Service is busy. Try again shortly.");
      }
      bucket = { count: 0, expires: time + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > limit) throw new ApiError(429, "Too many requests. Try again later.");
  };
}

export interface ApiServerOptions {
  store: Store;
  serviceKey: string;
  now?: () => number;
  bodyTimeoutMs?: number;
  antislop?: AntislopStore;
}

export function createApiServer({ store, serviceKey, now = Date.now, bodyTimeoutMs = 5_000, antislop }: ApiServerOptions) {
  if (serviceKey.length < 32) throw new Error("SERVICE_KEY must contain at least 32 characters.");
  if (!Number.isFinite(bodyTimeoutMs) || bodyTimeoutMs <= 0) throw new Error("Body timeout must be positive.");
  const expectedKey = digest(serviceKey);
  const limit = rateLimiter(now);
  const server = createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
    try {
      const url = new URL(req.url ?? "/", "http://api.internal");
      if (url.pathname === "/health" && req.method === "GET") {
        query(url, []);
        return json(res, 200, { status: "ok" });
      }
      if (!url.pathname.startsWith("/v1/")) throw new ApiError(404, "Route not found.");
      const suppliedKey = req.headers["x-service-key"];
      if (typeof suppliedKey !== "string" || !timingSafeEqual(digest(suppliedKey), expectedKey)) throw new ApiError(401, "Service authentication required.");
      // Only the authenticated Vercel server may supply this HMAC of the client address.
      const clientId = req.headers["x-client-id"];
      if (typeof clientId !== "string" || !/^[0-9a-f]{64}$/.test(clientId)) throw new ApiError(400, "Client identity required.");
      limit(`client:${clientId}`, 120);
      if (req.method !== "GET") limit(`write:${clientId}`, 30);
      const account = (): string => {
        const auth = req.headers.authorization;
        if (!auth?.startsWith("Bearer ")) throw new ApiError(401, "Account token required.");
        const id = store.authenticate(auth.slice(7));
        limit(`account:${id}`, 120);
        return id;
      };
      const confirmAccount = (id: string): void => {
        // Body upload can outlive token rotation; recheck after every awaited account write body.
        const auth = req.headers.authorization;
        if (!auth?.startsWith("Bearer ") || store.authenticate(auth.slice(7)) !== id) {
          throw new ApiError(401, "Invalid account token.");
        }
      };

      if (url.pathname.startsWith("/v1/antislop/")) {
        if (!antislop) throw new ApiError(503, "The arena is temporarily unavailable.");
        if (await handleAntislop(req, res, url, { store: antislop, account, confirmAccount, bodyTimeoutMs })) return;
        throw new ApiError(404, "Route not found.");
      }

      if (url.pathname === "/v1/overview" && req.method === "GET") {
        query(url, ["mode"]);
        return json(res, 200, store.overview(mode(url.searchParams.get("mode") ?? "scalar")));
      }
      if (url.pathname === "/v1/players" && req.method === "POST") {
        query(url, []);
        limit(`create:${clientId}`, 5, 3_600_000);
        const value = await body(req, ["username", "token"], bodyTimeoutMs);
        return json(res, 201, store.createPlayer(value.username, value.token));
      }
      if (url.pathname === "/v1/me" && req.method === "GET") {
        query(url, []);
        return json(res, 200, store.me(account()));
      }
      if (url.pathname === "/v1/username" && req.method === "POST") {
        query(url, []);
        const id = account();
        const value = await body(req, ["username"], bodyTimeoutMs);
        confirmAccount(id);
        return json(res, 200, store.claimUsername(id, value.username));
      }
      if (url.pathname === "/v1/session/rotate" && req.method === "POST") {
        query(url, []);
        const id = account();
        const value = await body(req, ["replacementToken"], bodyTimeoutMs);
        confirmAccount(id);
        return json(res, 200, store.rotateToken(id, value.replacementToken));
      }
      const user = /^\/v1\/users\/([^/]+)$/.exec(url.pathname);
      if (user?.[1] && req.method === "GET") {
        query(url, []);
        let username: string;
        try { username = decodeURIComponent(user[1]); }
        catch { throw new ApiError(400, "Invalid username."); }
        return json(res, 200, store.userView(username));
      }
      if (url.pathname === "/v1/form" && req.method === "POST") {
        query(url, []);
        const id = account();
        const value = await body(req, ["receipt"], bodyTimeoutMs);
        confirmAccount(id);
        return json(res, 200, store.importForm(id, value.receipt));
      }
      if (url.pathname === "/v1/assessment" && req.method === "POST") {
        query(url, []);
        const id = account();
        const value = await body(req, ["weekId", "formScore", "coveragePpm", "certaintyPpm"], bodyTimeoutMs, ["aiSystem", "contextSource"]);
        confirmAccount(id);
        return json(res, 200, store.assessment(id, { weekId: value.weekId, formScore: value.formScore,
          coveragePpm: value.coveragePpm, certaintyPpm: value.certaintyPpm,
          ...(Object.hasOwn(value, "aiSystem") || Object.hasOwn(value, "contextSource") ? { aiSystem: value.aiSystem, contextSource: value.contextSource } : {}) }));
      }
      if (url.pathname === "/v1/queue" && req.method === "POST") {
        query(url, []);
        const id = account();
        const value = await body(req, ["mode"], bodyTimeoutMs);
        confirmAccount(id);
        return json(res, 200, store.joinQueue(id, mode(value.mode)));
      }
      if (url.pathname === "/v1/queue" && req.method === "DELETE") {
        query(url, ["mode"]);
        return json(res, 200, store.cancelQueue(account(), mode(url.searchParams.get("mode"))));
      }
      const player = /^\/v1\/players\/(p_[0-9a-f]{32})(\/card\.svg)?$/.exec(url.pathname);
      if (player?.[1] && req.method === "GET") {
        query(url, []);
        const view = store.playerView(player[1]);
        if (!player[2]) return json(res, 200, view);
        if (!view.player.receipt) throw new ApiError(404, "Player has no Form receipt.");
        const svg = playerCardSvg(view.player.receipt);
        res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8" });
        return res.end(svg);
      }
      const match = /^\/v1\/matches\/(m_[0-9a-f]{32})\/card\.svg$/.exec(url.pathname);
      if (match?.[1] && req.method === "GET") {
        query(url, []);
        const svg = matchCardSvg(store.match(match[1]));
        res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8" });
        return res.end(svg);
      }
      if (url.pathname.startsWith("/v1/receipts/") && req.method === "GET") {
        query(url, []);
        let fingerprint: string;
        try { fingerprint = decodeURIComponent(url.pathname.slice("/v1/receipts/".length)); }
        catch { throw new ApiError(400, "Invalid fingerprint."); }
        if (!/^sha256:[0-9a-f]{64}$/.test(fingerprint)) throw new ApiError(400, "Invalid fingerprint.");
        return json(res, 200, store.receipt(fingerprint));
      }
      throw new ApiError(404, "Route not found.");
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      if (error instanceof ApiError) {
        if (error.status === 408 || error.status === 413) res.setHeader("connection", "close");
        if (error.status === 429 || error.status === 503) res.setHeader("retry-after", "60");
        json(res, error.status, { error: error.message });
      } else {
        // Do not echo parser diagnostics, database internals, imported fields, or tokens.
        json(res, 500, { error: "The request could not be completed." });
      }
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
