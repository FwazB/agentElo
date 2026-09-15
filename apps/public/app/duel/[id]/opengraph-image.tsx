import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import type { DuelPlayerStats } from "../../../../../packages/public-api/antislop";
import { getPublicDuel } from "../../../lib/public-duel";
export const runtime = "nodejs";
export const alt = "AntiSlop duel result. Shared referee pilot; no Elo change.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
const fonts = Promise.all(["dynapuff-bold.ttf", "dm-sans-regular.ttf", "dm-sans-bold.ttf"].map(file => readFile(join(process.cwd(), "public/fonts", file))));

function PlayerStats({ stats }: { stats: DuelPlayerStats | undefined }) {
  const form = stats?.formScore == null ? "Not scored yet" : `${Number((stats.formScore / 10).toFixed(1))}/100`;
  return <div style={{ display: "flex", justifyContent: "center", alignItems: "flex-end", marginTop: 14 }}>
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
      <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "1px", marginBottom: 4 }}>CURRENT FORM</span>
      <span style={{ fontSize: stats?.formScore == null ? 18 : 26, fontWeight: 700 }}>{form}</span>
    </div>
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginLeft: 34 }}>
      <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "1px", marginBottom: 4 }}>CURRENT ELO</span>
      <span style={{ fontSize: 26, fontWeight: 700 }}>{stats ? Math.round(stats.ratingMilli / 1000) : "—"}</span>
    </div>
  </div>;
}

export default async function DuelImage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const duel = await getPublicDuel(id);
  if (!duel) return new Response("Duel not found", { status: 404 });
  const [display, body, bold] = await fonts;
  const headline = duel.state === "pending" || duel.state === "judging" ? "the challenge is on." : duel.outcome === "draw" ? "good work. both sides." : duel.outcome === "unrated" ? "this one stays unrated." : "the work has spoken.";
  const result = duel.state === "pending" || duel.state === "judging" ? "Awaiting the referee" : duel.outcome === "draw" ? "DRAW" : duel.outcome === "a_wins" ? `@${duel.a.username ?? "player"} WINS` : duel.outcome === "b_wins" ? `@${duel.b.username ?? "player"} WINS` : "UNRATED";
  return new ImageResponse(<div style={{ width: "100%", height: "100%", background: "#fff9e9", color: "#292730", display: "flex", flexDirection: "column", padding: "40px 58px", fontFamily: "DM Sans" }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <div style={{ display: "flex", alignItems: "center", fontFamily: "DynaPuff", fontWeight: 700, fontSize: 34, letterSpacing: "-2px" }}><span>antislop.</span><svg width="38" height="38" viewBox="0 0 40 40" style={{ marginLeft: 12 }}><path d="M20 3L25 13L37 12L30 22L35 33L22 30L13 38L12 25L2 19L14 14Z" fill="#ffe34f" stroke="#292730" strokeWidth="2.5" strokeLinejoin="round" /></svg></div>
      <div style={{ display: "flex", border: "3px solid #292730", borderRadius: 9, background: "#ffe34f", padding: "10px 16px", boxShadow: "4px 4px 0 #292730", transform: "rotate(2deg)", fontSize: 18, fontWeight: 700, letterSpacing: "1px" }}>SHARED REFEREE · PILOT</div>
    </div>
    <div style={{ display: "flex", justifyContent: "center", fontFamily: "DynaPuff", fontWeight: 700, fontSize: 55, lineHeight: 1.15, letterSpacing: "-2px", marginTop: 32, textAlign: "center" }}>{headline}</div>
    <div style={{ display: "flex", position: "relative", justifyContent: "space-between", alignItems: "center", marginTop: 28, height: 202 }}>
      <div style={{ display: "flex", width: 462, height: 194, padding: "16px 26px", flexDirection: "column", alignItems: "center", justifyContent: "center", border: "4px solid #292730", borderRadius: 18, background: "#83e5ed", boxShadow: "6px 6px 0 #292730", transform: "rotate(-3deg)" }}>
        <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: "1px", marginBottom: 8 }}>SEVEN DAYS OF WORK</span>
        <span style={{ fontSize: (duel.a.username?.length ?? 6) > 16 ? 22 : 31, fontWeight: 700 }}>@{duel.a.username ?? "player"}</span>
        <PlayerStats stats={duel.playerStats?.a} />
      </div>
      <div style={{ display: "flex", width: 462, height: 194, padding: "16px 26px", flexDirection: "column", alignItems: "center", justifyContent: "center", border: "4px solid #292730", borderRadius: 18, background: "#f6a1d1", boxShadow: "6px 6px 0 #292730", transform: "rotate(3deg)" }}>
        <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: "1px", marginBottom: 8 }}>SEVEN DAYS OF WORK</span>
        <span style={{ fontSize: (duel.b.username?.length ?? 6) > 16 ? 22 : 31, fontWeight: 700 }}>@{duel.b.username ?? "player"}</span>
        <PlayerStats stats={duel.playerStats?.b} />
      </div>
      <div style={{ display: "flex", position: "absolute", left: 489, top: 46, width: 106, height: 106, alignItems: "center", justifyContent: "center", background: "#ffe34f", border: "4px solid #292730", borderRadius: 60, boxShadow: "5px 5px 0 #292730", transform: "rotate(-8deg)", fontFamily: "DynaPuff", fontWeight: 700, fontSize: 47, letterSpacing: "-3px" }}>VS</div>
    </div>
    <div style={{ display: "flex", alignSelf: "center", marginTop: 28, border: "3px solid #292730", borderRadius: 11, background: "#ff9a57", boxShadow: "5px 5px 0 #292730", padding: "12px 25px", fontSize: 28, fontWeight: 700, transform: "rotate(-1deg)" }}>{result}</div>
    <div style={{ display: "flex", justifyContent: "space-between", marginTop: "auto", paddingTop: 19, borderTop: "3px solid #292730", fontSize: 20 }}><span>Submitted evidence · no Elo change</span><span style={{ fontWeight: 700 }}>antislop.org</span></div>
  </div>, { ...size, fonts: [{ name: "DynaPuff", data: display!, weight: 700, style: "normal" }, { name: "DM Sans", data: body!, weight: 400, style: "normal" }, { name: "DM Sans", data: bold!, weight: 700, style: "normal" }], headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
