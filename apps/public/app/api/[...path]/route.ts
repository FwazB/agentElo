import { proxyApi } from "../../../lib/proxy";

export const runtime = "nodejs";
export const maxDuration = 20;
export const dynamic = "force-dynamic";

async function handle(request: Request, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await context.params;
  return proxyApi(request, path, {
    apiUrl: process.env.ELO_API_URL,
    serviceKey: process.env.ELO_SERVICE_KEY,
    production: process.env.NODE_ENV === "production",
  });
}
export { handle as GET, handle as POST, handle as DELETE };
