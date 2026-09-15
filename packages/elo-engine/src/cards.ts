import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

import {
  type MatchReceipt,
  type PlayerReceipt,
  validateMatchReceipt,
  validatePlayerReceipt,
} from "./receipts.ts";

export class CardRenderError extends Error {
  override readonly name = "CardRenderError";
}

export function requirePngRenderer(): string {
  const result = spawnSync("rsvg-convert", ["--version"], { encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) {
    throw new CardRenderError("rsvg-convert from librsvg is required for PNG share cards");
  }
  return "rsvg-convert";
}

export function formatRating(ratingMilli: number): string {
  const sign = ratingMilli < 0 ? "-" : "";
  const absolute = Math.abs(ratingMilli);
  return `${sign}${Math.floor(absolute / 1000)}.${String(absolute % 1000).padStart(3, "0")}`;
}

export function formatDelta(deltaMilli: number): string {
  return `${deltaMilli >= 0 ? "+" : ""}${formatRating(deltaMilli)}`;
}

export function formatConfidence(confidencePpm: number): string {
  let whole = Math.floor(confidencePpm / 10_000);
  let decimal = Math.floor(((confidencePpm % 10_000) + 500) / 1000);
  if (decimal === 10) {
    whole += 1;
    decimal = 0;
  }
  return `${whole}.${decimal}%`;
}

function svgShell(body: string, title: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675" role="img" aria-label="${title}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#070d0a"/>
      <stop offset="1" stop-color="#142018"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#7CFF6B"/>
      <stop offset="1" stop-color="#36E4C3"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="675" fill="url(#bg)"/>
  <circle cx="1110" cy="60" r="190" fill="#7CFF6B" opacity=".06"/>
  <circle cx="60" cy="660" r="220" fill="#36E4C3" opacity=".04"/>
  <style>
    .sans { font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .white { fill: #F5FFF8; }
    .green { fill: #7CFF6B; }
    .muted { fill: #91A69B; }
  </style>
${body}
</svg>
`;
}

export function playerCardSvg(value: PlayerReceipt): string {
  const player = validatePlayerReceipt(value);
  const label = `PLAYER ${player.player_id.slice(-6).toUpperCase()}`;
  const confidence = player.form.confidence;
  const binary = player.elo.binary;
  const scalar = player.elo.scalar;
  const body = `  <text x="72" y="72" class="sans green" font-size="24" font-weight="800" letter-spacing="3">COMPUTER FORM + ELO</text>
  <text x="1128" y="72" class="sans muted" font-size="18" text-anchor="end">${player.week_id}</text>
  <line x1="72" y1="100" x2="1128" y2="100" stroke="#2B4435"/>
  <text x="72" y="165" class="sans white" font-size="29" font-weight="700">${label}</text>
  <text x="72" y="245" class="sans muted" font-size="20" letter-spacing="2">COMPUTER FORM</text>
  <text x="72" y="405" class="sans white" font-size="176" font-weight="900" letter-spacing="-8">${player.form.score}</text>
  <text x="430" y="390" class="sans muted" font-size="30">/1000</text>
  <rect x="650" y="170" width="478" height="145" rx="22" fill="#14291C" stroke="#31533B"/>
  <text x="686" y="215" class="sans muted" font-size="18">BINARY ELO</text>
  <text x="686" y="275" class="sans white" font-size="48" font-weight="850">${formatRating(binary.rating_milli)}</text>
  <text x="1088" y="275" class="sans muted" font-size="17" text-anchor="end">${binary.rated_matches} rated</text>
  <rect x="650" y="335" width="478" height="145" rx="22" fill="#14291C" stroke="#31533B"/>
  <text x="686" y="380" class="sans muted" font-size="18">SCALAR ELO</text>
  <text x="686" y="440" class="sans white" font-size="48" font-weight="850">${formatRating(scalar.rating_milli)}</text>
  <text x="1088" y="440" class="sans muted" font-size="17" text-anchor="end">${scalar.rated_matches} rated</text>
  <line x1="72" y1="530" x2="1128" y2="530" stroke="#2B4435"/>
  <text x="72" y="574" class="sans green" font-size="19" font-weight="800">NO RAW ACTIVITY OR PRIVATE EVIDENCE INCLUDED</text>
  <text x="72" y="612" class="sans muted" font-size="17">CONFIDENCE ${formatConfidence(confidence.effective_ppm)} · ${confidence.band.toUpperCase()} · EVIDENCE COVERAGE + CERTAINTY</text>
  <text x="1128" y="642" class="sans muted" font-size="14" text-anchor="end">${player.fingerprint.slice(-16)}</text>`;
  return svgShell(body, "Computer Form and Elo card");
}

export function matchCardSvg(value: MatchReceipt): string {
  const match = validateMatchReceipt(value);
  const a = match.players.a;
  const b = match.players.b;
  const rated = match.rating_effect === "rated";
  const header = `COMPUTER ELO · ${match.mode.toUpperCase()} · ${rated ? "RATED" : "EXHIBITION"}`;
  const status = rated
    ? `${formatDelta(a.applied_delta_milli)} / ${formatDelta(b.applied_delta_milli)} ELO`
    : "NO RATING CHANGE";
  const reason = rated
    ? "COMPATIBLE + SUPPORTED"
    : match.exhibition_reasons.map((item) => item.replaceAll("_", " ").toUpperCase()).join(" · ");
  const body = `  <text x="72" y="72" class="sans green" font-size="24" font-weight="800" letter-spacing="3">${header}</text>
  <text x="1128" y="72" class="sans muted" font-size="18" text-anchor="end">K=${match.calculation.k}</text>
  <line x1="72" y1="100" x2="1128" y2="100" stroke="#2B4435"/>
  <text x="300" y="170" class="sans white" font-size="28" font-weight="700" text-anchor="middle">PLAYER ${a.player_id.slice(-6).toUpperCase()}</text>
  <text x="900" y="170" class="sans white" font-size="28" font-weight="700" text-anchor="middle">PLAYER ${b.player_id.slice(-6).toUpperCase()}</text>
  <text x="300" y="325" class="sans white" font-size="112" font-weight="900" text-anchor="middle">${formatRating(a.rating_after_milli)}</text>
  <text x="900" y="325" class="sans white" font-size="112" font-weight="900" text-anchor="middle">${formatRating(b.rating_after_milli)}</text>
  <text x="300" y="375" class="sans muted" font-size="22" text-anchor="middle">FORM ${a.form_score} · CONF ${formatConfidence(a.confidence_ppm)}</text>
  <text x="900" y="375" class="sans muted" font-size="22" text-anchor="middle">FORM ${b.form_score} · CONF ${formatConfidence(b.confidence_ppm)}</text>
  <text x="600" y="285" class="sans muted" font-size="42" font-weight="800" text-anchor="middle">VS</text>
  <rect x="370" y="425" width="460" height="68" rx="34" fill="#7CFF6B" opacity=".12" stroke="#7CFF6B"/>
  <text x="600" y="469" class="sans green" font-size="25" font-weight="900" text-anchor="middle">${status}</text>
  <line x1="72" y1="530" x2="1128" y2="530" stroke="#2B4435"/>
  <text x="72" y="574" class="sans green" font-size="19" font-weight="800">NO RAW ACTIVITY OR PRIVATE EVIDENCE INCLUDED</text>
  <text x="72" y="612" class="sans muted" font-size="16">${reason}</text>
  <text x="1128" y="642" class="sans muted" font-size="14" text-anchor="end">${match.fingerprint.slice(-16)}</text>`;
  return svgShell(body, "Computer Elo match card");
}

export function renderPng(svgPath: string, pngPath: string): void {
  const renderer = requirePngRenderer();
  const result = spawnSync(renderer, ["-w", "1200", "-h", "675", "-o", pngPath, svgPath], { encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) {
    throw new CardRenderError(result.stderr.trim() || "PNG rendering failed");
  }
}

export function writeCard(svgPath: string, pngPath: string, svg: string): void {
  writeFileSync(svgPath, svg, "utf8");
  renderPng(svgPath, pngPath);
}
