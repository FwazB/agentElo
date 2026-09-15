import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const runtime = "nodejs";
export const alt = "Computer Elo. How was your week? Ask your AI. Share your score. Your history stays private.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function HomeImage() {
  const [displayFont, bodyFont, boldFont] = await Promise.all([
    readFile(join(process.cwd(), "public/fonts/dynapuff-bold.ttf")),
    readFile(join(process.cwd(), "public/fonts/dm-sans-regular.ttf")),
    readFile(join(process.cwd(), "public/fonts/dm-sans-bold.ttf")),
  ]);
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", padding: "48px 64px", background: "#faf8f2", color: "#292730", fontFamily: "DM Sans" }}>
      <div style={{ display: "flex", alignItems: "center", fontSize: 29, letterSpacing: "-1px" }}>
        <span style={{ fontWeight: 700 }}>computer</span><span style={{ marginLeft: 7 }}>elo</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", marginTop: 48, fontFamily: "DynaPuff", fontWeight: 700, fontSize: 84, lineHeight: 1.12, letterSpacing: "-4px" }}>
        <span>how was</span><span>your week?</span>
      </div>
      <div style={{ display: "flex", fontSize: 29, color: "#6a6770", marginTop: 26 }}>Ask your AI. Share your score.</div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "auto", borderTop: "1px solid #dedbd4", paddingTop: 22, fontSize: 21 }}>
        <span style={{ color: "#6a6770" }}>Real evidence. Private history.</span>
        <span style={{ color: "#6150be" }}>computer-elo.vercel.app</span>
      </div>
    </div>,
    {
      ...size,
      fonts: [
        { name: "DynaPuff", data: displayFont, weight: 700, style: "normal" },
        { name: "DM Sans", data: bodyFont, weight: 400, style: "normal" },
        { name: "DM Sans", data: boldFont, weight: 700, style: "normal" },
      ],
      headers: { "Cache-Control": "public, max-age=3600, s-maxage=86400", "X-Content-Type-Options": "nosniff" },
    },
  );
}
