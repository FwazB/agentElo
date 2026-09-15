// Read-only production verification. Run with Node 24 after the deployment is live.
// Optional: AI_REFERENCE_URL=https://an-approved-deployment.example
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "../apps/public/node_modules/@modelcontextprotocol/client/dist/index.mjs";
import { getScoringGuide, PUBLIC_SITE_URL, renderScoringGuide } from "../packages/public-api/scoring-guide.ts";
import { getEntryGuide, ENTRY_DRAFT_VERSION, renderEntryGuide } from "../packages/public-api/entry-guide.ts";

const started = new Date();
const origin = new URL(process.env.AI_REFERENCE_URL ?? PUBLIC_SITE_URL);
assert.equal(origin.protocol, "https:", "Live checks require HTTPS.");
assert.equal(origin.username + origin.password + origin.search + origin.hash, "", "Use a deployment origin without credentials, query, or fragment.");
assert.equal(origin.pathname, "/", "Use a deployment origin without a path.");
const output = new URL(process.env.AI_REFERENCE_REPORT ?? "../artifacts/ai-reference/live-after.json", import.meta.url);
const expectedGuide = getScoringGuide(started);
const expectedTools = ["get_assessment_prompt", "get_entry_prompt", "get_scoring_guide"];
const expectedPrompts = ["assess_week", "prepare_antislop_entry"];
const checks = [];
const requests = [];
const sha256 = text => createHash("sha256").update(text).digest("hex");
let rateText;

async function fetchPublic(url, init = {}) {
  const target = new URL(url, origin);
  assert.equal(target.origin, origin.origin, "The live check never follows another origin.");
  const response = await fetch(target, {
    ...init, redirect: "error", credentials: "omit",
    signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
  requests.push({ path: target.pathname, method: init.method ?? "GET", status: response.status, setCookie: response.headers.has("set-cookie") });
  assert.equal(response.headers.has("set-cookie"), false, `${target.pathname} must not set an account cookie.`);
  return response;
}

async function boundedText(response, maximum = 256_000) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new Error("Public response exceeded the live-check size limit."); }
      chunks.push(part.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { reader.releaseLock(); }
}

async function check(name, run) {
  try { checks.push({ name, passed: true, ...await run() }); }
  catch (error) {
    // Assertions contain only this script's public/reference inputs. Do not archive response bodies.
    checks.push({ name, passed: false, error: String(error?.message ?? "Check failed.").slice(0, 1_000) });
  }
}

await check("plain-text scoring reference matches the current guide and completed UTC week", async () => {
  const response = await fetchPublic("/rate.md");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/plain/);
  rateText = await boundedText(response, 32_768);
  assert.equal(rateText, renderScoringGuide(started));
  assert.ok(rateText.includes(expectedGuide.prompt));
  return { status: response.status, guideVersion: expectedGuide.version, weekId: expectedGuide.weekId, sha256: sha256(rateText) };
});

await check("connection instructions and AI index expose the public reference links", async () => {
  const connect = await fetchPublic("/connect");
  assert.equal(connect.status, 200);
  const html = await boundedText(connect);
  assert.ok(html.includes("/rate.md") && html.includes("/mcp"));
  assert.ok(html.includes('id="mcp-url"') && html.includes('id="reference-url"'));
  assert.equal((html.match(/<main\b/g) ?? []).length, 1);
  assert.match(html, /<dialog[^>]+data-view="connect"/);
  const index = await fetchPublic("/llms.txt");
  assert.equal(index.status, 200);
  const text = await boundedText(index, 16_384);
  assert.ok(text.includes("/rate.md") && text.includes("/entry.md") && text.includes("/connect") && text.includes("/mcp"));
  assert.match(text, /No evidence means no score/);
  return { connect: connect.status, index: index.status, indexSha256: sha256(text) };
});

await check("plain-text entry reference uses the canonical rolling-window prompt", async () => {
  const response = await fetchPublic("/entry.md");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/plain/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const text = await boundedText(response, 32_768);
  const endsAt = /^Window: .+ inclusive to (.+) exclusive$/m.exec(text)?.[1];
  assert.ok(endsAt);
  assert.ok(Math.abs(Date.now() - Date.parse(endsAt)) < 60_000, "Entry reference window must be fresh.");
  assert.equal(text, renderEntryGuide(new Date(endsAt)));
  return { status: response.status, draftVersion: ENTRY_DRAFT_VERSION, sha256: sha256(text) };
});

