import test from "node:test";
import assert from "node:assert/strict";
import { proxyApi, type ProxyConfig } from "../lib/proxy.ts";

const token = "a".repeat(64);
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

test("revoked me expires cookie but failed recovery does not clear a valid session", async () => {
  const c = { ...config, fetcher: (async () => Response.json({ error: "Invalid session" }, { status: 401 })) as typeof fetch };
  const req = request("me"); req.headers.set("cookie", `elo_session=${token}`);
  assert.match((await proxyApi(req, ["me"], c)).headers.get("set-cookie")!, /Max-Age=0/);
  const recover = request("session", "POST", { token: "b".repeat(64) }); recover.headers.set("cookie", `elo_session=${token}`);
  assert.equal((await proxyApi(recover, ["session"], c)).headers.get("set-cookie"), null);
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
