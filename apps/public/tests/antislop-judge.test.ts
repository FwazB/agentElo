import assert from "node:assert/strict";
import test from "node:test";

import type { WorkEntry } from "../../../packages/referee/entries.ts";
import { GatewayError } from "../../../packages/referee/gateway.ts";
import { adjudicatePair, buildJudgePacket, type JudgeResponse } from "../../../packages/referee/judge.ts";
import { LIVE_JUDGE_CONFIG } from "../../../packages/referee/live-config.ts";
import { judgeDuel } from "../lib/antislop-judge.ts";
import { proxyApi } from "../lib/proxy.ts";

const duelId = `ad_${"1".repeat(32)}`;
const session = "a".repeat(64);
const leaseToken = "b".repeat(64);
const serviceKey = "s".repeat(64);
const baseConfig = { apiUrl: "https://api.test/base", serviceKey, gatewayToken: "private-gateway-token", production: true };
type RouteConfig = Parameters<typeof judgeDuel>[2];

function entry(id: string): WorkEntry {
  return {
    version: "antislop.entry.v1", entryId: `entry-${id}`, participantId: `person-${id}`,
    window: { startsAt: "2026-09-08T00:00:00.000Z", endsAt: "2026-09-15T00:00:00.000Z" },
    summary: "Fixed a form and checked keyboard submission.",
    accomplishments: [{ id: "a1", outcome: "Keyboard form submission succeeds.", evidenceIds: ["e1"] }],
    evidence: [{ id: "e1", kind: "check", excerpt: "Keyboard submission passed the local check.", occurredAt: "2026-09-14" }],
    refereeConsent: { approved: true, approvedAt: "2026-09-15T00:00:00.000Z" }, publicSummary: null,
  };
}

const a = entry("a"), b = entry("b");
const packets = () => ({ ab: buildJudgePacket(a, b, LIVE_JUDGE_CONFIG, "ab"), ba: buildJudgePacket(a, b, LIVE_JUDGE_CONFIG, "ba") });
const verdict = { outcome: "draw", reason: "comparable_work", explanation: "Both entries demonstrate the stated repair.", evidenceRefs: { a: ["e1"], b: ["e1"] } };
const completion = (value: unknown = verdict) => ({ model: LIVE_JUDGE_CONFIG.modelSnapshot, choices: [{ finish_reason: "stop", message: { content: JSON.stringify(value) } }] });
const settledPayload = { duelId, state: "complete", outcome: "draw", ratingEligible: false };
const failedPayload = { duelId, state: "failed", outcome: "unrated", ratingEligible: false };

function browserRequest(body = "{}"): Request {
  return new Request(`https://elo.test/api/antislop/duels/${duelId}/judge`, {
    method: "POST", body,
    headers: { origin: "https://elo.test", "content-type": "application/json", cookie: `unrelated=1; elo_session=${session}`, "sec-fetch-site": "same-origin", "x-vercel-forwarded-for": "203.0.113.9" },
  });
}

function harness(options: {
  gatewayResponse?: (call: number) => Response | Promise<Response>;
  claimResponse?: () => Response;
  settlementFailure?: "reject" | "lost";
  failUnavailable?: boolean;
} = {}) {
  const events: string[] = [];
  const backendBodies: Array<{ operation: string; body: Record<string, unknown> }> = [];
  let claimed = false, gatewayCalls = 0;
  const config: RouteConfig = {
    ...baseConfig,
    fetcher: (async (url, init) => {
      const endpoint = new URL(String(url));
      assert.equal(endpoint.origin, "https://api.test");
      assert.equal(endpoint.search, "");
      assert.match(endpoint.pathname, new RegExp(`^/v1/antislop/internal/duels/${duelId}/(?:claim|settle|fail)$`));
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.equal(init?.cache, "no-store");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-service-key"), serviceKey);
      assert.equal(headers.get("authorization"), `Bearer ${session}`);
      assert.match(headers.get("x-client-id")!, /^[0-9a-f]{64}$/);
      assert.equal(headers.get("cookie"), null);
      const operation = endpoint.pathname.split("/").at(-1)!;
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      events.push(operation);
      backendBodies.push({ operation, body });
      if (operation === "claim") {
        assert.deepEqual(body, {});
        if (options.claimResponse) return options.claimResponse();
        if (claimed) return Response.json({ error: "This duel has already been claimed or finished." }, { status: 409 });
        claimed = true;
        return Response.json({ leaseToken, packets: packets() });
      }
      assert.equal(body.leaseToken, leaseToken);
      if (operation === "settle") {
        assert.deepEqual(Object.keys(body).sort(), ["leaseToken", "responseAB", "responseBA"]);
        try { adjudicatePair(a, b, LIVE_JUDGE_CONFIG, body.responseAB, body.responseBA); }
        catch { return Response.json({ error: "Invalid referee evidence references or response." }, { status: 400 }); }
        if (options.settlementFailure === "reject") return Response.json({ error: "Settlement unavailable." }, { status: 503 });
        if (options.settlementFailure === "lost") throw new Error("Response lost after possible commit.");
        return Response.json(settledPayload);
      }
      assert.equal(operation, "fail");
      assert.deepEqual(Object.keys(body).sort(), ["leaseToken", "reason"]);
      if (options.failUnavailable) throw new Error("Backend unavailable.");
      return Response.json(failedPayload);
    }) as typeof fetch,
    gatewayFetcher: (async (url, init) => {
      assert.equal(String(url), "https://ai-gateway.vercel.sh/v1/chat/completions");
      assert.ok(events.includes("claim"));
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer private-gateway-token");
      gatewayCalls++;
      events.push("gateway");
      return options.gatewayResponse ? options.gatewayResponse(gatewayCalls) : Response.json(completion());
    }) as typeof fetch,
  };
  return { config, events, backendBodies, gatewayCalls: () => gatewayCalls };
}

