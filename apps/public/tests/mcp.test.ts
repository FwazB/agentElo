import test from "node:test";
import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createReferenceMcp, type ReferenceMcpConfig } from "../lib/mcp.ts";
import { getScoringGuide } from "../../../packages/public-api/scoring-guide.ts";

const date = new Date("2026-09-14T12:00:00Z");
const config: ReferenceMcpConfig = { allowedHosts: ["elo.test"], allowedOrigins: ["https://elo.test"], now: () => date };
const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
function request(body: unknown = list, headers: Record<string, string> = {}): Request {
  return new Request("https://elo.test/mcp", {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
}

for (const mode of ["auto", "legacy"] as const) {
  test(`official SDK client discovers and calls only two reference tools (${mode})`, async () => {
    const reference = createReferenceMcp(config);
    const client = new Client({ name: "reference-test", version: "1.0.0" }, { versionNegotiation: { mode } });
    const transport = new StreamableHTTPClientTransport(new URL("https://elo.test/mcp"), {
      fetch: (url, init) => reference.fetch(new Request(url, init)),
    });
    try {
      await client.connect(transport);
      assert.equal(client.getProtocolEra(), mode === "auto" ? "modern" : "legacy");
      assert.equal(client.getServerCapabilities()?.tools?.listChanged, false);
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ["get_assessment_prompt", "get_scoring_guide"]);
      for (const tool of tools.tools) {
        assert.equal(tool.annotations?.readOnlyHint, true);
        assert.equal(tool.annotations?.openWorldHint, false);
        assert.equal(tool.inputSchema.additionalProperties, false);
        assert.deepEqual(tool.inputSchema.properties, {});
      }
      const result = await client.callTool({ name: "get_scoring_guide", arguments: {} });
      assert.deepEqual(result.structuredContent, getScoringGuide(date));
      const prompt = await client.callTool({ name: "get_assessment_prompt", arguments: {} });
      assert.equal(prompt.structuredContent?.weekId, "2026-W37");
      assert.equal(prompt.structuredContent?.prompt, getScoringGuide(date).prompt);
      assert.match(JSON.stringify(prompt), /insufficient_evidence/);
    } finally { await client.close(); await reference.close(); }
  });
}

test("legacy initialize has no session or cookie, and standalone streams are unsupported", async () => {
  const reference = createReferenceMcp(config);
  try {
    const response = await reference.fetch(request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy-test", version: "1.0.0" },
    } }));
    assert.equal(response.status, 200);
    assert.match(await response.text(), /2025-11-25/);
    assert.equal(response.headers.get("mcp-session-id"), null);
    assert.equal(response.headers.get("set-cookie"), null);
    for (const method of ["GET", "DELETE", "PUT", "PATCH", "OPTIONS"]) {
      const rejected = await reference.fetch(new Request("https://elo.test/mcp", { method }));
      assert.equal(rejected.status, 405);
      assert.equal(rejected.headers.get("allow"), "POST");
    }
  } finally { await reference.close(); }
});

test("missing Origin works for remote clients, but unexpected origins and hosts are forbidden", async () => {
  const reference = createReferenceMcp(config);
  try {
    for (const headers of [{}, { origin: "https://elo.test" }]) {
      const response = await reference.fetch(request(list, headers));
      assert.equal(response.status, 200); await response.text();
    }
    for (const headers of [{ origin: "https://evil.test" }, { origin: "null" }, { origin: "" }, { origin: "http://elo.test" }, { origin: "https://elo.test:444" }, { host: "evil.test" }, { host: "elo.test@evil.test" }]) {
      const response = await reference.fetch(request(list, headers));
      assert.equal(response.status, 403);
      assert.doesNotMatch(await response.text(), /evil/);
    }
    assert.equal((await reference.fetch(new Request("https://evil.test/mcp", { method: "POST", headers: { host: "elo.test" } }))).status, 403);
    assert.equal((await reference.fetch(new Request("https://elo.test/mcp?anything=1"))).status, 404);
  } finally { await reference.close(); }
});

test("batches, unknown methods, private fields and all tool arguments get fixed errors", async () => {
  const reference = createReferenceMcp(config);
  try {
    const secret = "PRIVATE_HISTORY_DO_NOT_REFLECT";
    for (const body of [
      [list], { ...list, history: secret }, { ...list, method: secret },
      { ...list, method: "subscriptions/listen", params: {} },
      { ...list, params: { history: secret } },
      { ...list, method: "tools/call", params: { name: secret, arguments: {} } },
      { ...list, method: "tools/call", params: { name: "get_scoring_guide", arguments: { history: secret } } },
      { ...list, method: "tools/call", params: { name: "get_assessment_prompt", arguments: { recoveryKey: secret } } },
      { ...list, method: "tools/call", params: { name: "get_assessment_prompt", arguments: [], history: secret } },
    ]) {
      const response = await reference.fetch(request(body));
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid MCP request." } });
    }
  } finally { await reference.close(); }
});

