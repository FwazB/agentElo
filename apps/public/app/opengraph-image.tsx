import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const runtime = "nodejs";
export const alt = "AntiSlop. Show your work. Less slop. More proof.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const fonts = Promise.all([
  readFile(join(process.cwd(), "public/fonts/dynapuff-bold.ttf")),
  readFile(join(process.cwd(), "public/fonts/dm-sans-regular.ttf")),
  readFile(join(process.cwd(), "public/fonts/dm-sans-bold.ttf")),
]);

export default async function HomeImage() {
  const [displayFont, bodyFont, boldFont] = await fonts;
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", padding: "40px 58px", background: "#fff9e9", color: "#292730", fontFamily: "DM Sans" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", fontFamily: "DynaPuff", fontWeight: 700, fontSize: 34, letterSpacing: "-2px" }}>
          <span>antislop.</span>
          <svg width="38" height="38" viewBox="0 0 40 40" style={{ marginLeft: 12 }}><path d="M20 3L25 13L37 12L30 22L35 33L22 30L13 38L12 25L2 19L14 14Z" fill="#ffe34f" stroke="#292730" strokeWidth="2.5" strokeLinejoin="round" /></svg>
        </div>
        <div style={{ display: "flex", border: "3px solid #292730", background: "#ff9a57", borderRadius: 9, padding: "10px 16px", fontSize: 18, fontWeight: 700, letterSpacing: "1px", boxShadow: "4px 4px 0 #292730", transform: "rotate(2deg)" }}>SHARED REFEREE · PILOT</div>
      </div>
      <div style={{ display: "flex", alignItems: "center", flex: 1, marginTop: 12 }}>
        <div style={{ display: "flex", flexDirection: "column", width: 620 }}>
          <div style={{ display: "flex", fontFamily: "DynaPuff", fontWeight: 700, fontSize: 88, lineHeight: 1.08, letterSpacing: "-5px" }}>show your</div>
          <div style={{ display: "flex", alignSelf: "flex-start", marginTop: 7, padding: "2px 24px 13px", border: "4px solid #292730", borderRadius: 18, background: "#ffe34f", boxShadow: "7px 7px 0 #292730", transform: "rotate(-2deg)", fontFamily: "DynaPuff", fontWeight: 700, fontSize: 96, lineHeight: 1.05, letterSpacing: "-5px" }}>work.</div>
          <div style={{ display: "flex", flexDirection: "column", marginTop: 30, fontSize: 25, lineHeight: 1.45 }}><span>Bring your last seven days.</span><span>Challenge a friend.</span></div>
        </div>
        <div style={{ display: "flex", position: "relative", width: 445, height: 330, marginLeft: 12 }}>
          <div style={{ display: "flex", flexDirection: "column", position: "absolute", left: 0, top: 8, width: 204, height: 244, padding: "20px 18px", border: "4px solid #292730", borderRadius: 20, background: "#83e5ed", boxShadow: "7px 7px 0 #292730", transform: "rotate(-8deg)", alignItems: "center" }}>
            <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: "1px" }}>YOUR WORK</span>
            <svg width="83" height="83" viewBox="0 0 90 90" style={{ marginTop: 24 }}><rect x="7" y="7" width="76" height="76" rx="19" fill="#fff9e9" stroke="#292730" strokeWidth="4" /><path d="M25 45L40 59L66 31" fill="none" stroke="#292730" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" /></svg>
            <span style={{ marginTop: 23, fontFamily: "DynaPuff", fontWeight: 700, fontSize: 24 }}>show it.</span>
            <span style={{ marginTop: 13, fontSize: 12, fontWeight: 700 }}>LAST 7 DAYS</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", position: "absolute", right: 0, top: 42, width: 204, height: 244, padding: "20px 18px", border: "4px solid #292730", borderRadius: 20, background: "#f6a1d1", boxShadow: "7px 7px 0 #292730", transform: "rotate(8deg)", alignItems: "center" }}>
            <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: "1px" }}>THEIR WORK</span>
            <svg width="83" height="83" viewBox="0 0 90 90" style={{ marginTop: 24 }}><rect x="7" y="7" width="76" height="76" rx="19" fill="#fff9e9" stroke="#292730" strokeWidth="4" /><path d="M25 32H64M25 46H64M25 60H49" fill="none" stroke="#292730" strokeWidth="6" strokeLinecap="round" /></svg>
            <span style={{ marginTop: 23, fontFamily: "DynaPuff", fontWeight: 700, fontSize: 24 }}>bring it.</span>
            <span style={{ marginTop: 13, fontSize: 12, fontWeight: 700 }}>LAST 7 DAYS</span>
          </div>
          <div style={{ display: "flex", position: "absolute", left: 169, top: 113, width: 103, height: 103, alignItems: "center", justifyContent: "center", border: "4px solid #292730", borderRadius: 60, background: "#ffe34f", boxShadow: "5px 5px 0 #292730", transform: "rotate(-8deg)", fontFamily: "DynaPuff", fontWeight: 700, fontSize: 45, letterSpacing: "-3px" }}>VS</div>
          <div style={{ display: "flex", position: "absolute", left: 29, bottom: -4, border: "3px solid #292730", borderRadius: 9, padding: "11px 17px", background: "#ff9a57", boxShadow: "4px 4px 0 #292730", transform: "rotate(-3deg)", fontFamily: "DynaPuff", fontWeight: 700, fontSize: 19 }}>less slop. more proof.</div>
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "3px solid #292730", paddingTop: 19, fontSize: 20 }}>
        <span>Submitted evidence · no Elo change</span>
        <span style={{ fontWeight: 700 }}>antislop.org</span>
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
