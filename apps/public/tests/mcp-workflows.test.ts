import test from "node:test";
import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createReferenceMcp } from "../lib/mcp.ts";
import { getEntryGuide } from "../../../packages/public-api/entry-guide.ts";
import { getScoringGuide } from "../../../packages/public-api/scoring-guide.ts";

const origin = "https://workflow.test";
const date = new Date("2026-09-15T12:30:00.000Z");
const config = { allowedHosts: ["workflow.test"], allowedOrigins: [origin], now: () => date };

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${origin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
}

async function rpc(response: Response) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const source = await response.text();
  const data = response.headers.get("content-type")?.includes("text/event-stream")
    ? source.split("\n").find(line => line.startsWith("data:"))?.slice(5).trim()
    : source;
  assert.ok(data, "Finite JSON or SSE response includes a result.");
  return JSON.parse(data);
}

for (const version of ["2025-03-26", "2025-06-18", "2025-11-25"]) {
  test(`legacy ${version} retrieves preparation prompts and the entry tool after initialization`, async () => {
    const reference = createReferenceMcp(config);
    try {
      const initialized = await rpc(await reference.fetch(request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: version, capabilities: {}, clientInfo: { name: "independent-client", version: "1.0.0" },
      } })));
      assert.equal(initialized.result.protocolVersion, version);
      assert.deepEqual(initialized.result.capabilities.prompts, { listChanged: false });
      const headers = { "mcp-protocol-version": version };
      const notification = await reference.fetch(request({ jsonrpc: "2.0", method: "notifications/initialized" }, headers));
      assert.equal(notification.status, 202);
      assert.equal(await notification.text(), "");
      const listing = await rpc(await reference.fetch(request({ jsonrpc: "2.0", id: 2, method: "prompts/list" }, headers)));
      assert.deepEqual(listing.result.prompts.map((prompt: { name: string }) => prompt.name).sort(), ["assess_week", "prepare_antislop_entry"]);
      for (const [name, expected] of [["assess_week", getScoringGuide(date).prompt], ["prepare_antislop_entry", getEntryGuide(date).prompt]]) {
        const prepared = await rpc(await reference.fetch(request({ jsonrpc: "2.0", id: 3, method: "prompts/get", params: { name } }, headers)));
        assert.deepEqual(prepared.result.messages, [{ role: "user", content: { type: "text", text: expected } }]);
      }
      const entry = await rpc(await reference.fetch(request({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_entry_prompt" } }, headers)));
      assert.deepEqual(entry.result.content, [{ type: "text", text: getEntryGuide(date).prompt }]);
    } finally { await reference.close(); }
  });
}

for (const mode of ["auto", "legacy"] as const) {
  test(`same ${mode} client receives fresh rolling and completed-week prompts across midnight`, async () => {
    let now = new Date("2026-09-20T23:59:59.999Z");
    const reference = createReferenceMcp({ ...config, now: () => now });
    const client = new Client({ name: "freshness-test", version: "1.0.0" }, { versionNegotiation: { mode } });
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      fetch: (url, init) => reference.fetch(new Request(url, init)),
    });
    try {
      await client.connect(transport);
      let previousEntryPrompt = "";
      let previousWeekPrompt = "";
      for (const instant of ["2026-09-20T23:59:59.999Z", "2026-09-21T00:00:00.000Z"]) {
        now = new Date(instant);
        const entryGuide = getEntryGuide(now);
        const weekGuide = getScoringGuide(now);
        const entryTool = await client.callTool({ name: "get_entry_prompt", arguments: {} });
        const entryPrompt = await client.getPrompt({ name: "prepare_antislop_entry", arguments: {} });
        const weekPrompt = await client.getPrompt({ name: "assess_week" });
        assert.deepEqual(entryTool.structuredContent, entryGuide);
        assert.deepEqual(entryPrompt.messages, [{ role: "user", content: { type: "text", text: entryGuide.prompt } }]);
        assert.deepEqual(weekPrompt.messages, [{ role: "user", content: { type: "text", text: weekGuide.prompt } }]);
        assert.notEqual(entryGuide.prompt, previousEntryPrompt);
        assert.notEqual(weekGuide.prompt, previousWeekPrompt);
        assert.equal(Date.parse(entryGuide.window.endsAt) - Date.parse(entryGuide.window.startsAt), 604_800_000);
        previousEntryPrompt = entryGuide.prompt;
        previousWeekPrompt = weekGuide.prompt;
      }
    } finally { await client.close(); await reference.close(); }
  });
}

test("modern prompt requests ignore private metadata and reject arguments before reflecting them", async () => {
  const reference = createReferenceMcp(config);
  const secret = "PRIVATE_WORKFLOW_CANARY";
  const meta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {},
    "example.test/note": secret,
  };
  try {
    for (const name of ["assess_week", "prepare_antislop_entry"]) {
      const headers = { "mcp-protocol-version": "2026-07-28", "mcp-method": "prompts/get", "mcp-name": name };
      const success = await reference.fetch(request({ jsonrpc: "2.0", id: 1, method: "prompts/get", params: { name, _meta: meta } }, headers));
      assert.equal(success.status, 200);
      assert.doesNotMatch(await success.text(), new RegExp(secret));
      for (const args of [null, [], { evidence: secret }, { consent: true }, JSON.parse('{"__proto__":{"evidence":"PRIVATE_WORKFLOW_CANARY"}}')]) {
        const rejected = await reference.fetch(request({ jsonrpc: "2.0", id: 2, method: "prompts/get", params: { name, arguments: args, _meta: meta } }, headers));
        assert.equal(rejected.status, 400);
        assert.deepEqual(await rejected.json(), { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid MCP request." } });
      }
    }
  } finally { await reference.close(); }
});