test("judge route claims first, ignores browser packets and settles both bound orders once", async () => {
  const state = harness();
  const request = browserRequest(JSON.stringify({ packet: { model: "attacker/model" }, responseAB: { outcome: "a_wins" }, authorization: "attacker-token" }));
  request.headers.set("authorization", "Bearer caller-header-must-not-win");
  const result = await judgeDuel(request, duelId, state.config);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.equal(result.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await result.json(), settledPayload);
  assert.deepEqual(state.events, ["claim", "gateway", "gateway", "settle"]);
  assert.equal(state.gatewayCalls(), 2);
  const settle = state.backendBodies[1]!.body;
  const ab = settle.responseAB as JudgeResponse, ba = settle.responseBA as JudgeResponse;
  assert.equal(ab.order, "ab");
  assert.equal(ba.order, "ba");
  assert.equal(ab.pairFingerprint, ba.pairFingerprint);
  assert.equal(ab.judgeFingerprint, ba.judgeFingerprint);
  assert.equal(JSON.stringify(state.backendBodies).includes("attacker/model"), false);
  assert.equal(JSON.stringify(state.backendBodies).includes("private-gateway-token"), false);
});

test("same-origin cookie authentication and deployment checks prevent any upstream calls", async () => {
  const cases: Array<{ status: number; alter?: (request: Request) => void; id?: string; config?: RouteConfig; request?: () => Request }> = [
    { status: 404, request: () => new Request(`https://elo.test/api/antislop/duels/${duelId}/judge`) },
    { status: 404, id: `${duelId}\n` },
    { status: 404, id: "../other" },
    { status: 403, alter: request => { request.headers.delete("origin"); } },
    { status: 403, alter: request => { request.headers.set("origin", "https://evil.test"); } },
    { status: 403, alter: request => { request.headers.set("sec-fetch-site", "cross-site"); } },
    { status: 403, request: () => new Request(`https://elo.test/api/antislop/duels/${duelId}/judge?model=override`, { method: "POST", headers: browserRequest().headers, body: "{}" }) },
    { status: 415, alter: request => { request.headers.set("content-type", "text/plain"); } },
    { status: 401, alter: request => { request.headers.delete("cookie"); request.headers.set("authorization", `Bearer ${session}`); } },
    { status: 401, alter: request => { request.headers.set("cookie", "elo_session=not-valid"); } },
    { status: 503, config: {} },
    { status: 503, config: { ...baseConfig, serviceKey: "short" } },
    { status: 503, config: { ...baseConfig, apiUrl: "http://api.test" } },
    { status: 503, config: { ...baseConfig, apiUrl: "https://name:password@api.test" } },
    { status: 503, config: { ...baseConfig, apiUrl: "file:///private/data" } },
  ];
  for (const scenario of cases) {
    const state = harness();
    const request = scenario.request?.() ?? browserRequest();
    scenario.alter?.(request);
    const config = scenario.config === undefined ? state.config : { ...scenario.config, fetcher: state.config.fetcher!, gatewayFetcher: state.config.gatewayFetcher! };
    assert.equal((await judgeDuel(request, scenario.id ?? duelId, config)).status, scenario.status);
    assert.deepEqual(state.events, []);
  }
});

test("internal claim, settle and failure endpoints are never exposed by the general proxy", async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; return Response.json({}); }) as typeof fetch;
  for (const operation of ["claim", "settle", "fail"]) {
    const path = ["antislop", "internal", "duels", duelId, operation];
    assert.equal((await proxyApi(browserRequest(), path, { apiUrl: "https://api.test", serviceKey, production: true, fetcher })).status, 404);
  }
  assert.equal(calls, 0);
});

