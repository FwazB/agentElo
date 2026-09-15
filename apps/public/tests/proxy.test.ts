import test from "node:test";
import assert from "node:assert/strict";
import { proxyApi, type ProxyConfig } from "../lib/proxy.ts";

const token = "a".repeat(64);
const playerId = `p_${"a".repeat(32)}`;
const serviceKey = "s".repeat(64);
const request = (path: string, method = "GET", body?: unknown, origin = "https://elo.test") => new Request(`https://elo.test/api/${path}`, {
  method, headers: { origin, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});
const config: ProxyConfig = { apiUrl: "https://api.test", serviceKey, production: true };

test("missing deployment config is unavailable, never a fake league", async () => {
  assert.equal((await proxyApi(request("overview"), ["overview"], {})).status, 503);
});
test("cross-origin writes and unknown routes never reach backend", async () => {
  let calls = 0;
  const c = { ...config, fetcher: (async () => { calls++; return Response.json({}); }) as typeof fetch };
  assert.equal((await proxyApi(request("players", "POST", {}, "https://evil.test"), ["players"], c)).status, 403);
  assert.equal((await proxyApi(request("admin"), ["admin"], c)).status, 404);
  assert.equal((await proxyApi(request("form", "POST", {}), ["form"], c)).status, 401);
  assert.equal(calls, 0);
});
test("account creation sets secure HttpOnly cookie, returns recovery key only once", async () => {
  const c = { ...config, fetcher: (async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("x-service-key"), serviceKey);
    return Response.json({ token, player: { id: "p_123", receipt: null }, queue: [], matches: [] }, { status: 201 });
  }) as typeof fetch };
  const result = await proxyApi(request("players", "POST", {}), ["players"], c);
  assert.equal(result.status, 201);
  const body = await result.json();
  assert.equal(body.recoveryKey, token);
  assert.equal(body.token, undefined);
  assert.match(result.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict; Max-Age=31536000; Secure/);
});
test("restore validates server identity before issuing cookie", async () => {
  const c = { ...config, fetcher: (async (url, init) => {
    assert.equal(String(url), "https://api.test/v1/me");
    assert.equal(init?.method, "GET");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`);
    assert.equal(init?.body, undefined);
    return Response.json({ error: "Invalid session." }, { status: 401 });
  }) as typeof fetch };
  const result = await proxyApi(request("session", "POST", { token }), ["session"], c);
  assert.equal(result.status, 401);
  assert.equal(result.headers.get("set-cookie"), null);
});
test("oversized bodies are rejected before forwarding", async () => {
  const result = await proxyApi(request("players", "POST", { data: "x".repeat(20_000) }), ["players"], config);
  assert.equal(result.status, 413);
});
test("invalid UTF-8 evidence cannot be silently rewritten by the proxy", async () => {
  let calls = 0;
  const req = new Request("https://elo.test/api/antislop/entries", {
    method: "POST", headers: { origin: "https://elo.test", "content-type": "application/json", cookie: `elo_session=${token}`, "x-expected-player-id": playerId },
    body: new Uint8Array([123, 34, 120, 34, 58, 34, 0xc3, 0x28, 34, 125]),
  });
  const result = await proxyApi(req, ["antislop", "entries"], { ...config, fetcher: (async () => { calls++; return Response.json({}); }) as typeof fetch });
  assert.equal(result.status, 400); assert.equal(calls, 0);
});

test("private entry uploads require a valid expected player before reading or forwarding the body", async () => {
  for (const expected of [undefined, "p_short", `p_${"A".repeat(32)}`, `${playerId}, ${playerId}`, "private-canary"]) {
    let pulls = 0, calls = 0;
    const stream = new ReadableStream({ pull() { pulls++; } }, { highWaterMark: 0 });
    const headers = new Headers({ origin: "https://elo.test", "content-type": "application/json", cookie: `elo_session=${token}` });
    if (expected !== undefined) headers.set("x-expected-player-id", expected);
    const req = new Request("https://elo.test/api/antislop/entries", { method: "POST", headers, body: stream, duplex: "half" } as RequestInit);
    const response = await proxyApi(req, ["antislop", "entries"], { ...config, fetcher: (async () => { calls++; return Response.json({}); }) as typeof fetch });
    assert.equal(response.status, 400); assert.equal(pulls, 0); assert.equal(calls, 0);
    assert.equal(response.headers.get("set-cookie"), null); assert.equal((await response.text()).includes("private-canary"), false);
  }
});

test("a private entry reviewed for A is never uploaded when the captured cookie belongs to B", async () => {
  const tokenB = "b".repeat(64), playerB = `p_${"b".repeat(32)}`;
  let calls = 0;
  const req = request("antislop/entries", "POST", { draft: "private-review-for-player-A" });
  req.headers.set("cookie", `elo_session=${tokenB}`); req.headers.set("x-expected-player-id", playerId);
  const response = await proxyApi(req, ["antislop", "entries"], { ...config, fetcher: (async (url, init) => {
    calls++; assert.equal(String(url), "https://api.test/v1/me"); assert.equal(init?.method, "GET");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${tokenB}`);
    assert.equal(init?.body, undefined);
    return Response.json({ player: { id: playerB } });
  }) as typeof fetch });
  assert.equal(calls, 1); assert.equal(response.status, 409); assert.equal(response.headers.get("set-cookie"), null);
  assert.equal((await response.text()).includes("private-review-for-player-A"), false);
});

