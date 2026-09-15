import { renderScoringGuide } from "../../../../packages/public-api/scoring-guide.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET() {
  return new Response(renderScoringGuide(), { headers: {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "public, max-age=0, s-maxage=60, must-revalidate",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  } });
}
