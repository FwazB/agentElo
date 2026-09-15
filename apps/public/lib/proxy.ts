import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { parseJsonText } from "../../../packages/elo-engine/src/canonical.ts";
import { boundedJson } from "../../../packages/referee/gateway.ts";

const COOKIE = "elo_session";
const PENDING_COOKIE = "elo_pending";
const PENDING_TTL_MS = 30 * 60 * 1000;
const MAX_BODY = 16_384;
const MAX_SESSION_RESPONSE = 512 * 1024;
const TOKEN = /^[0-9a-f]{64}$/;
const PLAYER = "p_[0-9a-f]{32}";
const MATCH = "m_[0-9a-f]{32}";
const ENTRY = "ae_[0-9a-f]{32}";
const DUEL = "ad_[0-9a-f]{32}";

export interface ProxyConfig {
  apiUrl?: string;
  serviceKey?: string;
  production?: boolean;
  fetcher?: typeof fetch;
  bodyTimeoutMs?: number;
  now?: () => number;
}

function json(value: unknown, status = 200, cookie?: string | string[]): Response {
  const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  if (cookie) for (const value of typeof cookie === "string" ? [cookie] : cookie) headers.append("Set-Cookie", value);
  return new Response(JSON.stringify(value), { status, headers });
}

function sessionCookie(token: string, production: boolean, remove = false): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${remove ? 0 : 31_536_000}${production ? "; Secure" : ""}`;
}

function tokenFromCookie(request: Request): string | null {
  const token = cookieValue(request, COOKIE);
  return token && TOKEN.test(token) ? token : null;
}

function cookieValue(request: Request, name: string): string | undefined {
  return (request.headers.get("cookie") ?? "").split(";").map(s => s.trim()).find(s => s.startsWith(`${name}=`))?.slice(name.length + 1);
}

function pendingSignature(token: string, expires: number, serviceKey: string): string {
  return createHmac("sha256", serviceKey).update(`computer-elo:pending-guest:v1\0${token}\0${expires}`).digest("hex");
}

function pendingCookie(value: string, production: boolean): string {
  return `${PENDING_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${value ? PENDING_TTL_MS / 1000 : 0}${production ? "; Secure" : ""}`;
}

function validPending(request: Request, token: string | null, serviceKey: string, now: number): boolean {
  const marker = cookieValue(request, PENDING_COOKIE);
  const match = marker && /^v1\.([0-9]{1,16})\.([0-9a-f]{64})$/.exec(marker);
  if (!token || !match) return false;
  const expires = Number(match[1]);
  return Number.isSafeInteger(expires) && expires > now && timingSafeEqual(
    Buffer.from(match[2]!, "hex"), Buffer.from(pendingSignature(token, expires, serviceKey), "hex"),
  );
}

function allowed(path: string, method: string): boolean {
  if (method === "GET") return [
    /^overview$/, /^me$/,
    new RegExp(`^players/${PLAYER}(?:/card\\.svg)?$`),
    /^users\/[a-z][a-z0-9_]{2,19}$/,
    new RegExp(`^matches/${MATCH}/card\\.svg$`),
    /^receipts\/sha256:[0-9a-f]{64}$/,
    /^antislop\/(?:arena|me)$/,
    new RegExp(`^antislop/entries/${ENTRY}$`),
    new RegExp(`^antislop/duels/${DUEL}$`),
  ].some((pattern) => pattern.test(path));
  if (method === "POST") return ["players", "username", "session", "session/rotate", "guest/session", "guest/player", "assessment", "form", "queue", "antislop/entries", "antislop/duels"].includes(path)
    || new RegExp(`^antislop/entries/${ENTRY}/participation$`).test(path);
  return method === "DELETE" && ["session", "queue"].includes(path);
}

class BodyReadError extends Error {
  constructor(readonly status: number) { super("Body read failed"); }
}

async function readBody(request: Request, timeoutMs: number, maximum = MAX_BODY): Promise<string> {
  if (request.signal.aborted) throw new BodyReadError(408);
  if (Number(request.headers.get("content-length") ?? 0) > maximum) throw new RangeError("body");
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
      if (size > maximum) { void reader.cancel().catch(() => {}); throw new RangeError("body"); }
      chunks.push(part.value);
    }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
    catch { throw new BodyReadError(400); }
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
  const privateEntry = path === "antislop/entries" && method === "POST";
  const expectedPlayer = privateEntry ? request.headers.get("x-expected-player-id") : null;
  if (privateEntry && (expectedPlayer === null || !new RegExp(`^${PLAYER}$`).test(expectedPlayer))) {
    return json({ error: "Review this entry for your current player before uploading it." }, 400);
  }
  if (path === "session" && method === "DELETE") return json({ ok: true }, 200, [sessionCookie("", production, true), pendingCookie("", production)]);
  if (!config.apiUrl || !config.serviceKey || config.serviceKey.length < 32) return json({ error: "The league is not connected yet. Please try again later." }, 503);
  let upstream: URL;
  try {
    upstream = new URL(config.apiUrl);
    if (upstream.username || upstream.password || !["https:", "http:"].includes(upstream.protocol) || (production && upstream.protocol !== "https:")) throw new Error("config");
  } catch { return json({ error: "The league connection is unavailable." }, 503); }
  let token = tokenFromCookie(request);
  const guestSession = path === "guest/session", guestPlayer = path === "guest/player";
  if (guestPlayer && !token) return json({ error: "Your player session is missing. Try creating your player again." }, 401);
  if ((["me", "username", "assessment", "form", "queue", "session/rotate", "antislop/me"].includes(path) || (method !== "GET" && path.startsWith("antislop/"))) && !token) return json({ error: "Create a player or restore your session first." }, 401);
  let body: string | undefined;
  if (method === "POST") {
    try { body = await readBody(request, config.bodyTimeoutMs ?? 5_000, path === "antislop/entries" ? 98_304 : MAX_BODY); }
    catch (error) {
      if (error instanceof BodyReadError) return json({ error: error.status === 400 ? "Use valid UTF-8 JSON." : "The upload took too long. Please try again." }, error.status);
      return json({ error: path === "antislop/entries" ? "Entry submissions must be smaller than 96 KB." : "Receipts must be smaller than 16 KB." }, 413);
    }
  }
  if (guestSession || guestPlayer) {
    try {
      const input: unknown = parseJsonText(body ?? "{}");
      if (typeof input !== "object" || input === null || Array.isArray(input)
        || Object.keys(input).length !== (guestPlayer ? 1 : 0)
        || (guestPlayer && (!Object.hasOwn(input, "username") || typeof (input as { username: unknown }).username !== "string"))) throw new Error("shape");
      if (guestPlayer) body = JSON.stringify({ username: (input as { username: string }).username, token });
    } catch { return json({ error: "Use the guest request format shown on this page." }, 400); }
  }
  const recover = path === "session";
  if (recover) {
    try {
      const input: unknown = parseJsonText(body ?? "{}");
      if (typeof input !== "object" || input === null || Array.isArray(input) || Object.keys(input).length !== 1 || !("token" in input) || typeof input.token !== "string" || !TOKEN.test(input.token)) throw new Error("token");
      token = input.token;
    } catch { return json({ error: "Enter your 64-character recovery key." }, 400); }
  }
  upstream.pathname = `/v1/${recover || guestSession ? "me" : guestPlayer ? "players" : path}`;
  upstream.search = "";
  const mode = url.searchParams.get("mode");
  if (mode !== null && ["overview", "queue"].includes(path)) upstream.searchParams.set("mode", mode);
  const clientIp = production ? (request.headers.get("x-vercel-forwarded-for") ?? "unknown") : "local";
  const clientId = createHmac("sha256", config.serviceKey).update(clientIp.slice(0, 256)).digest("hex");
  const headers: Record<string, string> = { "X-Service-Key": config.serviceKey, "X-Client-Id": clientId };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (privateEntry && expectedPlayer) headers["X-Expected-Player-Id"] = expectedPlayer;
  if (body !== undefined && !recover) headers["Content-Type"] = "application/json";
  try {
    // A stale cookie is not proof of an existing session. Check it without
    // changing cookies: another tab may already have completed a newer login.
    const signal = AbortSignal.timeout(12_000);
    if (privateEntry) {
      // Resolve identity with the exact captured bearer that will carry the
      // private body. A cookie changed by another tab cannot retarget this upload.
      const existing = await (config.fetcher ?? fetch)(new URL("/v1/me", upstream), {
        method: "GET", headers, cache: "no-store", redirect: "error", signal,
      });
      if (!existing.ok) {
        await existing.body?.cancel();
        if (existing.status === 401) return json({ error: "Your player session changed. Review your entry again before uploading it." }, 409);
        return json({ error: "We couldn’t verify your player. Try again before uploading your entry." }, 503);
      }
      const session = await boundedJson(existing, MAX_SESSION_RESPONSE) as { player?: { id?: unknown } } | null;
      const playerId = session?.player?.id;
      if (typeof playerId !== "string" || !new RegExp(`^${PLAYER}$`).test(playerId)) throw new Error("Invalid player response");
      if (playerId !== expectedPlayer) return json({ error: "Your player session changed. Review your entry again before uploading it." }, 409);
    }
    const checkSession = async () => {
      const existing = await (config.fetcher ?? fetch)(new URL("/v1/me", upstream), {
        method: "GET", headers, cache: "no-store", redirect: "error", signal,
      });
      await existing.body?.cancel();
      return existing;
    };
    const now = (config.now ?? Date.now)();
    const pending = (guestSession || guestPlayer) && validPending(request, token, config.serviceKey, now);
    if (guestSession) {
      if (token) {
        const existing = await checkSession();
        if (existing.ok) return json({ ok: true });
        if (existing.status !== 401) return json({ error: "We couldn’t check your existing player. Try again shortly." }, 503);
        if (pending) return json({ ok: true });
      }
      const guestToken = randomBytes(32).toString("hex"), expires = now + PENDING_TTL_MS;
      const marker = `v1.${expires}.${pendingSignature(guestToken, expires, config.serviceKey)}`;
      return json({ ok: true }, 200, [sessionCookie(guestToken, production), pendingCookie(marker, production)]);
    }
    if (guestPlayer) {
      // The marker proves recent issuance, not historical non-use. Until its TTL,
      // replay after rotation can create an unrelated new player, never access the
      // old one. An arbitrary invalid cookie without a valid marker is rejected.
      if (!pending) {
        const existing = await checkSession();
        if (existing.status === 401) return json({ error: "Your player session has expired. Try creating your player again." }, 401);
        if (!existing.ok) return json({ error: "We couldn’t check your existing player. Try again shortly." }, 503);
      }
      delete headers.Authorization;
    }
    if (path === "players" && method === "POST" && token) {
      const existing = await checkSession();
      if (existing.ok) return json({ error: "You already have a player in this browser. Sign out first to create another." }, 409);
      if (existing.status !== 401) return json({ error: "We couldn’t check your existing session. Try again before creating a player." }, 503);
      delete headers.Authorization;
    }
    const result = await (config.fetcher ?? fetch)(upstream, {
      method: recover ? "GET" : method,
      headers,
      ...(body !== undefined && !recover ? { body } : {}),
      cache: "no-store", redirect: "error", signal,
    });
    if (path.endsWith("/card.svg") && result.ok) {
      return new Response(await result.text(), { status: 200, headers: {
        "Content-Type": "image/svg+xml", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      } });
    }
    const payload = await result.json() as Record<string, unknown>;
    // Read failures must not erase a cookie set by a newer login response.
    if (guestPlayer) {
      const { token: privateToken, recoveryKey: _privateRecoveryKey, ...me } = payload;
      if (result.ok && privateToken !== token) throw new Error("Invalid guest account response");
      return json(me, result.status, result.ok ? pendingCookie("", production) : undefined);
    }
    if (result.ok && ["players", "session/rotate"].includes(path) && method === "POST") {
      const newToken = payload.token;
      if (typeof newToken !== "string" || !TOKEN.test(newToken)) throw new Error("Invalid account response");
      const { token: _privateToken, ...publicResponse } = payload;
      return json({ ...publicResponse, recoveryKey: newToken }, result.status, [sessionCookie(newToken, production), pendingCookie("", production)]);
    }
    return json(payload, result.status, recover && result.ok && token ? [sessionCookie(token, production), pendingCookie("", production)] : undefined);
  } catch { return json({ error: "The league is temporarily unavailable. Refresh to check whether your request completed before retrying." }, 502); }
}