test("private erasure is same-origin, authenticated and bound to the reviewed player", async () => {
  const segments = ["antislop", "privacy", "erase"];
  for (const scenario of ["cross-origin", "missing-cookie", "missing-player", "changed-player", "valid"] as const) {
    const req = request("antislop/privacy/erase", "POST", {}, scenario === "cross-origin" ? "https://evil.test" : "https://elo.test");
    if (scenario !== "missing-cookie") req.headers.set("cookie", `elo_session=${token}`);
    if (scenario !== "missing-player") req.headers.set("x-expected-player-id", playerId);
    let calls = 0;
    const response = await proxyApi(req, segments, { ...config, fetcher: (async (url, init) => {
      calls++;
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), `Bearer ${token}`);
      assert.equal(headers.get("x-expected-player-id"), playerId);
      if (calls === 1) {
        assert.equal(String(url), "https://api.test/v1/me");
        assert.equal(init?.body, undefined);
        // A later cookie change must not retarget an already confirmed erasure.
        req.headers.set("cookie", `elo_session=${"b".repeat(64)}`);
        return Response.json({ player: { id: scenario === "changed-player" ? `p_${"b".repeat(32)}` : playerId } });
      }
      assert.equal(String(url), "https://api.test/v1/antislop/privacy/erase");
      assert.equal(init?.method, "POST"); assert.equal(init?.body, "{}");
      return Response.json({ erased: true });
    }) as typeof fetch });
    assert.equal(response.status, { "cross-origin": 403, "missing-cookie": 401, "missing-player": 400, "changed-player": 409, valid: 200 }[scenario]);
    assert.equal(calls, scenario === "valid" ? 2 : scenario === "changed-player" ? 1 : 0);
    assert.equal(response.headers.get("set-cookie"), null);
    if (scenario === "valid") assert.deepEqual(await response.json(), { erased: true });
  }
});