test("invalid protocol versions and mismatched headers never reflect submitted metadata", async () => {
  const reference = createReferenceMcp(config);
  try {
    for (const [body, headers] of [
      [{ ...list, params: { _meta: { "io.modelcontextprotocol/protocolVersion": "PRIVATE_VALUE" } } }, { "mcp-protocol-version": "PRIVATE_VALUE", "mcp-method": "tools/list" }],
      [{ ...list, params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } }, { "mcp-protocol-version": "2025-11-25", "mcp-method": "tools/list" }],
      [{ ...list, params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } }, { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call" }],
      [{ ...list, method: "tools/call", params: { name: "get_scoring_guide", arguments: {}, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } }, { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "PRIVATE_VALUE" }],
    ] as const) {
      const response = await reference.fetch(request(body, headers));
      assert.equal(response.status, 400);
      assert.doesNotMatch(await response.text(), /PRIVATE_VALUE/);
    }
  } finally { await reference.close(); }
});

test("HTTP 200 legacy RPC errors are fixed messages too", async () => {
  const reference = createReferenceMcp(config);
  try {
    const response = await reference.fetch(request({ ...list, method: "initialize", params: {
      protocolVersion: "2025-11-25", capabilities: "PRIVATE_VALUE", clientInfo: { name: "test", version: "1" },
    } }));
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /Invalid MCP request/);
    assert.match(text, /"id":1/);
    assert.doesNotMatch(text, /PRIVATE_VALUE|capabilities|invalid_type/);
  } finally { await reference.close(); }
});

test("JSON bodies are limited by bytes, media type, completion time and UTF-8 validity", async () => {
  const reference = createReferenceMcp({ ...config, bodyTimeoutMs: 10 });
  try {
    assert.equal((await reference.fetch(request(list, { "content-type": "text/plain" }))).status, 415);
    assert.equal((await reference.fetch(request(list, { "content-length": "16385" }))).status, 413);
    assert.equal((await reference.fetch(request({ data: "x".repeat(17_000) }))).status, 413);
    let cancelled = false;
    const slow = new ReadableStream({ cancel() { cancelled = true; } });
    const pending = new Request("https://elo.test/mcp", {
      method: "POST", headers: { "content-type": "application/json" }, body: slow, duplex: "half",
    } as RequestInit);
    assert.equal((await reference.fetch(pending)).status, 408); assert.equal(cancelled, true);
    for (const body of ["{", new Uint8Array([0xff])]) {
      assert.equal((await reference.fetch(new Request("https://elo.test/mcp", { method: "POST", headers: { "content-type": "application/json" }, body }))).status, 400);
    }
    const aborted = new Request("https://elo.test/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.abort() });
    assert.equal((await reference.fetch(aborted)).status, 408);
  } finally { await reference.close(); }
});

test("rate counters are bounded per instance, expire, and ignore untrusted client headers", async () => {
  let now = new Date(date);
  const reference = createReferenceMcp({ ...config, now: () => now, requestsPerMinute: 1, maxClientEntries: 1 });
  try {
    const first = await reference.fetch(request(list, { "x-client-id": "one", "x-vercel-forwarded-for": "1.2.3.4" }));
    assert.equal(first.status, 200); await first.text();
    const rejected = await reference.fetch(request(list, { "x-client-id": "two", "x-vercel-forwarded-for": "5.6.7.8" }));
    assert.equal(rejected.status, 429); assert.equal(rejected.headers.get("retry-after"), "60");
    now = new Date(date.getTime() + 60_001);
    const reset = await reference.fetch(request()); assert.equal(reset.status, 200); await reset.text();
  } finally { await reference.close(); }
  const bounded = createReferenceMcp({ ...config, trustVercelProxy: true, maxClientEntries: 1 });
  try {
    const first = await bounded.fetch(request(list, { "x-vercel-forwarded-for": "1.2.3.4" }));
    assert.equal(first.status, 200); await first.text();
    assert.equal((await bounded.fetch(request(list, { "x-vercel-forwarded-for": "5.6.7.8" }))).status, 429);
  } finally { await bounded.close(); }
});

test("account credentials have no effect and responses carry privacy headers", async () => {
  const reference = createReferenceMcp(config);
  try {
    const response = await reference.fetch(request({ ...list, method: "tools/call", params: { name: "get_assessment_prompt", arguments: {} } }, {
      authorization: "Bearer PRIVATE_TOKEN", cookie: "elo_session=PRIVATE_TOKEN", "x-service-key": "PRIVATE_SERVICE_KEY",
    }));
    assert.equal(response.status, 200);
    assert.doesNotMatch(await response.text(), /PRIVATE_TOKEN|PRIVATE_SERVICE_KEY/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  } finally { await reference.close(); }
});
