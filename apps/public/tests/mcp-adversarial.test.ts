import assert from "node:assert/strict";
import test from "node:test";
import { createReferenceMcp } from "../lib/mcp.ts";

const config = { allowedHosts: ["reference.test"], allowedOrigins: ["https://reference.test"], now: () => new Date("2026-09-14T12:00:00Z"), requestsPerMinute: 1000 };
const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_scoring_guide", arguments: {} } };
function request(source: string, headers: Record<string, string> = {}) {
  return new Request("https://reference.test/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: source });
}

test("raw MCP duplicate keys at every depth are rejected before normalization, including escaped names", async () => {
  const reference = createReferenceMcp(config);
  try {
    for (const source of [
      '{"jsonrpc":"2.0","id":1,"method":"PRIVATE_CANARY","method":"tools/list"}',
      '{"jsonrpc":"2.0","id":1,"method":"tools/list","\\u006dethod":"tools/list"}',
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"PRIVATE_CANARY","name":"get_scoring_guide"}}',
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_scoring_guide","arguments":{"history":"PRIVATE_CANARY"},"arguments":{}}}',
      '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"secret":"PRIVATE_CANARY","secret":null}}}',
      '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"__proto__":{},"\\u005f_proto__":{}}}}',
    ]) {
      const response = await reference.fetch(request(source));
      assert.equal(response.status, 400);
      assert.doesNotMatch(await response.text(), /PRIVATE_CANARY|history|secret|__proto__/);
    }
    const ordinary = await reference.fetch(request(JSON.stringify({ ...call, params: { ...call.params, _meta: {
      first: { repeated: 1.25 }, second: { repeated: 2.5 },
      text: 'PRIVATE_CANARY {} [] :, "escaped quote" and \\backslash', unicode: "合法的なメタデータ", exponent: 1e30,
    } } })));
    assert.equal(ordinary.status, 200);
    const output = await ordinary.text();
    assert.match(output, /computer-elo.assessment-guide/);
    assert.doesNotMatch(output, /PRIVATE_CANARY|メタデータ|exponent|repeated/);
  } finally { await reference.close(); }
});

test("MCP rejects excessive nesting and prototype-shaped tool arguments without reflecting them", async () => {
  const reference = createReferenceMcp(config);
  try {
    let nested: unknown = "PRIVATE_CANARY";
    for (let level = 0; level < 70; level++) nested = { next: nested };
    const bodies = [
      { ...call, params: { ...call.params, _meta: nested } },
      JSON.parse('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_scoring_guide","arguments":{"__proto__":{"history":"PRIVATE_CANARY"}}}}'),
      { ...call, params: { ...call.params, arguments: { constructor: { prototype: { history: "PRIVATE_CANARY" } } } } },
      { ...call, params: { ...call.params, history: "PRIVATE_CANARY" } },
      { ...call, method: "resources/read", params: { uri: "file:///PRIVATE_CANARY" } },
      { ...call, method: "tools/call", params: { name: "publish_score", arguments: {} } },
    ];
    for (const body of bodies) {
      const response = await reference.fetch(request(JSON.stringify(body)));
      assert.equal(response.status, 400);
      assert.doesNotMatch(await response.text(), /PRIVATE_CANARY|file:|publish_score|constructor/);
    }
    assert.equal(Object.hasOwn(Object.prototype, "history"), false);
  } finally { await reference.close(); }
});

test("MCP byte limit includes streamed chunks and abort releases the request reader", async () => {
  const reference = createReferenceMcp({ ...config, bodyTimeoutMs: 1000 });
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  try {
    const source = JSON.stringify(list);
    const boundary = await reference.fetch(request(source + " ".repeat(16384 - Buffer.byteLength(source))));
    assert.equal(boundary.status, 200); await boundary.text();
    assert.equal((await reference.fetch(request(source + " ".repeat(16385 - Buffer.byteLength(source))))).status, 413);

    let oversizedCancelled = false;
    const oversized = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(" ".repeat(8192)));
      controller.enqueue(new TextEncoder().encode(" ".repeat(8193)));
    }, cancel() { oversizedCancelled = true; } });
    const tooLarge = await reference.fetch(new Request("https://reference.test/mcp", { method: "POST", headers, body: oversized, duplex: "half" } as RequestInit));
    assert.equal(tooLarge.status, 413); assert.equal(oversizedCancelled, true); assert.equal(oversized.locked, false);

    let abortedCancelled = false;
    const partial = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"jsonrpc":')); }, cancel() { abortedCancelled = true; } });
    const controller = new AbortController();
    const pending = reference.fetch(new Request("https://reference.test/mcp", { method: "POST", headers, body: partial, signal: controller.signal, duplex: "half" } as RequestInit));
    await new Promise(resolve => setImmediate(resolve)); controller.abort();
    assert.equal((await pending).status, 408); assert.equal(abortedCancelled, true); assert.equal(partial.locked, false);
  } finally { await reference.close(); }
});

test("MCP bounded client buckets expire without allowing extra identities to exceed the cap", async () => {
  let now = new Date("2026-09-14T12:00:00Z");
  const reference = createReferenceMcp({ ...config, now: () => now, trustVercelProxy: true, maxClientEntries: 3, requestsPerMinute: 2 });
  const send = async (address: string) => {
    const response = await reference.fetch(request(JSON.stringify(list), { "x-vercel-forwarded-for": address }));
    await response.text(); return response;
  };
  try {
    for (const address of ["192.0.2.1", "192.0.2.2", "192.0.2.3"]) {
      assert.equal((await send(address)).status, 200);
      assert.equal((await send(address)).status, 200);
      assert.equal((await send(address)).status, 429);
    }
    for (let index = 4; index < 100; index++) assert.equal((await send(`192.0.2.${index}`)).status, 429);
    now = new Date(now.getTime() + 60001);
    assert.equal((await send("192.0.2.99")).status, 200);
    assert.equal((await send("192.0.2.1")).status, 200);
  } finally { await reference.close(); }
});