test("a verified private upload keeps its captured bearer and expected player through later cookie changes", async () => {
  const body = { draft: "private-" + "x".repeat(20_000) };
  const req = request("antislop/entries", "POST", body);
  req.headers.set("cookie", `elo_session=${token}`); req.headers.set("x-expected-player-id", playerId);
  let calls = 0;
  let preflightSignal: AbortSignal | null | undefined;
  const response = await proxyApi(req, ["antislop", "entries"], { ...config, fetcher: (async (url, init) => {
    calls++;
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${token}`);
    assert.equal(headers.get("x-expected-player-id"), playerId);
    assert.equal(headers.get("x-service-key"), serviceKey);
    assert.equal(init?.redirect, "error"); assert.equal(init?.cache, "no-store");
    if (calls === 1) {
      assert.equal(String(url), "https://api.test/v1/me"); assert.equal(init?.method, "GET"); assert.equal(init?.body, undefined);
      preflightSignal = init?.signal;
      req.headers.set("cookie", `elo_session=${"b".repeat(64)}`);
      req.headers.set("x-expected-player-id", `p_${"b".repeat(32)}`);
      return Response.json({ player: { id: playerId }, matches: [], queue: [] });
    }
    assert.equal(String(url), "https://api.test/v1/antislop/entries"); assert.equal(init?.method, "POST");
    assert.equal(init?.body, JSON.stringify(body)); assert.equal(init?.signal, preflightSignal);
    return Response.json({ entryId: "ae_created", participantId: playerId }, { status: 201 });
  }) as typeof fetch });
  assert.equal(calls, 2); assert.equal(response.status, 201);
  assert.equal((await response.json()).participantId, playerId); assert.equal(response.headers.get("set-cookie"), null);
});

test("failed player verification never forwards private entry data or changes cookies", async () => {
  const variants = [401, 403, 429, 500, "network", "timeout", "malformed", "invalid-player", "invalid-utf8"] as const;
  for (const variant of variants) {
    let calls = 0;
    const req = request("antislop/entries", "POST", { draft: "private-entry-canary" });
    req.headers.set("cookie", `elo_session=${token}`); req.headers.set("x-expected-player-id", playerId);
    const response = await proxyApi(req, ["antislop", "entries"], { ...config, fetcher: (async (url, init) => {
      calls++; assert.equal(String(url), "https://api.test/v1/me"); assert.equal(init?.body, undefined);
      if (variant === "network") throw new Error("private-network-detail");
      if (variant === "timeout") throw new DOMException("private-timeout-detail", "TimeoutError");
      if (variant === "malformed") return new Response("{private-malformed-detail");
      if (variant === "invalid-player") return Response.json({ player: { id: "private-wrong-id" } });
      if (variant === "invalid-utf8") return new Response(new Uint8Array([0xff]));
      return Response.json({ error: "private-service-detail" }, { status: variant });
    }) as typeof fetch });
    const expectedStatus = variant === 401 ? 409 : typeof variant === "number" ? 503 : 502;
    assert.equal(calls, 1); assert.equal(response.status, expectedStatus, String(variant));
    assert.equal(response.headers.get("set-cookie"), null); assert.equal((await response.text()).includes("private-"), false);
  }
});

test("player verification bounds streamed and declared response sizes before private upload", async () => {
  for (const declared of [false, true]) {
    let calls = 0, cancelled = false;
    const req = request("antislop/entries", "POST", { draft: "private-entry-canary" });
    req.headers.set("cookie", `elo_session=${token}`); req.headers.set("x-expected-player-id", playerId);
    const response = await proxyApi(req, ["antislop", "entries"], { ...config, fetcher: (async () => {
      calls++;
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(512 * 1024 + 1)); },
        cancel() { cancelled = true; },
      }), { headers: declared ? { "content-length": String(512 * 1024 + 1) } : {} });
    }) as typeof fetch });
    assert.equal(calls, 1); assert.equal(response.status, 502); assert.equal(cancelled, true);
    assert.equal(response.headers.get("set-cookie"), null);
  }
});
test("bearer headers from a caller do not override session cookies", async () => {
  const req = request("me"); req.headers.set("authorization", `Bearer ${token}`);
  assert.equal((await proxyApi(req, ["me"], config)).status, 401);
});
test("logout expires cookie even while backend is offline", async () => {
  const result = await proxyApi(request("session", "DELETE"), ["session"], {});
  assert.equal(result.status, 200);
  assert.match(result.headers.get("set-cookie")!, /Max-Age=0/);
});

test("protected writes reject a missing cookie without consuming the body", async () => {
  let pulls = 0, calls = 0;
  const stream = new ReadableStream({ pull() { pulls++; } }, { highWaterMark: 0 });
  const req = new Request("https://elo.test/api/assessment", {
    method: "POST", headers: { origin: "https://elo.test", "content-type": "application/json" }, body: stream, duplex: "half",
  } as RequestInit);
  const result = await proxyApi(req, ["assessment"], { ...config, fetcher: (async () => { calls++; return Response.json({}); }) as typeof fetch });
  assert.equal(result.status, 401); assert.equal(pulls, 0); assert.equal(calls, 0);
});

test("slow body times out and cancels without reaching the backend", async () => {
  let cancelled = false, calls = 0;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  const req = new Request("https://elo.test/api/players", {
    method: "POST", headers: { origin: "https://elo.test", "content-type": "application/json" }, body: stream, duplex: "half",
  } as RequestInit);
  const result = await proxyApi(req, ["players"], { ...config, bodyTimeoutMs: 10, fetcher: (async () => { calls++; return Response.json({}); }) as typeof fetch });
  assert.equal(result.status, 408); assert.equal(cancelled, true); assert.equal(calls, 0);
});

test("an already aborted upload never reaches backend", async () => {
  let calls = 0;
  const req = new Request("https://elo.test/api/players", {
    method: "POST", headers: { origin: "https://elo.test", "content-type": "application/json" }, body: "{}", signal: AbortSignal.abort(),
  });
  const result = await proxyApi(req, ["players"], { ...config, fetcher: (async () => { calls++; return Response.json({}); }) as typeof fetch });
  assert.equal(result.status, 408); assert.equal(calls, 0);
});

test("rotation replaces the secure cookie and keeps backend token out of response", async () => {
  const replacementToken = "b".repeat(64);
  const req = request("session/rotate", "POST", { replacementToken });
  req.headers.set("cookie", `elo_session=${token}`);
  const result = await proxyApi(req, ["session", "rotate"], { ...config, fetcher: (async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`);
    assert.equal(JSON.parse(init?.body as string).replacementToken, replacementToken);
    return Response.json({ token: replacementToken, player: { username: "alice" } });
  }) as typeof fetch });
  assert.match(result.headers.get("set-cookie")!, new RegExp(`elo_session=${replacementToken};.*HttpOnly;.*Secure`));
  const body = await result.json(); assert.equal(body.token, undefined); assert.equal(body.recoveryKey, replacementToken);
});

