import { PUBLIC_SITE_URL } from "../../../../packages/public-api/scoring-guide.ts";
import { createReferenceMcp } from "../../lib/mcp.ts";

export const runtime = "nodejs";
export const maxDuration = 10;
export const dynamic = "force-dynamic";

const origins = [PUBLIC_SITE_URL];
for (const deployment of [process.env.VERCEL_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL]) {
  if (deployment && /^[a-z0-9.-]+$/.test(deployment)) origins.push(`https://${deployment}`);
}
if (process.env.NODE_ENV !== "production") origins.push("http://localhost:3000", "http://127.0.0.1:3000");
const reference = createReferenceMcp({
  allowedHosts: origins.map(origin => new URL(origin).host),
  allowedOrigins: origins,
  trustVercelProxy: process.env.VERCEL === "1",
});

export const POST = reference.fetch;
export const GET = reference.fetch;
export const DELETE = reference.fetch;
export const PUT = reference.fetch;
export const PATCH = reference.fetch;
export const HEAD = reference.fetch;
export const OPTIONS = reference.fetch;
