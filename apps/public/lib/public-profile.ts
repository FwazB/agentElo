import "server-only";
import { createHmac } from "node:crypto";
import { headers } from "next/headers";
import { cache } from "react";
import type { PlayerView } from "../../../packages/public-api/types";

export const SITE_URL = "https://antislop.org";

export const getPublicProfile = cache(async (username: string): Promise<PlayerView | null> => {
  if (!/^[a-z][a-z0-9_]{2,19}$/.test(username)) return null;
  const apiUrl = process.env.ELO_API_URL;
  const serviceKey = process.env.ELO_SERVICE_KEY;
  if (!apiUrl || !serviceKey) throw new Error("League unavailable");
  const url = new URL(`/v1/users/${username}`, apiUrl);
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") throw new Error("League unavailable");
  const incoming = await headers();
  const clientIp = incoming.get("x-vercel-forwarded-for") ?? "social-preview";
  const clientId = createHmac("sha256", serviceKey).update(clientIp.slice(0, 256)).digest("hex");
  const result = await fetch(url, {
    headers: { "X-Service-Key": serviceKey, "X-Client-Id": clientId },
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5_000),
  });
  if (result.status === 404) return null;
  if (!result.ok) throw new Error("League unavailable");
  return await result.json() as PlayerView;
});