test("revoked me and failed recovery do not mutate session cookies", async () => {
  const c = { ...config, fetcher: (async () => Response.json({ error: "Invalid session" }, { status: 401 })) as typeof fetch };
  const req = request("me"); req.headers.set("cookie", `elo_session=${token}`);
  const revoked = await proxyApi(req, ["me"], c);
  assert.equal(revoked.status, 401); assert.equal(revoked.headers.get("set-cookie"), null);
  const recover = request("session", "POST", { token: "b".repeat(64) }); recover.headers.set("cookie", `elo_session=${token}`);
  assert.equal((await proxyApi(recover, ["session"], c)).headers.get("set-cookie"), null);
});

test("a delayed old-session failure cannot erase a successful newer login", async () => {
  const replacementToken = "b".repeat(64);
  const staleCheck = Promise.withResolvers<Response>();
  let started = false;
  const c = { ...config, fetcher: (async (_url, init) => {
    if (new Headers(init?.headers).get("authorization") === `Bearer ${token}`) {
      started = true;
      return staleCheck.promise;
    }
    return Response.json({ player: { id: "p_new_session" } });
  }) as typeof fetch };
  const req = request("me"); req.headers.set("cookie", `elo_session=${token}`);
  const pending = proxyApi(req, ["me"], c);
  assert.equal(started, true);
  const recovered = await proxyApi(request("session", "POST", { token: replacementToken }), ["session"], c);
  assert.equal(recovered.status, 200);
  assert.match(recovered.headers.get("set-cookie")!, new RegExp(`elo_session=${replacementToken};`));
  staleCheck.resolve(Response.json({ error: "Invalid account token." }, { status: 401 }));
  const delayed = await pending;
  assert.equal(delayed.status, 401); assert.equal(delayed.headers.get("set-cookie"), null);
});

test("signup verifies a stale cookie and omits its bearer credential when creating the account", async () => {
  const replacementToken = "b".repeat(64), input = { username: "new_player", token: replacementToken };
  let calls = 0;
  let checkSignal: AbortSignal | null | undefined;
  const c = { ...config, apiUrl: "https://api.test/ignored?ignored=yes", fetcher: (async (url, init) => {
    calls++;
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-service-key"), serviceKey);
    assert.match(headers.get("x-client-id")!, /^[0-9a-f]{64}$/);
    assert.equal(init?.redirect, "error"); assert.equal(init?.cache, "no-store");
    assert(init?.signal instanceof AbortSignal);
    if (calls === 1) {
      assert.equal(String(url), "https://api.test/v1/me"); assert.equal(init?.method, "GET");
      assert.equal(init?.body, undefined); assert.equal(headers.get("authorization"), `Bearer ${token}`);
      checkSignal = init?.signal;
      return Response.json({ error: "Invalid account token." }, { status: 401 });
    }
    assert.equal(String(url), "https://api.test/v1/players"); assert.equal(init?.method, "POST");
    assert.equal(headers.get("authorization"), null);
    assert.deepEqual(JSON.parse(init?.body as string), input);
    assert.equal(init?.signal, checkSignal, "both requests share one timeout budget");
    return Response.json({ token: replacementToken, player: { id: "p_new_player" } }, { status: 201 });
  }) as typeof fetch };
  const req = request("players", "POST", input); req.headers.set("cookie", `elo_session=${token}`);
  const result = await proxyApi(req, ["players"], c);
  assert.equal(calls, 2); assert.equal(result.status, 201);
  assert.match(result.headers.get("set-cookie")!, new RegExp(`elo_session=${replacementToken};.*HttpOnly;.*Secure`));
});

