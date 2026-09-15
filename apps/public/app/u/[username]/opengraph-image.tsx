import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { getPublicProfile } from "../../../lib/public-profile";

export const runtime = "nodejs";
export const alt = "Computer Form and Elo public scorecard";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const fonts = Promise.all([
  readFile(join(process.cwd(), "public/fonts/dynapuff-bold.ttf")),
  readFile(join(process.cwd(), "public/fonts/dm-sans-regular.ttf")),
  readFile(join(process.cwd(), "public/fonts/dm-sans-bold.ttf")),
]);
const ink = "#25243a";
const cream = "#faf5df";
const cobalt = "#5047ee";
const butter = "#ffd75e";
const pink = "#ff9dc6";
const mint = "#b9edcd";

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
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: cream, color: ink, padding: "38px 48px", fontFamily: "DM Sans" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", height: 54 }}>
        <span style={{ fontFamily: "DynaPuff", fontSize: 38, color: cobalt }}>computer elo</span>
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <span style={{ fontSize: 22, fontWeight: 700 }}>{receipt?.week_id ?? "NEW PLAYER"}</span>
          <span style={{ display: "flex", background: pink, border: `3px solid ${ink}`, borderRadius: 12, padding: "11px 19px", boxShadow: `4px 4px 0 ${ink}`, transform: "rotate(3deg)", fontSize: 21, fontWeight: 700 }}>{receipt ? "MY WEEK, RATED." : "FIRST WEEK AHEAD."}</span>
        </div>
      </div>
      <div style={{ display: "flex", marginTop: 23, marginBottom: 21, fontFamily: "DynaPuff", fontSize: publicName.length > 14 ? 43 : 54, lineHeight: 1.15, letterSpacing: "-1px" }}>@{publicName}</div>
      <div style={{ display: "flex", gap: 28, height: 296 }}>
        <div style={{ display: "flex", flexDirection: "column", width: 650, padding: "24px 29px", background: butter, border: `4px solid ${ink}`, borderRadius: 28, boxShadow: `8px 8px 0 ${ink}` }}>
          <span style={{ fontSize: 23, fontWeight: 700 }}>COMPUTER FORM</span>
          <div style={{ display: "flex", alignItems: "baseline", marginTop: 4 }}>
            <span style={{ fontFamily: "DynaPuff", fontSize: 138, lineHeight: 1.05, letterSpacing: "-6px" }}>{receipt?.form.score ?? "—"}</span>
            <span style={{ fontSize: 29, fontWeight: 700, marginLeft: 17 }}>/ 1000</span>
          </div>
          <span style={{ marginTop: "auto", fontSize: 23 }}>{receipt ? "A week of work. One little score." : "Your first assessment starts with evidence."}</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 22, width: 420 }}>
          <div style={{ display: "flex", flexDirection: "column", padding: "17px 24px", background: mint, border: `4px solid ${ink}`, borderRadius: 23, boxShadow: `6px 6px 0 ${ink}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 21, fontWeight: 700 }}>CONFIDENCE</span>
              <span style={{ fontFamily: "DynaPuff", fontSize: 42 }}>{receipt ? `${Math.round(receipt.form.confidence.effective_ppm / 10000)}%` : "—"}</span>
            </div>
            <span style={{ marginTop: 5, fontSize: 18 }}>{receipt ? "Limited by coverage and certainty" : "No assessment published yet"}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, padding: "15px 24px", background: cobalt, color: cream, border: `4px solid ${ink}`, borderRadius: 23, boxShadow: `6px 6px 0 ${ink}` }}>
            <span style={{ fontSize: 21, fontWeight: 700 }}>MATCH ELO · SCALAR</span>
            <span style={{ fontFamily: "DynaPuff", fontSize: 40, marginTop: 5 }}>{((elo?.rating_milli ?? 1200000) / 1000).toFixed(3)}</span>
            <span style={{ marginTop: 5, fontSize: 18 }}>{rated ? `${elo!.rated_matches} rated matchup${elo!.rated_matches === 1 ? "" : "s"}` : "UNRATED · STARTING RATING"}</span>
          </div>
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "auto", paddingTop: 26, fontSize: 19 }}>
        <span>Self-attested. Private history stays private.</span>
        <span style={{ fontFamily: "DynaPuff", fontSize: 27, color: cobalt }}>What’s your score?</span>
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
