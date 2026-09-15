import { renderEntryGuide } from "../../../../packages/public-api/entry-guide.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET() {
  return new Response(renderEntryGuide(), { headers: {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  } });
}