test("signup preserves a valid existing session and never creates a second player", async () => {
  let calls = 0;
  const c = { ...config, fetcher: (async (url, init) => {
    calls++;
    assert.equal(String(url), "https://api.test/v1/me"); assert.equal(init?.method, "GET");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`);
    return Response.json({ player: { id: "p_existing" } });
  }) as typeof fetch };
  const req = request("players", "POST", { username: "second_player", token: "b".repeat(64) });
  req.headers.set("cookie", `elo_session=${token}`);
  const result = await proxyApi(req, ["players"], c);
  assert.equal(calls, 1); assert.equal(result.status, 409); assert.equal(result.headers.get("set-cookie"), null);
});

test("signup fails closed without changing cookies when the existing session cannot be checked", async () => {
  for (const status of [403, 404, 429, 500, 503, "network", "timeout"] as const) {
    let calls = 0;
    const c = { ...config, fetcher: (async (url, init) => {
      calls++; assert.equal(String(url), "https://api.test/v1/me"); assert.equal(init?.method, "GET");
      if (status === "network") throw new Error("private-network-detail");
      if (status === "timeout") throw new DOMException("private-timeout-detail", "TimeoutError");
      return Response.json({ error: "private-upstream-detail" }, { status });
    }) as typeof fetch };
    const req = request("players", "POST", { username: "second_player", token: "b".repeat(64) });
    req.headers.set("cookie", `elo_session=${token}`);
    const result = await proxyApi(req, ["players"], c);
    assert.equal(calls, 1, String(status));
    assert.equal(result.status, typeof status === "number" ? 503 : 502);
    assert.equal(result.headers.get("set-cookie"), null); assert.equal((await result.text()).includes("private-"), false);
  }
});

test("a rejected signup after stale-cookie verification still leaves cookies untouched", async () => {
  let calls = 0;
  const c = { ...config, fetcher: (async (_url, init) => {
    calls++;
    if (calls === 1) return Response.json({ error: "Invalid account token." }, { status: 401 });
    assert.equal(init?.body, "{broken");
    assert.equal(new Headers(init?.headers).get("authorization"), null);
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }) as typeof fetch };
  const req = new Request("https://elo.test/api/players", { method: "POST", headers: {
    origin: "https://elo.test", "content-type": "application/json", cookie: `elo_session=${token}`,
  }, body: "{broken" });
  const result = await proxyApi(req, ["players"], c);
  assert.equal(calls, 2); assert.equal(result.status, 400); assert.equal(result.headers.get("set-cookie"), null);
});

test("username routes forward only accepted names to the fixed backend", async () => {
  let calls = 0;
  const c = { ...config, fetcher: (async url => { calls++; assert.equal(String(url), "https://api.test/v1/users/alice"); return Response.json({ player: { username: "alice" } }); }) as typeof fetch };
  assert.equal((await proxyApi(request("users/alice"), ["users", "alice"], c)).status, 200);
  for (const value of ["../me", "<script>", "admin?x=y", "a", "AlicE", "аlice"]) {
    assert.equal((await proxyApi(request("users/test"), ["users", value], c)).status, 404);
  }
  assert.equal(calls, 1);
});

test("recovery rejects ambiguous duplicate JSON keys before forwarding", async () => {
  let calls = 0;
  const c = { ...config, fetcher: (async () => { calls++; return Response.json({ player: {} }); }) as typeof fetch };
  for (const body of [`{"token":"${token}","token":"${token}"}`, `{"token":"${token}","\\u0074oken":"${"b".repeat(64)}"}`]) {
    const req = new Request("https://elo.test/api/session", { method: "POST", headers: { origin: "https://elo.test", "content-type": "application/json" }, body });
    const response = await proxyApi(req, ["session"], c);
    assert.equal(response.status, 400); assert.equal(response.headers.get("set-cookie"), null);
  }
  assert.equal(calls, 0);
});

test("BFF rejects duplicate or unexpected query parameters instead of silently dropping them", async () => {
  let calls = 0;
  const c = { ...config, fetcher: (async () => { calls++; return Response.json({}); }) as typeof fetch };
  for (const [path, method] of [["overview?mode=scalar&mode=binary", "GET"], ["overview?extra=1", "GET"], ["me?mode=scalar", "GET"], ["queue?mode=scalar&mode=binary", "DELETE"], ["session?unexpected=1", "DELETE"], ["queue?mode=binary", "POST"]]) {
    const req = request(path!, method!, method === "POST" ? { mode: "scalar" } : undefined);
    req.headers.set("cookie", `elo_session=${token}`);
    assert.equal((await proxyApi(req, [path!.split("?")[0]!], c)).status, 400, path);
  }
  assert.equal(calls, 0);
  const valid = { ...config, fetcher: (async url => { assert.equal(String(url), "https://api.test/v1/overview?mode=binary"); return Response.json({}); }) as typeof fetch };
  assert.equal((await proxyApi(request("overview?mode=binary"), ["overview"], valid)).status, 200);
});

test("JSON media type is case insensitive and accepts a charset parameter", async () => {
  const req = request("session", "POST", { token }); req.headers.set("content-type", "Application/JSON; charset=UTF-8");
  const response = await proxyApi(req, ["session"], { ...config, fetcher: (async () => Response.json({ player: { id: "p_test" } })) as typeof fetch });
  assert.equal(response.status, 200); assert.match(response.headers.get("set-cookie")!, /HttpOnly/);
});

const GUEST_NOW = Date.parse("2026-09-16T12:00:00.000Z");
function guestRequest(path: "session" | "player", body: unknown, cookie?: string): Request {
  const req = request(`guest/${path}`, "POST", body);
  if (cookie) req.headers.set("cookie", cookie);
  return req;
}
async function pendingGuest() {
  const response = await proxyApi(guestRequest("session", {}), ["guest", "session"], { ...config, now: () => GUEST_NOW });
  const values = response.headers.getSetCookie().map(value => value.split(";")[0]!);
  return { response, cookie: values.join("; "), token: values.find(value => value.startsWith("elo_session="))!.slice("elo_session=".length) };
}

test("guest bootstrap allocates only private cookies, never a player or a response-body credential", async () => {
  let calls = 0;
  const response = await proxyApi(guestRequest("session", {}), ["guest", "session"], {
    ...config, now: () => GUEST_NOW, fetcher: (async () => { calls++; throw new Error("Unexpected allocation"); }) as typeof fetch,
  });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true }); assert.equal(calls, 0);
  const cookies = response.headers.getSetCookie(); assert.equal(cookies.length, 2);
  assert.match(cookies[0]!, /^elo_session=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=31536000; Secure$/);
  assert.match(cookies[1]!, /^elo_pending=v1\.[0-9]+\.[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=1800; Secure$/);
});

test("guest bootstrap preserves a known player even with an expired pending marker", async () => {
  const guest = await pendingGuest();
  let calls = 0;
  const response = await proxyApi(guestRequest("session", {}, guest.cookie), ["guest", "session"], {
    ...config, now: () => GUEST_NOW + 31 * 60_000, fetcher: (async (url, init) => {
      calls++; assert.equal(String(url), "https://api.test/v1/me"); assert.equal(init?.method, "GET");
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${guest.token}`);
      assert.equal(init?.body, undefined);
      return Response.json({ player: { id: "p_existing" } });
    }) as typeof fetch,
  });
  assert.equal(calls, 1); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get("set-cookie"), null);
});

