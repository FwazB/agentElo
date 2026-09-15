import { createHmac } from "node:crypto";
import { boundedJson, GatewayError, runGatewayPacket } from "../../../packages/referee/gateway.ts";
import type { JudgePacket } from "../../../packages/referee/judge.ts";

interface Config {
  apiUrl?: string; serviceKey?: string; gatewayToken?: string; production?: boolean;
  fetcher?: typeof fetch; gatewayFetcher?: typeof fetch;
}
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

/** A browser may request work on an admitted duel; it can never submit a verdict or packet. */
export async function judgeDuel(request: Request, duelId: string, config: Config): Promise<Response> {
  if (request.method !== "POST" || duelId.length !== 35 || !/^ad_[0-9a-f]{32}$/.test(duelId)) return json({ error: "Not found." }, 404);
  const url = new URL(request.url);
  if (url.search || request.headers.get("origin") !== url.origin || request.headers.get("sec-fetch-site") === "cross-site") return json({ error: "Open this page directly to continue." }, 403);
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return json({ error: "Use application/json." }, 415);
  // This route has no client-supplied payload. Discard it without buffering or forwarding it.
  await request.body?.cancel().catch(() => {});
  const token = (request.headers.get("cookie") ?? "").split(";").map(s => s.trim()).find(s => s.startsWith("elo_session="))?.slice("elo_session=".length);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return json({ error: "Your player session is missing. Reopen the challenge to continue." }, 401);
  if (!config.apiUrl || !config.serviceKey || config.serviceKey.length < 32 || !config.gatewayToken) return json({ error: "The referee is temporarily unavailable. Your entry is saved." }, 503);
  let upstream: URL;
  try {
    upstream = new URL(config.apiUrl);
    if (upstream.username || upstream.password || !["https:", "http:"].includes(upstream.protocol) || (config.production && upstream.protocol !== "https:")) throw new Error();
  } catch { return json({ error: "The referee connection is unavailable." }, 503); }
  const clientId = createHmac("sha256", config.serviceKey).update((config.production ? request.headers.get("x-vercel-forwarded-for") ?? "unknown" : "local").slice(0, 256)).digest("hex");
  const call = async (operation: string, body: unknown) => {
    const endpoint = new URL(`/v1/antislop/internal/duels/${duelId}/${operation}`, upstream);
    const response = await (config.fetcher ?? fetch)(endpoint, {
      method: "POST", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8_000),
      headers: { "X-Service-Key": config.serviceKey!, "X-Client-Id": clientId, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, ok: response.ok, payload: await boundedJson(response, operation === "claim" ? 600_000 : 32_768) as Record<string, unknown> };
  };
  let leaseToken: string | undefined;
  try {
    const claim = await call("claim", {});
    if (!claim.ok) return json({ error: typeof claim.payload.error === "string" ? claim.payload.error : "This duel cannot be judged again. Refresh its result." }, claim.status);
    if (typeof claim.payload.leaseToken !== "string" || !claim.payload.packets || typeof claim.payload.packets !== "object") throw new Error("Invalid claim");
    leaseToken = claim.payload.leaseToken;
    const packets = claim.payload.packets as { ab: JudgePacket; ba: JudgePacket };
    if (packets.ab.order !== "ab" || packets.ba.order !== "ba" || packets.ab.pairFingerprint !== packets.ba.pairFingerprint) throw new Error("Invalid pair");
    const results = await Promise.allSettled([packets.ab, packets.ba].map(packet => runGatewayPacket(packet, {
      token: config.gatewayToken!, ...(config.gatewayFetcher ? { fetcher: config.gatewayFetcher } : {}),
    })));
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    const [ab, ba] = results;
    if (ab?.status !== "fulfilled" || ba?.status !== "fulfilled") throw new Error("Incomplete pair");
    const settled = await call("settle", { leaseToken, responseAB: ab.value, responseBA: ba.value });
    if (!settled.ok) throw new Error("Settlement failed");
    return json(settled.payload);
  } catch (error) {
    if (leaseToken) {
      try {
        const result = await call("fail", { leaseToken, reason: error instanceof GatewayError ? error.code : "referee_failed" });
        if (result.ok) return json(result.payload);
      } catch { /* Durable lease expiry releases the duel; never reroll here. */ }
    }
    return json({ error: "We couldn’t confirm the referee’s result. Refresh to see the recorded duel before trying again." }, 502);
  }
}
