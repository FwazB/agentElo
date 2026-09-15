import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { getPublicProfile } from "../../../lib/public-profile";

export const runtime = "nodejs";
export const alt = "AntiSlop personal Form score out of 1000 and current Elo. What’s your Elo?";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const fonts = Promise.all([
  readFile(join(process.cwd(), "public/fonts/dynapuff-bold.ttf")),
  readFile(join(process.cwd(), "public/fonts/dm-sans-regular.ttf")),
  readFile(join(process.cwd(), "public/fonts/dm-sans-bold.ttf")),
]);
const ink = "#292730";
const cream = "#fff9e9";
const yellow = "#ffe34f";
const cyan = "#83e5ed";
const pink = "#f6a1d1";
const orange = "#ff9a57";

export default async function ScoreImage({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  let profile, fontData;
  try { [profile, fontData] = await Promise.all([getPublicProfile(username), fonts]); }
  catch { return new Response("Score unavailable", { status: 503, headers: { "Cache-Control": "no-store" } }); }
  if (!profile) return new Response("Player not found", { status: 404 });
  const receipt = profile.player.receipt;
  const elo = receipt?.elo.scalar;
  const publicName = profile.player.username ?? username;
  const rated = (elo?.rated_matches ?? 0) > 0;
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: cream, color: ink, padding: "36px 52px", fontFamily: "DM Sans" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", height: 58 }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <span style={{ fontFamily: "DynaPuff", fontWeight: 700, fontSize: 42, letterSpacing: "-2px" }}>antislop.</span>
          <svg width="42" height="42" viewBox="0 0 40 40" style={{ marginLeft: 14 }}><path d="M20 3L25 13L37 12L30 22L35 33L22 30L13 38L12 25L2 19L14 14Z" fill={yellow} stroke={ink} strokeWidth="2.5" strokeLinejoin="round" /></svg>
        </div>
        <div style={{ display: "flex", alignItems: "center", padding: "9px 20px", border: `3px solid ${ink}`, borderRadius: 12, background: pink, boxShadow: `5px 5px 0 ${ink}`, transform: "rotate(2deg)", fontSize: publicName.length > 16 ? 24 : 30, fontWeight: 700 }}>@{publicName}</div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 32, height: 314 }}>
        <div style={{ display: "flex", position: "relative", flexDirection: "column", width: 700, height: 306, padding: "22px 28px", background: yellow, border: `4px solid ${ink}`, borderRadius: 24, boxShadow: `9px 9px 0 ${ink}`, transform: "rotate(-2deg)" }}>
          <span style={{ fontSize: 27, fontWeight: 700 }}>{receipt ? "My AI rated me with a" : "No Form published yet"}</span>
          <div style={{ display: "flex", alignItems: "baseline", marginTop: 1 }}>
            <span style={{ fontFamily: "DynaPuff", fontWeight: 700, fontSize: 158, lineHeight: 1.04, letterSpacing: "-7px" }}>{receipt?.form.score ?? "—"}</span>
            <span style={{ fontFamily: "DynaPuff", fontWeight: 700, fontSize: 42, marginLeft: 16, letterSpacing: "-2px" }}>/1000</span>
          </div>
          <div style={{ display: "flex", alignSelf: "flex-start", marginTop: "auto", background: cream, border: `3px solid ${ink}`, borderRadius: 8, padding: "6px 13px", fontSize: 16, fontWeight: 700, letterSpacing: "1px" }}>PERSONAL FORM</div>
          <svg width="50" height="50" viewBox="0 0 50 50" style={{ position: "absolute", right: 26, bottom: 22 }}><path d="M25 4V46M4 25H46M10 10L40 40M40 10L10 40" stroke={ink} strokeWidth="5" strokeLinecap="round" /></svg>
        </div>
        <div style={{ display: "flex", position: "relative", flexDirection: "column", alignItems: "center", width: 350, marginTop: 8 }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 342, height: 238, padding: "22px 18px", background: cyan, border: `4px solid ${ink}`, borderRadius: 24, boxShadow: `8px 8px 0 ${ink}`, transform: "rotate(3deg)" }}>
            <span style={{ fontSize: 21, fontWeight: 700, letterSpacing: "2px" }}>CURRENT ELO</span>
            <span style={{ fontFamily: "DynaPuff", fontWeight: 700, fontSize: 77, lineHeight: 1.1, letterSpacing: "-4px", marginTop: 13 }}>{Math.round((elo?.rating_milli ?? 1200000) / 1000)}</span>
            <span style={{ marginTop: 12, fontSize: 15, fontWeight: 700 }}>{rated ? `${elo!.rated_matches} RATED MATCH${elo!.rated_matches === 1 ? "" : "ES"}` : "STARTING RATING · 0 RATED MATCHES"}</span>
          </div>
          <div style={{ display: "flex", position: "absolute", right: -1, bottom: 8, background: orange, border: `3px solid ${ink}`, borderRadius: 9, padding: "10px 16px", boxShadow: `5px 5px 0 ${ink}`, transform: "rotate(-3deg)", fontFamily: "DynaPuff", fontWeight: 700, fontSize: 18 }}>less slop. more proof.</div>
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 23 }}>
        <span style={{ fontFamily: "DynaPuff", fontWeight: 700, fontSize: 46, letterSpacing: "-2px" }}>What’s your Elo?</span>
        <div style={{ display: "flex", alignItems: "center", background: pink, border: `3px solid ${ink}`, borderRadius: 13, padding: "9px 17px", boxShadow: `5px 5px 0 ${ink}`, transform: "rotate(-2deg)" }}>
          <span style={{ fontSize: 25, fontWeight: 700 }}>antislop.org</span>
          <svg width="38" height="32" viewBox="0 0 38 32" style={{ marginLeft: 20 }}><path d="M3 16H33M21 4L33 16L21 28" fill="none" stroke={ink} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: "auto", paddingTop: 17, borderTop: `2px solid ${ink}`, fontSize: 14 }}>
        <span>{receipt ? `Self-attested · ${receipt.week_id} · ${Math.round(receipt.form.confidence.effective_ppm / 10000)}% confidence` : "No assessment published · starting Elo"}</span>
        <span>Private history stays private.</span>
      </div>
    </div>,
    {
      ...size,
      fonts: [
        { name: "DynaPuff", data: fontData[0], weight: 700, style: "normal" },
        { name: "DM Sans", data: fontData[1], weight: 400, style: "normal" },
        { name: "DM Sans", data: fontData[2], weight: 700, style: "normal" },
      ],
      headers: { "Cache-Control": "public, max-age=60, s-maxage=60", "X-Content-Type-Options": "nosniff" },
    },
  );
}