test("guest bootstrap retries preserve a pending key but stale or expired credentials get a fresh key", async () => {
  const guest = await pendingGuest();
  const missing: ProxyConfig["fetcher"] = async (_url, init) => {
    assert.equal(init?.method, "GET"); return Response.json({ error: "Invalid account token." }, { status: 401 });
  };
  const retried = await proxyApi(guestRequest("session", {}, guest.cookie), ["guest", "session"], { ...config, now: () => GUEST_NOW + 1000, fetcher: missing });
  assert.equal(retried.status, 200); assert.equal(retried.headers.get("set-cookie"), null);
  for (const [cookie, now] of [[`elo_session=${guest.token}`, GUEST_NOW], [guest.cookie, GUEST_NOW + 31 * 60_000]] as const) {
    const renewed = await proxyApi(guestRequest("session", {}, cookie), ["guest", "session"], { ...config, now: () => now, fetcher: missing });
    assert.equal(renewed.status, 200); assert.deepEqual(await renewed.json(), { ok: true });
    assert.match(renewed.headers.getSetCookie()[0]!, /^elo_session=[0-9a-f]{64};/);
    assert.equal(renewed.headers.getSetCookie()[0]!.includes(guest.token), false);
  }
});

test("guest endpoints reject cross-origin, malformed and extra payloads without issuing credentials", async () => {
  const guest = await pendingGuest();
  let calls = 0;
  const c = { ...config, now: () => GUEST_NOW, fetcher: (async () => { calls++; throw new Error("Unexpected call"); }) as typeof fetch };
  const wrongOrigin = guestRequest("session", {}); wrongOrigin.headers.set("origin", "https://evil.test");
  assert.equal((await proxyApi(wrongOrigin, ["guest", "session"], c)).status, 403);
  const media = guestRequest("session", {}); media.headers.set("content-type", "text/plain");
  assert.equal((await proxyApi(media, ["guest", "session"], c)).status, 415);
  assert.equal((await proxyApi(guestRequest("player", { username: "guest" }), ["guest", "player"], c)).status, 401);
  assert.equal((await proxyApi(request("guest/session"), ["guest", "session"], c)).status, 404);
  const sources = [
    ["session", '{"private":"canary"}'], ["session", "null"], ["session", "[]"], ["session", "{"],
    ["player", '{}'], ["player", '{"username":23}'], ["player", '{"username":"guest","token":"canary"}'],
    ["player", '{"username":"guest","username":"other"}'], ["player", '{"username":"guest","__proto__":{"private":"canary"}}'],
  ] as const;
  for (const [path, body] of sources) {
    const req = new Request(`https://elo.test/api/guest/${path}`, { method: "POST", headers: {
      origin: "https://elo.test", "content-type": "application/json", cookie: guest.cookie,
    }, body });
    const response = await proxyApi(req, ["guest", path], c);
    assert.equal(response.status, 400); assert.equal(response.headers.get("set-cookie"), null);
    assert.equal((await response.text()).includes("canary"), false);
  }
  assert.equal(calls, 0);
});

