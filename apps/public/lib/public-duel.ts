import "server-only";
import { createHmac } from "node:crypto";
import { headers } from "next/headers";
import { cache } from "react";
import { boundedJson } from "../../../packages/referee/gateway.ts";
import type { DuelView, PublicEntry } from "../../../packages/public-api/antislop.ts";

export const ANTISLOP_URL = "https://antislop.org";
async function publicRecord(path: string) {
  const apiUrl = process.env.ELO_API_URL;
  const key = process.env.ELO_SERVICE_KEY;
  if (!apiUrl || !key) throw new Error("Arena unavailable");
  const url = new URL(`/v1/antislop/${path}`, apiUrl);
  if (url.username || url.password || (process.env.NODE_ENV === "production" && url.protocol !== "https:")) throw new Error("Arena unavailable");
  const incoming = await headers();
  const clientId = createHmac("sha256", key).update((incoming.get("x-vercel-forwarded-for") ?? "social-preview").slice(0, 256)).digest("hex");
  const response = await fetch(url, { headers: { "X-Service-Key": key, "X-Client-Id": clientId }, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5_000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Arena unavailable");
  return boundedJson(response, 32_768);
}
export const getPublicDuel = cache(async (id: string): Promise<DuelView | null> => id.length === 35 && /^ad_[0-9a-f]{32}$/.test(id) ? await publicRecord(`duels/${id}`) as DuelView | null : null);
export const getPublicEntry = cache(async (id: string): Promise<PublicEntry | null> => id.length === 35 && /^ae_[0-9a-f]{32}$/.test(id) ? await publicRecord(`entries/${id}`) as PublicEntry | null : null);

export function duelHeadline(duel: DuelView): string {
  const name = (value: string | null) => value ? `@${value}` : "A player";
  if (duel.state === "pending" || duel.state === "judging") return `${name(duel.a.username)} vs ${name(duel.b.username)}`;
  if (duel.outcome === "a_wins") return `${name(duel.a.username)} wins this duel`;
  if (duel.outcome === "b_wins") return `${name(duel.b.username)} wins this duel`;
  if (duel.outcome === "draw") return "Good work on both sides. A draw.";
  return "This duel finished unrated";
}