for (const mode of ["auto", "legacy"]) {
  await check(`official MCP client completes ${mode === "auto" ? "modern" : "legacy"} discovery and both workflows`, async () => {
    const client = new Client({ name: "computer-elo-live-reference-check", version: "1.0.0" }, { versionNegotiation: { mode } });
    const transport = new StreamableHTTPClientTransport(new URL("/mcp", origin), {
      fetch: async (url, init = {}) => {
        assert.equal(new URL(url).pathname, "/mcp", "MCP requests stay on the reference endpoint.");
        if (init.method === "POST") {
          const message = JSON.parse(String(init.body));
          assert.ok(["initialize", "notifications/initialized", "server/discover", "tools/list", "tools/call", "prompts/list", "prompts/get", "ping"].includes(message.method));
          if (message.method === "tools/call") {
            assert.ok(expectedTools.includes(message.params?.name));
            assert.deepEqual(message.params?.arguments ?? {}, {});
          }
          if (message.method === "prompts/get") {
            assert.ok(expectedPrompts.includes(message.params?.name));
            assert.deepEqual(message.params?.arguments ?? {}, {});
          }
        } else assert.ok(["GET", "DELETE"].includes(init.method ?? "GET"));
        return fetchPublic(url, init);
      },
    });
    try {
      await client.connect(transport);
      const era = client.getProtocolEra();
      assert.equal(era, mode === "auto" ? "modern" : "legacy");
      assert.equal(client.getServerCapabilities()?.tools?.listChanged, false);
      assert.equal(client.getServerCapabilities()?.prompts?.listChanged, false);
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map(tool => tool.name).sort(), expectedTools);
      for (const tool of tools.tools) {
        assert.equal(tool.annotations?.readOnlyHint, true);
        assert.equal(tool.annotations?.openWorldHint, false);
        assert.deepEqual(tool.inputSchema.properties, {});
        assert.equal(tool.inputSchema.additionalProperties, false);
      }
      const guide = (await client.callTool({ name: "get_scoring_guide", arguments: {} })).structuredContent;
      assert.deepEqual(guide, expectedGuide);
      const prompt = (await client.callTool({ name: "get_assessment_prompt", arguments: {} })).structuredContent;
      assert.equal(prompt?.weekId, expectedGuide.weekId);
      assert.equal(prompt?.prompt, expectedGuide.prompt);
      assert.ok(rateText?.includes(prompt.prompt), "The MCP prompt matches the published text reference.");
      const entry = (await client.callTool({ name: "get_entry_prompt", arguments: {} })).structuredContent;
      assert.ok(entry?.window?.endsAt);
      assert.ok(Math.abs(Date.now() - Date.parse(entry.window.endsAt)) < 60_000);
      assert.deepEqual(entry, getEntryGuide(new Date(entry.window.endsAt)));
      const prompts = await client.listPrompts();
      assert.deepEqual(prompts.prompts.map(prompt => prompt.name).sort(), expectedPrompts);
      const weekly = await client.getPrompt({ name: "assess_week" });
      assert.deepEqual(weekly.messages, [{ role: "user", content: { type: "text", text: expectedGuide.prompt } }]);
      const prepared = await client.getPrompt({ name: "prepare_antislop_entry" });
      assert.equal(prepared.messages.length, 1);
      assert.equal(prepared.messages[0].role, "user");
      assert.equal(prepared.messages[0].content.type, "text");
      const entryText = prepared.messages[0].content.text;
      const endsAt = /^Prepare my AntiSlop work entry for the rolling seven days from .+ inclusive to (.+) exclusive\./.exec(entryText)?.[1];
      assert.ok(endsAt);
      assert.ok(Math.abs(Date.now() - Date.parse(endsAt)) < 60_000);
      assert.equal(entryText, getEntryGuide(new Date(endsAt)).prompt);
      return { era, tools: expectedTools, prompts: expectedPrompts, guideVersion: guide.version, weekId: guide.weekId, promptSha256: sha256(prompt.prompt), entryPromptSha256: sha256(entry.prompt) };
    } finally { await client.close(); }
  });
}

const toolCall = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_scoring_guide", arguments: {} } };
const jsonHeaders = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
await check("hostile browser origin is rejected", async () => {
  const response = await fetchPublic("/mcp", { method: "POST", headers: { ...jsonHeaders, Origin: "https://untrusted.invalid" }, body: JSON.stringify(toolCall) });
  assert.equal(response.status, 403);
  const text = await boundedText(response, 4_096);
  assert.ok(!text.includes("untrusted.invalid"));
  return { status: response.status };
});

await check("personal tool arguments are rejected with a fixed error", async () => {
  const canary = "LIVE_REFERENCE_PRIVATE_INPUT_CANARY";
  const response = await fetchPublic("/mcp", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ ...toolCall, params: { ...toolCall.params, arguments: { history: canary } } }) });
  assert.equal(response.status, 400);
  const text = await boundedText(response, 4_096);
  assert.ok(!text.includes(canary));
  assert.deepEqual(JSON.parse(text), { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid MCP request." } });
  return { status: response.status, fixedError: true, inputReflected: false };
});

await check("standalone MCP GET streams are disabled", async () => {
  const response = await fetchPublic("/mcp");
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
  await boundedText(response, 4_096);
  return { status: response.status };
});

const report = {
  checkedAt: new Date().toISOString(), startedAt: started.toISOString(), origin: origin.origin,
  passed: checks.every(check => check.passed), checks, requests,
  productionAccountsCreatedByChecks: 0, scoresPublishedByChecks: 0, accountCredentialsUsed: false,
};
await mkdir(new URL("./", output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ passed: report.passed, checks: checks.length, failed: checks.filter(check => !check.passed).map(check => check.name), artifact: fileURLToPath(output) }));
if (!report.passed) process.exitCode = 1;