test("pending marker cannot authorize a different cookie, altered signature or expired credential", async () => {
  const guest = await pendingGuest();
  const changedSignature = guest.cookie.slice(0, -1) + (guest.cookie.endsWith("0") ? "1" : "0");
  for (const [cookie, now] of [[guest.cookie.replace(guest.token, token), GUEST_NOW], [changedSignature, GUEST_NOW], [guest.cookie, GUEST_NOW + 31 * 60_000]] as const) {
    let calls = 0;
    const response = await proxyApi(guestRequest("player", { username: "chosen_name" }, cookie), ["guest", "player"], {
      ...config, now: () => now, fetcher: (async (url, init) => {
        calls++; assert.equal(String(url), "https://api.test/v1/me"); assert.equal(init?.method, "GET");
        return Response.json({ error: "Invalid account token." }, { status: 401 });
      }) as typeof fetch,
    });
    assert.equal(calls, 1); assert.equal(response.status, 401); assert.equal(response.headers.get("set-cookie"), null);
  }
});

test("guest claim uses the issued cookie and returns only Me while clearing only the pending marker", async () => {
  const guest = await pendingGuest(), me = { player: { id: "p_guest", username: "chosen_name" }, matches: [], queue: [] };
  let calls = 0;
  const response = await proxyApi(guestRequest("player", { username: "chosen_name" }, guest.cookie), ["guest", "player"], {
    ...config, now: () => GUEST_NOW, fetcher: (async (url, init) => {
      calls++; assert.equal(String(url), "https://api.test/v1/players"); assert.equal(init?.method, "POST");
      assert.equal(new Headers(init?.headers).get("authorization"), null);
      assert.equal(new Headers(init?.headers).get("x-service-key"), serviceKey);
      assert.deepEqual(JSON.parse(init?.body as string), { username: "chosen_name", token: guest.token });
      return Response.json({ ...me, token: guest.token, recoveryKey: "must-not-be-returned" }, { status: 201 });
    }) as typeof fetch,
  });
  assert.equal(calls, 1); assert.equal(response.status, 201); assert.deepEqual(await response.json(), me);
  assert.equal(response.headers.getSetCookie().length, 1);
  assert.match(response.headers.getSetCookie()[0]!, /^elo_pending=;.*Max-Age=0/);
  assert.equal(response.headers.get("set-cookie")!.includes("elo_session="), false);
});

