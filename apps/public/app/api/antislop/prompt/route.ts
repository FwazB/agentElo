import { buildEntryPrompt } from "../../../../../../packages/referee/drafts.ts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  const end = Date.now();
  const window = { startsAt: new Date(end - 7 * 86_400_000).toISOString(), endsAt: new Date(end).toISOString() };
  return Response.json({ prompt: buildEntryPrompt(window), window }, { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
