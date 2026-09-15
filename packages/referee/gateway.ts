import { judgeFingerprint, SYSTEM_PROMPT, type JudgePacket, type JudgeResponse } from "./judge.ts";
import { parseRefereeJson } from "./json.ts";
import { LIVE_JUDGE_CONFIG, VERDICT_SCHEMA } from "./live-config.ts";

export class GatewayError extends Error {
  constructor(readonly code: "referee_failed" | "referee_timed_out") { super(code); }
}

export async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body || Number(response.headers.get("content-length") ?? 0) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Invalid response size.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maxBytes) throw new Error("Invalid response size.");
      chunks.push(part.value);
    }
    return parseRefereeJson(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Only accepts the frozen packet obtained from the authenticated API, never browser prompts. */
export async function runGatewayPacket(packet: JudgePacket, options: { token: string; fetcher?: typeof fetch; timeoutMs?: number }): Promise<JudgeResponse> {
  if (!options.token || packet.judgeFingerprint !== judgeFingerprint(LIVE_JUDGE_CONFIG)
      || packet.request.model !== LIVE_JUDGE_CONFIG.modelSnapshot || packet.request.temperature !== 0
      || packet.request.maxOutputTokens !== LIVE_JUDGE_CONFIG.maxOutputTokens
      || packet.request.messages.length !== 2 || packet.request.messages[0].role !== "system"
      || packet.request.messages[0].content !== SYSTEM_PROMPT || packet.request.messages[1].role !== "user") throw new GatewayError("referee_failed");
  const signal = AbortSignal.timeout(options.timeoutMs ?? 45_000);
  try {
    const response = await (options.fetcher ?? fetch)("https://ai-gateway.vercel.sh/v1/chat/completions", {
      method: "POST", redirect: "error", signal,
      headers: { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: LIVE_JUDGE_CONFIG.modelSnapshot, temperature: 0, max_tokens: LIVE_JUDGE_CONFIG.maxOutputTokens,
        messages: packet.request.messages, stream: false,
        providerOptions: { gateway: { only: ["alibaba"] } },
        response_format: { type: "json_schema", json_schema: { name: "antislop_verdict_v1", strict: true, schema: VERDICT_SCHEMA } },
      }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new GatewayError("referee_failed"); }
    const result = await boundedJson(response, 32_768) as Record<string, unknown>;
    const choices = result?.choices;
    if (result?.model !== LIVE_JUDGE_CONFIG.modelSnapshot || !Array.isArray(choices) || choices.length !== 1) throw new GatewayError("referee_failed");
    const choice = choices[0];
    if (choice?.finish_reason !== "stop" || choice.message?.refusal || typeof choice.message?.content !== "string") throw new GatewayError("referee_failed");
    // The API independently validates references, outcome/reason consistency, and both order bindings.
    const verdict = parseRefereeJson(choice.message.content);
    return { version: "antislop.judge-response.v1", judgeFingerprint: packet.judgeFingerprint, pairFingerprint: packet.pairFingerprint, order: packet.order, verdict };
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError(signal.aborted ? "referee_timed_out" : "referee_failed");
  }
}
