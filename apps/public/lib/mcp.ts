import { createHash } from "node:crypto";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getScoringGuide, GUIDE_VERSION } from "../../../packages/public-api/scoring-guide.ts";
import { getEntryGuide } from "../../../packages/public-api/entry-guide.ts";

const MAX_BODY = 16_384;
const TOOLS = new Set(["get_scoring_guide", "get_assessment_prompt", "get_entry_prompt"]);
const PROMPTS = new Set(["assess_week", "prepare_antislop_entry"]);
const METHODS: Record<string, readonly string[]> = {
  initialize: ["protocolVersion", "capabilities", "clientInfo", "_meta"],
  "notifications/initialized": ["_meta"],
  ping: ["_meta"],
  "server/discover": ["_meta"],
  "tools/list": ["cursor", "_meta"],
  "tools/call": ["name", "arguments", "_meta"],
  "prompts/list": ["cursor", "_meta"],
  "prompts/get": ["name", "arguments", "_meta"],
};
const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

export interface ReferenceMcpConfig {
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
  now?: () => Date;
  bodyTimeoutMs?: number;
  trustVercelProxy?: boolean;
  requestsPerMinute?: number;
  maxClientEntries?: number;
}

function failure(status: number, code = -32600, message = "Invalid MCP request.", extraHeaders: Record<string, string> = {}): Response {
  return Response.json({ jsonrpc: "2.0", id: null, error: { code, message } }, {
    status, headers: { ...HEADERS, ...extraHeaders },
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function redactRpcError(value: unknown): unknown {
  if (!record(value) || !record(value.error)) return value;
  return { jsonrpc: "2.0", id: value.id, error: { code: Number.isSafeInteger(value.error.code) ? value.error.code : -32603, message: "Invalid MCP request." } };
}

async function secureResponse(response: Response): Promise<Response> {
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    return failure(response.status);
  }
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(HEADERS)) headers.set(name, value);
  if (response.status === 202 || response.status === 204) return new Response(null, { status: response.status, headers });
  // Only finite reference responses reach this point. The SDK's legacy transport
  // uses one JSON data line per event, including errors sent with HTTP 200.
  let text = await response.text();
  if (headers.get("content-type")?.includes("text/event-stream")) {
    text = text.split("\n").map(line => line.startsWith("data:") ? `data: ${JSON.stringify(redactRpcError(JSON.parse(line.slice(5).trim())))}` : line).join("\n");
  } else {
    text = JSON.stringify(redactRpcError(JSON.parse(text)));
  }
  headers.delete("content-length");
  return new Response(text, { status: response.status, headers });
}

function admitted(value: unknown): value is Record<string, unknown> {
  if (!record(value) || Object.keys(value).some(key => !["jsonrpc", "id", "method", "params"].includes(key)) || value.jsonrpc !== "2.0") return false;
  if (typeof value.method !== "string" || !Object.hasOwn(METHODS, value.method)) return false;
  if (Object.hasOwn(value, "id") && !(typeof value.id === "string" && value.id.length <= 128) && !(typeof value.id === "number" && Number.isSafeInteger(value.id))) return false;
  if (value.params !== undefined && (!record(value.params) || Object.keys(value.params).some(key => !METHODS[value.method as string]!.includes(key)))) return false;
  if (value.method === "tools/call" || value.method === "prompts/get") {
    const params = value.params;
    const names = value.method === "tools/call" ? TOOLS : PROMPTS;
    if (!record(params) || typeof params.name !== "string" || !names.has(params.name)) return false;
    if (params.arguments !== undefined && (!record(params.arguments) || Object.keys(params.arguments).length !== 0)) return false;
  }
  return true;
}

class UploadError extends Error {
  constructor(readonly status: number) { super("Invalid MCP upload."); }
}

function parseMcpJson(source: string): unknown {
  const parsed: unknown = JSON.parse(source);
  // JSON.parse silently chooses the last duplicate field. Check decoded keys at
  // every depth before admission or SDK handling, while retaining ordinary JSON
  // numbers and Unicode metadata allowed by MCP. The source is already valid
  // JSON, so only strings and structural punctuation need to be scanned.
  const stack: ({ keys: Set<string>; expectsKey: boolean } | null)[] = [];
  for (const [token] of source.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g)) {
    if (token === "{" || token === "[") {
      stack.push(token === "{" ? { keys: new Set(), expectsKey: true } : null);
      if (stack.length > 64) throw new UploadError(400);
    } else if (token === "}" || token === "]") {
      stack.pop();
    } else {
      const object = stack.at(-1);
      if (!object) continue;
      if (token === ",") object.expectsKey = true;
      else if (token === ":") object.expectsKey = false;
      else if (object.expectsKey && token.startsWith('"')) {
        const key = JSON.parse(token) as string;
        if (object.keys.has(key)) throw new UploadError(400);
        object.keys.add(key);
      }
    }
  }
  return parsed;
}

