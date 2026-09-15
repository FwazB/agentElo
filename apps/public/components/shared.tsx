"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import type { EloMode, MatchReceipt, PlayerReceipt } from "../../../packages/public-api/types";

export const playerLabel = (username?: string | null) => username ? `@${username}` : "Player";
export const playerHref = (id: string, username?: string | null) => username ? `/u/${username}` : `/player/${id}`;
export const rating = (value: number) => (value / 1000).toFixed(3);
export const percent = (value: number) => `${Math.round(value / 10000)}%`;
export const delta = (value: number) => `${value > 0 ? "+" : ""}${rating(value)}`;

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    let message = response.status === 503 ? "The league is temporarily unavailable. Please try again shortly." : "We couldn’t complete that request. Please try again.";
    if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") message = body.error;
    throw new ApiError(message, response.status);
  }
  return body as T;
}

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export function Arrow({ diagonal = false }: { diagonal?: boolean }) {
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true"><path d={diagonal ? "M5 19 19 5M5 5h14v14" : "M4 12h15m-6-6 6 6-6 6"} stroke="currentColor" strokeWidth="1.6" /></svg>;
}

export function Mark({ large = false }: { large?: boolean }) {
  return <svg className={large ? "brand-mark large" : "brand-mark"} viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="M5 9h7v7h7v7h7v-7h7V9h3v23H5V9Z" fill="currentColor"/><path d="M19 5h7v11h-7V5Z" fill="currentColor"/></svg>;
}

export function Header({ action, onHelp, onConnect, onHome }: { action?: ReactNode; onHelp?: () => void; onConnect?: () => void; onHome?: () => void }) {
  return <header className="site-header"><Link className="brand" href="/" aria-label="Computer Elo home" onClick={event => { if (onHome) { event.preventDefault(); onHome(); } }}><span>computer<span className="brand-elo">elo</span></span></Link><nav aria-label="Main navigation"><Link className="nav-link" href="/#help" onClick={event => { if (onHelp) { event.preventDefault(); onHelp(); } }}>How to play</Link>{action}</nav></header>;
}

export function Footer({ onConnect }: { onConnect?: () => void } = {}) {
  return <footer className="site-footer"><span>Computer Elo · Self-attested weekly scores</span><Link className="text-link" href="/#connect" onClick={event => { if (onConnect) { event.preventDefault(); onConnect(); } }}>Connect your AI</Link></footer>;
}

export function ModeSwitch({ mode, onChange }: { mode: EloMode; onChange: (mode: EloMode) => void }) {
  return <details className="mode-details"><summary>{mode === "scalar" ? "Elo" : "Win / loss Elo"}<span aria-hidden="true">⌄</span></summary><div className="mode-panel"><p>Choose a rating mode</p><div className="mode-switch" aria-label="Rating mode"><button type="button" aria-pressed={mode === "scalar"} onClick={() => onChange("scalar")}>Elo <span>Form difference</span></button><button type="button" aria-pressed={mode === "binary"} onClick={() => onChange("binary")}>Win / loss <span>Form ordering</span></button></div><p>Each mode has its own rating.</p></div></details>;
}

export function ShareActions({ username, receipt, url }: { username: string | null; receipt: PlayerReceipt | null; url: string }) {
  if (!username) return null;
  const text = receipt ? `My AI rated my week ${receipt.form.score}/1000.\n${percent(receipt.form.confidence.effective_ppm)} confidence · ${receipt.week_id}.\nSelf-attested. What’s your score?` : `I’m @${username} on Computer Elo.\nWhat’s your score?`;
  return <div className="share-actions"><a className="button primary" href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`} target="_blank" rel="noopener noreferrer">Share on X <Arrow diagonal /></a><CopyButton value={url}>Copy profile link</CopyButton><a className="text-link" href={`/u/${username}/opengraph-image`} download={`computer-elo-${username}.png`}>Download card PNG <Arrow diagonal /></a></div>;
}

export function CopyButton({ value, children = "Copy", className = "button secondary small" }: { value: string; children?: ReactNode; className?: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try { await navigator.clipboard.writeText(value); setStatus("copied"); }
    catch { setStatus("failed"); }
  }
  return <span className="copy-control"><button type="button" className={className} onClick={() => void copy()}>{status === "copied" ? "Copied ✓" : children}</button>{status === "failed" && <span className="copy-error" role="status">Copy unavailable. Select and copy the text manually.</span>}</span>;
}

export function Notice({ children, kind = "error" }: { children: ReactNode; kind?: "error" | "info" }) {
  return <div className={`notice ${kind}`} role={kind === "error" ? "alert" : "status"}>{children}</div>;
}

export function ReceiptLinks({ receipt }: { receipt: PlayerReceipt; playerId: string }) {
  return <div className="inline-links"><a href={`/api/receipts/${encodeURIComponent(receipt.fingerprint)}`} download="computer-elo-receipt.json">Public receipt <Arrow diagonal /></a></div>;
}

export function MatchList({ matches, playerId, usernames = {}, onOpenProfile }: { matches: MatchReceipt[]; playerId?: string; usernames?: Record<string, string>; onOpenProfile?: (profile: { id: string; username?: string }) => void }) {
  if (matches.length === 0) return <div className="empty-state compact"><h3>The first matchup is still ahead.</h3><p>Completed matchups will appear here with replayable public receipts.</p></div>;
  return <div className="match-list">{matches.map(match => {
    const side = match.players.a.player_id === playerId ? "a" : match.players.b.player_id === playerId ? "b" : null;
    const self = side ? match.players[side] : null;
    return <article className="match-row" key={match.match_id}><div><div className="eyebrow">{match.players.a.week_id} <span className="dot-separator">·</span> {match.mode === "scalar" ? "Elo" : "Win / loss"}</div><div className="match-pair"><Link href={playerHref(match.players.a.player_id, usernames[match.players.a.player_id])} onClick={event => { if (onOpenProfile) { event.preventDefault(); onOpenProfile({ id: match.players.a.player_id, username: usernames[match.players.a.player_id] }); } }}>{playerLabel(usernames[match.players.a.player_id])}</Link><span className="muted">vs</span><Link href={playerHref(match.players.b.player_id, usernames[match.players.b.player_id])} onClick={event => { if (onOpenProfile) { event.preventDefault(); onOpenProfile({ id: match.players.b.player_id, username: usernames[match.players.b.player_id] }); } }}>{playerLabel(usernames[match.players.b.player_id])}</Link></div><span className="caption">Form {match.players.a.form_score} : {match.players.b.form_score}{match.rating_effect === "exhibition" ? ` · Exhibition (${match.exhibition_reasons.join(", ").replaceAll("_", " ")})` : " · Rated match"}</span></div><div className="match-result">{self && <strong className={self.applied_delta_milli > 0 ? "positive" : ""}>{delta(self.applied_delta_milli)} <small>Elo</small></strong>}<a className="text-link" href={`/api/matches/${match.match_id}/card.svg`} download="computer-elo-match.svg">Match card <Arrow diagonal /></a><a className="caption text-link" href={`/api/receipts/${encodeURIComponent(match.fingerprint)}`} download="match-receipt.json">Receipt</a></div></article>;
  })}</div>;
}
