import { getVercelOidcToken } from "@vercel/oidc";
import { judgeDuel } from "../../../../../../lib/antislop-judge";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 90;
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  // Resolve from Vercel's request context; environment tokens are only a local/build fallback.
  let gatewayToken: string | undefined;
  try { gatewayToken = await getVercelOidcToken(); } catch { /* judgeDuel returns a safe unavailable response before claiming. */ }
  return judgeDuel(request, (await context.params).id, {
    apiUrl: process.env.ELO_API_URL, serviceKey: process.env.ELO_SERVICE_KEY,
    gatewayToken,
    production: process.env.NODE_ENV === "production",
  });
}