async function readBody(request: Request, timeoutMs: number): Promise<unknown> {
  if (request.signal.aborted) throw new UploadError(408);
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY)) throw new UploadError(413);
  if (!request.body) throw new UploadError(400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let rejectDeadline: (error: UploadError) => void = () => {};
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const abort = () => { rejectDeadline(new UploadError(408)); void reader.cancel().catch(() => {}); };
  const timer = setTimeout(abort, timeoutMs);
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BODY) { void reader.cancel().catch(() => {}); throw new UploadError(413); }
      chunks.push(part.value);
    }
    try { return parseMcpJson(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new UploadError(400); }
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

/** Public reference only: this module has no account, database, or upstream API access. */
export function createReferenceMcp(config: ReferenceMcpConfig) {
  const now = config.now ?? (() => new Date());
  // A bounded per-instance backstop. Vercel WAF supplies the separate edge rate limit.
  const clients = new Map<string, { count: number; expires: number }>();
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "computer-elo-reference", version: "1.1.0" }, {
      capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
    });
    const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    server.registerTool("get_scoring_guide", {
      description: "Read the public Computer Elo rubric, direct-estimate rules, and fixed AI product/context-source labels. Provides no personal activity or assessment, account access, new source permissions, or publishing capability.",
      inputSchema: z.strictObject({}), annotations,
    }, async () => {
      const guide = getScoringGuide(now());
      return { content: [{ type: "text", text: JSON.stringify(guide) }], structuredContent: guide };
    });
    server.registerTool("get_assessment_prompt", {
      description: "Read the prompt for a direct estimate of the last completed UTC week without follow-up questions. Use existing authorized context; meaningful partial week context can support a rough weighted estimate with conservative confidence. Never invent facts, access, or AI identity. With no usable week context, return the existing no-score result. Final results use approved aggregates and optional fixed AI product/context-source labels, never underlying chat or memory. Accepts no personal inputs, grants no new source permissions, and publishes nothing.",
      inputSchema: z.strictObject({}), annotations,
    }, async () => {
      const guide = getScoringGuide(now());
      return { content: [{ type: "text", text: guide.prompt }], structuredContent: { version: GUIDE_VERSION, weekId: guide.weekId, start: guide.start, end: guide.end, prompt: guide.prompt } };
    });
    server.registerTool("get_entry_prompt", {
      title: "Prepare an AntiSlop entry",
      description: "Read the public prompt and rolling seven-day window for preparing an AntiSlop work-entry draft in your own assistant. Use only existing authorized context. Returns instructions, not an assessment or verdict. Accepts no evidence or personal inputs, assigns no score, grants no consent, and never submits an entry, calls the referee, or publishes anything. Review the draft on the site before submission.",
      inputSchema: z.strictObject({}), annotations,
    }, async () => {
      const guide = getEntryGuide(now());
      return { content: [{ type: "text", text: guide.prompt }], structuredContent: guide };
    });
    server.registerPrompt("assess_week", {
      title: "Rate my completed week",
      description: "Prepare a weekly Computer Form estimate from existing authorized context for review on the site. Does not publish a score or provide history access.",
    }, () => ({ messages: [{ role: "user", content: { type: "text", text: getScoringGuide(now()).prompt } }] }));
    server.registerPrompt("prepare_antislop_entry", {
      title: "Prepare my AntiSlop entry",
      description: "Prepare a rolling seven-day work-entry draft from existing authorized context for review on the site. Does not grant consent, submit evidence, invoke the referee, or assign a score.",
    }, () => ({ messages: [{ role: "user", content: { type: "text", text: getEntryGuide(now()).prompt } }] }));
    return server;
  }, { legacy: "stateless", responseMode: "json", maxSubscriptions: 0, onerror: () => {} });

  function takeRateLimit(request: Request): boolean {
    const time = now().getTime();
    const address = config.trustVercelProxy ? (request.headers.get("x-vercel-forwarded-for") ?? "unknown").slice(0, 256) : "local";
    const key = createHash("sha256").update(address).digest("hex");
    let bucket = clients.get(key);
    if (!bucket || bucket.expires <= time) {
      for (const [client, entry] of clients) if (entry.expires <= time) clients.delete(client);
      if (clients.size >= (config.maxClientEntries ?? 2_048)) return false;
      bucket = { count: 0, expires: time + 60_000 };
      clients.set(key, bucket);
    }
    return ++bucket.count <= (config.requestsPerMinute ?? 120);
  }

  async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Exact authorities and origins; no wildcard domains, forwarded-host trust, or reflected input.
    const host = request.headers.get("host");
    const origin = request.headers.get("origin");
    if (!config.allowedHosts.includes(url.host) || (host !== null && host.toLowerCase() !== url.host) ||
        (origin !== null && !config.allowedOrigins.includes(origin))) return failure(403, -32600, "Request origin is not allowed.");
    if (url.pathname !== "/mcp" || url.search) return failure(404, -32601, "MCP endpoint not found.");
    if (!takeRateLimit(request)) return failure(429, -32000, "Too many requests. Try again later.", { "Retry-After": "60" });
    if (request.method !== "POST") return failure(405, -32600, "Use POST for MCP requests.", { Allow: "POST" });
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return failure(415, -32600, "Use application/json.");
    let body: unknown;
    try { body = await readBody(request, config.bodyTimeoutMs ?? 5_000); }
    catch (error) { return failure(error instanceof UploadError ? error.status : 400); }
    // Refuse batches, unknown methods, and all tool arguments before SDK validation can reflect them.
    if (!admitted(body)) return failure(400);
    const headers = new Headers();
    for (const name of ["accept", "content-type", "mcp-protocol-version", "mcp-method", "mcp-name"]) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    const cleanRequest = new Request(url, { method: "POST", headers, body: JSON.stringify(body), signal: request.signal });
    try {
      const response = await handler.fetch(cleanRequest, { parsedBody: body });
      return await secureResponse(response);
    } catch { return failure(500, -32603, "MCP reference is temporarily unavailable."); }
  }
  return { fetch, close: () => handler.close() };
}
