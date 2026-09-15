import { createHmac } from "node:crypto";
import { parseJsonText } from "../../../packages/elo-engine/src/canonical.ts";

const COOKIE = "elo_session";
const MAX_BODY = 16_384;
const TOKEN = /^[0-9a-f]{64}$/;
const PLAYER = "p_[0-9a-f]{32}";
const MATCH = "m_[0-9a-f]{32}";

export interface ProxyConfig {
  apiUrl?: string;
  serviceKey?: string;
  production?: boolean;
  fetcher?: typeof fetch;
  bodyTimeoutMs?: number;
}

function json(value: unknown, status = 200, cookie?: string): Response {
  const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  if (cookie) headers.set("Set-Cookie", cookie);
  return new Response(JSON.stringify(value), { status, headers });
}

function sessionCookie(token: string, production: boolean, remove = false): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${remove ? 0 : 31_536_000}${production ? "; Secure" : ""}`;
}

function tokenFromCookie(request: Request): string | null {
  const token = (request.headers.get("cookie") ?? "").split(";").map((s) => s.trim()).find((s) => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  return token && TOKEN.test(token) ? token : null;
}

function allowed(path: string, method: string): boolean {
  if (method === "GET") return [
    /^overview$/, /^me$/,
    new RegExp(`^players/${PLAYER}(?:/card\\.svg)?$`),
    /^users\/[a-z][a-z0-9_]{2,19}$/,
    new RegExp(`^matches/${MATCH}/card\\.svg$`),
    /^receipts\/sha256:[0-9a-f]{64}$/,
  ].some((pattern) => pattern.test(path));
  if (method === "POST") return ["players", "username", "session", "session/rotate", "assessment", "form", "queue"].includes(path);
  return method === "DELETE" && ["session", "queue"].includes(path);
}

class BodyReadError extends Error {
  constructor(readonly status: number) { super("Body read failed"); }
}

async function readBody(request: Request, timeoutMs: number): Promise<string> {
  if (request.signal.aborted) throw new BodyReadError(408);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) throw new RangeError("body");
  if (!request.body) return "{}";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let rejectDeadline: (error: BodyReadError) => void = () => {};
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const abort = () => { rejectDeadline(new BodyReadError(408)); void reader.cancel().catch(() => {}); };
  const timer = setTimeout(abort, timeoutMs);
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BODY) { void reader.cancel().catch(() => {}); throw new RangeError("body"); }
      chunks.push(part.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

export async function proxyApi(request: Request, segments: string[], config: ProxyConfig): Promise<Response> {
  const path = segments.join("/");
  const method = request.method;
  const production = config.production ?? false;
  if (!allowed(path, method)) return json({ error: "Not found." }, 404);
  const url = new URL(request.url);
  if (method !== "GET") {
    if (request.headers.get("origin") !== url.origin || request.headers.get("sec-fetch-site") === "cross-site") {
      return json({ error: "Open this page directly to continue." }, 403);
    }
    if (method === "POST" && request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      return json({ error: "Use a JSON receipt." }, 415);
    }
  }
  const queryKeys = (path === "overview" && method === "GET") || (path === "queue" && method === "DELETE") ? ["mode"] : [];
  for (const key of url.searchParams.keys()) {
    if (!queryKeys.includes(key) || url.searchParams.getAll(key).length !== 1) return json({ error: "Invalid query parameters." }, 400);
  }
  if (path === "session" && method === "DELETE") return json({ ok: true }, 200, sessionCookie("", production, true));
  if (!config.apiUrl || !config.serviceKey || config.serviceKey.length < 32) return json({ error: "The league is not connected yet. Please try again later." }, 503);
  let upstream: URL;
  try {
    upstream = new URL(config.apiUrl);
    if (upstream.username || upstream.password || !["https:", "http:"].includes(upstream.protocol) || (production && upstream.protocol !== "https:")) throw new Error("config");
  } catch { return json({ error: "The league connection is unavailable." }, 503); }
  let token = tokenFromCookie(request);
  if (["me", "username", "assessment", "form", "queue", "session/rotate"].includes(path) && !token) return json({ error: "Create a player or restore your session first." }, 401);
  if (path === "players" && method === "POST" && token) return json({ error: "You already have a player in this browser. Sign out first to create another." }, 409);
  let body: string | undefined;
  if (method === "POST") {
    try { body = await readBody(request, config.bodyTimeoutMs ?? 5_000); }
    catch (error) {
      if (error instanceof BodyReadError) return json({ error: "The upload took too long. Please try again." }, error.status);
      return json({ error: "Receipts must be smaller than 16 KB." }, 413);
    }
  }
  const recover = path === "session";
  if (recover) {
    try {
      const input: unknown = parseJsonText(body ?? "{}");
      if (typeof input !== "object" || input === null || Array.isArray(input) || Object.keys(input).length !== 1 || !("token" in input) || typeof input.token !== "string" || !TOKEN.test(input.token)) throw new Error("token");
      token = input.token;
    } catch { return json({ error: "Enter your 64-character recovery key." }, 400); }
  }
  upstream.pathname = `/v1/${recover ? "me" : path}`;
  upstream.search = "";
  const mode = url.searchParams.get("mode");
  if (mode !== null && ["overview", "queue"].includes(path)) upstream.searchParams.set("mode", mode);
  const clientIp = production ? (request.headers.get("x-vercel-forwarded-for") ?? "unknown") : "local";
  const clientId = createHmac("sha256", config.serviceKey).update(clientIp.slice(0, 256)).digest("hex");
  const headers: Record<string, string> = { "X-Service-Key": config.serviceKey, "X-Client-Id": clientId };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined && !recover) headers["Content-Type"] = "application/json";
  try {
    const result = await (config.fetcher ?? fetch)(upstream, {
      method: recover ? "GET" : method,
      headers,
      ...(body !== undefined && !recover ? { body } : {}),
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(12_000),
    });
    if (path.endsWith("/card.svg") && result.ok) {
      return new Response(await result.text(), { status: 200, headers: {
        "Content-Type": "image/svg+xml", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      } });
    }
    const payload = await result.json() as Record<string, unknown>;
    if (path === "me" && result.status === 401) return json(payload, 401, sessionCookie("", production, true));
    if (result.ok && ["players", "session/rotate"].includes(path) && method === "POST") {
      const newToken = payload.token;
      if (typeof newToken !== "string" || !TOKEN.test(newToken)) throw new Error("Invalid account response");
      const { token: _privateToken, ...publicResponse } = payload;
      return json({ ...publicResponse, recoveryKey: newToken }, result.status, sessionCookie(newToken, production));
    }
    return json(payload, result.status, recover && result.ok && token ? sessionCookie(token, production) : undefined);
  } catch { return json({ error: "The league is temporarily unavailable. Refresh to check whether your request completed before retrying." }, 502); }
}