test("a lost guest claim response can recover the allocated key and retry the same player", async () => {
  const guest = await pendingGuest(), me = { player: { id: "p_same_guest", username: "same_name" }, queue: [], matches: [] };
  let posts = 0, reads = 0;
  const c = { ...config, now: () => GUEST_NOW, fetcher: (async (url, init) => {
    if (String(url).endsWith("/me")) {
      reads++; assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${guest.token}`);
      return Response.json(me);
    }
    posts++; assert.equal(String(url), "https://api.test/v1/players");
    assert.deepEqual(JSON.parse(init?.body as string), { username: "same_name", token: guest.token });
    if (posts === 1) throw new Error("Response lost after allocation");
    return Response.json({ ...me, token: guest.token }, { status: 201 });
  }) as typeof fetch };
  const lost = await proxyApi(guestRequest("player", { username: "same_name" }, guest.cookie), ["guest", "player"], c);
  assert.equal(lost.status, 502); assert.equal(lost.headers.get("set-cookie"), null);
  const boot = await proxyApi(guestRequest("session", {}, guest.cookie), ["guest", "session"], c);
  assert.equal(boot.status, 200); assert.equal(boot.headers.get("set-cookie"), null);
  const retry = await proxyApi(guestRequest("player", { username: "same_name" }, guest.cookie), ["guest", "player"], c);
  assert.equal(retry.status, 201); assert.deepEqual(await retry.json(), me);
  const established = await proxyApi(guestRequest("player", { username: "same_name" }, `elo_session=${guest.token}`), ["guest", "player"], c);
  assert.equal(established.status, 201); assert.deepEqual(await established.json(), me);
  assert.equal(posts, 3); assert.equal(reads, 2);
});

test("guest name collisions preserve credentials and do not expose upstream key fields", async () => {
  const guest = await pendingGuest();
  for (const cookie of [guest.cookie, `elo_session=${guest.token}`]) {
    let calls = 0;
    const response = await proxyApi(guestRequest("player", { username: "taken_name" }, cookie), ["guest", "player"], {
      ...config, now: () => GUEST_NOW, fetcher: (async (url, init) => {
        calls++;
        if (String(url).endsWith("/me")) return Response.json({ player: { id: "p_existing", username: "original_name" } });
        assert.deepEqual(JSON.parse(init?.body as string), { username: "taken_name", token: guest.token });
        return Response.json({ error: "That username is already taken.", token: guest.token, recoveryKey: guest.token }, { status: 409 });
      }) as typeof fetch,
    });
    assert.equal(calls, cookie === guest.cookie ? 1 : 2); assert.equal(response.status, 409);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.deepEqual(await response.json(), { error: "That username is already taken." });
  }
});

test("guest account checks fail closed on outages and timeouts without changing cookies", async () => {
  for (const endpoint of ["session", "player"] as const) for (const kind of ["status", "timeout"] as const) {
    let calls = 0;
    const response = await proxyApi(guestRequest(endpoint, endpoint === "session" ? {} : { username: "guest" }, `elo_session=${token}`), ["guest", endpoint], {
      ...config, fetcher: (async (url, init) => {
        calls++; assert.equal(String(url), "https://api.test/v1/me"); assert(init?.signal instanceof AbortSignal);
        assert.equal(init?.redirect, "error"); assert.equal(init?.cache, "no-store");
        if (kind === "timeout") throw new DOMException("private-timeout-detail", "TimeoutError");
        return Response.json({ error: "private-upstream-detail" }, { status: 503 });
      }) as typeof fetch,
    });
    assert.equal(calls, 1); assert.equal(response.status, kind === "status" ? 503 : 502);
    assert.equal(response.headers.get("set-cookie"), null); assert.equal((await response.text()).includes("private-"), false);
  }
});

test("logout, legacy recovery and rotation clear pending markers with separate cookie headers", async () => {
  const logout = await proxyApi(request("session", "DELETE"), ["session"], {});
  assert.equal(logout.headers.getSetCookie().length, 2);
  assert.match(logout.headers.getSetCookie()[0]!, /^elo_session=;.*Max-Age=0/);
  assert.match(logout.headers.getSetCookie()[1]!, /^elo_pending=;.*Max-Age=0/);
  for (const path of ["session", "session/rotate"]) {
    const req = request(path, "POST", path === "session" ? { token } : { replacementToken: token });
    req.headers.set("cookie", `elo_session=${token}`);
    const response = await proxyApi(req, path.split("/"), { ...config, fetcher: (async () => Response.json({ token, player: {} })) as typeof fetch });
    assert.equal(response.headers.getSetCookie().length, 2);
    assert.match(response.headers.getSetCookie()[0]!, /^elo_session=[0-9a-f]{64};.*Max-Age=31536000/);
    assert.match(response.headers.getSetCookie()[1]!, /^elo_pending=;.*Max-Age=0/);
  }
});