test("backend rejects duplicate judging requests before another provider call", async () => {
  const state = harness();
  assert.equal((await judgeDuel(browserRequest(), duelId, state.config)).status, 200);
  const duplicate = await judgeDuel(browserRequest(), duelId, state.config);
  assert.equal(duplicate.status, 409);
  assert.equal(state.gatewayCalls(), 2);
  assert.deepEqual(state.events, ["claim", "gateway", "gateway", "settle", "claim"]);
});

test("upstream malformed output, refusal, oversize and model mismatch settle as failure without rerolls", async () => {
  const responses: Array<() => Response> = [
    () => new Response("not JSON"),
    () => Response.json({ ...completion(), model: "attacker/model" }),
    () => Response.json({ ...completion(), choices: [{ finish_reason: "stop", message: { content: JSON.stringify(verdict), refusal: "Refused." } }] }),
    () => Response.json({ ...completion(), extra: "x".repeat(33_000) }),
    () => Response.json(completion({ outcome: "draw", outcome2: "a_wins" })),
  ];
  for (const response of responses) {
    const state = harness({ gatewayResponse: () => response() });
    assert.deepEqual(await (await judgeDuel(browserRequest(), duelId, state.config)).json(), failedPayload);
    assert.equal(state.gatewayCalls(), 2);
    assert.equal(state.events.filter(event => event === "fail").length, 1);
    // A syntactically valid but invalid verdict reaches the independent API
    // validator; transport and envelope failures stop before settlement.
    assert.ok(state.events.filter(event => event === "settle").length <= 1);
    assert.equal(state.backendBodies.at(-1)!.body.reason, "referee_failed");
    assert.equal((await judgeDuel(browserRequest(), duelId, state.config)).status, 409);
    assert.equal(state.gatewayCalls(), 2);
  }
});

test("gateway timeouts are recorded with the timeout reason and never retried", async () => {
  const state = harness({ gatewayResponse: () => { throw new GatewayError("referee_timed_out"); } });
  assert.deepEqual(await (await judgeDuel(browserRequest(), duelId, state.config)).json(), failedPayload);
  assert.deepEqual(state.events, ["claim", "gateway", "gateway", "fail"]);
  assert.equal(state.backendBodies.at(-1)!.body.reason, "referee_timed_out");
});

test("invented evidence references fail independent settlement and close the attempt", async () => {
  const state = harness({ gatewayResponse: () => Response.json(completion({ ...verdict, evidenceRefs: { a: ["e99"], b: ["e1"] } })) });
  const result = await judgeDuel(browserRequest(), duelId, state.config);
  assert.deepEqual(await result.json(), failedPayload);
  assert.deepEqual(state.events, ["claim", "gateway", "gateway", "settle", "fail"]);
  assert.equal(state.gatewayCalls(), 2);
  assert.equal((await judgeDuel(browserRequest(), duelId, state.config)).status, 409);
  assert.equal(state.gatewayCalls(), 2);
});

test("settlement rejection records one failure without repeating provider calls", async () => {
  const state = harness({ settlementFailure: "reject" });
  assert.deepEqual(await (await judgeDuel(browserRequest(), duelId, state.config)).json(), failedPayload);
  assert.deepEqual(state.events, ["claim", "gateway", "gateway", "settle", "fail"]);
  assert.equal(state.gatewayCalls(), 2);
});

test("lost settlement responses do not claim unchanged results or trigger a reroll", async () => {
  const state = harness({ settlementFailure: "lost", failUnavailable: true });
  const result = await judgeDuel(browserRequest(), duelId, state.config);
  assert.equal(result.status, 502);
  const body = await result.json() as { error: string };
  assert.match(body.error, /refresh/i);
  assert.doesNotMatch(body.error, /no rating changed|unchanged/i);
  assert.deepEqual(state.events, ["claim", "gateway", "gateway", "settle", "fail"]);
  assert.equal(state.gatewayCalls(), 2);
  assert.equal((await judgeDuel(browserRequest(), duelId, state.config)).status, 409);
  assert.equal(state.gatewayCalls(), 2);
});

test("bad claim payloads fail safely without spending provider calls", async () => {
  const wrongPair = packets();
  wrongPair.ba.pairFingerprint = `sha256:${"0".repeat(64)}`;
  const malformedClaims: unknown[] = [null, {}, { leaseToken, packets: {} }, { leaseToken, packets: wrongPair }];
  for (const claim of malformedClaims) {
    const state = harness({ claimResponse: () => Response.json(claim) });
    const result = await judgeDuel(browserRequest(), duelId, state.config);
    assert.ok(result.status === 200 || result.status === 502);
    assert.equal(state.gatewayCalls(), 0);
    assert.equal(state.events.includes("settle"), false);
    if (state.events.includes("fail")) assert.equal(state.backendBodies.at(-1)!.body.reason, "referee_failed");
  }
});
