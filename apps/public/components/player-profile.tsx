"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { EloMode, PlayerView } from "../../../packages/public-api/types";
import { api, ApiError, Arrow, AssessmentContextCaption, Footer, Header, MatchList, ModeSwitch, Notice, percent, playerHref, playerLabel, rating, ReceiptLinks, ShareActions } from "./shared";

interface ProfileNavigation {
  embedded?: boolean;
  onOpenProfile?: (profile: { id: string; username?: string }) => void;
  onHelp?: () => void;
}

export function UserProfile({ username, embedded = false, onOpenProfile, onHelp }: { username: string } & ProfileNavigation) {
  return <Profile endpoint={`/users/${encodeURIComponent(username)}`} valid={/^[a-z][a-z0-9_]{2,19}$/.test(username)} embedded={embedded} onOpenProfile={onOpenProfile} onHelp={onHelp} />;
}

export function PlayerProfile({ id, embedded = false, onOpenProfile, onHelp }: { id: string } & ProfileNavigation) {
  return <Profile endpoint={`/players/${id}`} valid={/^p_[0-9a-f]{32}$/.test(id)} embedded={embedded} onOpenProfile={onOpenProfile} onHelp={onHelp} />;
}

function Profile({ endpoint, valid, embedded, onOpenProfile, onHelp }: { endpoint: string; valid: boolean; embedded: boolean } & ProfileNavigation) {
  const [data, setData] = useState<PlayerView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<EloMode>("scalar");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!valid) { setError("This player could not be found."); setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true); setError(null);
    api<PlayerView>(endpoint, { signal: controller.signal }).then(next => { if (!controller.signal.aborted) setData(next); }).catch(error => {
      if (!controller.signal.aborted) setError(error instanceof ApiError && error.status === 404 ? "This player could not be found." : error instanceof Error ? error.message : "Unable to load this player.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [endpoint, valid, attempt]);
  const receipt = data?.player.receipt;
  const state = receipt?.elo[mode];
  const matches = data?.matches.filter(match => match.mode === mode) ?? [];
  const Container = embedded ? "section" : "main";
  const Heading = embedded ? "h2" : "h1";
  const MatchHeading = embedded ? "h3" : "h2";
  return <>
    {!embedded && <Header action={<Link className="button nav-button" href="/">Get your score <Arrow /></Link>}/>}
    <Container id={embedded ? undefined : "main"} className={embedded ? "profile-page profile-embedded" : "shell profile-page"}>
      {!embedded && <Link className="text-link back-link" href="/#leaderboard"><span aria-hidden="true">←</span> The league</Link>}
      {loading ? <div className="empty-state profile-loading" role="status"><span className="loading-mark"/><p>Loading player…</p></div> : error ? <div className="profile-error"><Heading>Player unavailable.</Heading><Notice>{error}</Notice><button className="button secondary" onClick={() => setAttempt(value => value + 1)}>Try again</button></div> : data && <>
        <div className="profile-heading"><div><div className="eyebrow">COMPUTER ELO / PUBLIC PROFILE</div><Heading>{playerLabel(data.player.username)}</Heading><span className="pill light">Self-attested · Open league</span></div><span className="profile-week mono">{receipt?.week_id ?? "FIRST WEEK AHEAD"}</span></div>
        <div className="profile-scoreboard">
          <div className="profile-rating form-primary"><div className="eyebrow">COMPUTER FORM</div><div className="profile-elo">{receipt?.form.score ?? "—"}<small> / 1000</small></div><p>Your week at the computer, assessed with the shared rubric.</p><AssessmentContextCaption context={data.player.assessmentContext}/><div className="profile-meta"><div><span>Confidence</span><strong>{receipt ? percent(receipt.form.confidence.effective_ppm) : "—"}</strong></div>{receipt && <><div><span>Evidence coverage</span><strong>{percent(receipt.form.confidence.coverage_ppm)}</strong></div><div><span>Evaluator certainty</span><strong>{percent(receipt.form.confidence.certainty_ppm)}</strong></div></>}</div></div>
          <div className="profile-form"><div className="profile-rating-top"><div className="eyebrow">COMPUTER ELO</div><ModeSwitch mode={mode} onChange={setMode}/></div><div className="profile-form-score">{rating(state?.rating_milli ?? 1200000)}</div><div className="mono caption">{state?.rated_matches ? `${state.rated_matches} rated matchups` : "Unrated · Starting rating"}</div><p className="caption profile-elo-explanation">{state?.rated_matches ? "A rating built through weekly matchups." : "Your first rated matchup is where your Elo story begins. Your weekly Form is already yours to share."}</p></div>
        </div>
        <div className="profile-sharing"><div><h3>Your week, on the record.</h3><p className="caption">Share your public profile. Your private computer history stays private.</p></div><ShareActions username={data.player.username} receipt={receipt ?? null}/></div>
        {receipt ? <div className="profile-downloads"><ReceiptLinks receipt={receipt} playerId={data.player.id}/><span className="caption">Public aggregate only.</span></div> : <Notice kind="info">This player hasn’t published a weekly Form yet.</Notice>}
        <section className="profile-matches" aria-labelledby="matches-title"><div className="subsection-heading"><MatchHeading id="matches-title">Matchups</MatchHeading><span className="mono caption">{matches.length} completed</span></div><MatchList matches={matches} playerId={data.player.id} usernames={data.usernames} onOpenProfile={onOpenProfile}/></section>
        <div className="profile-note"><strong>A score with context.</strong><p>Form reflects one week. Elo reflects matchups. Confidence reflects the limits of the evidence. Scores are self-attested; receipt fingerprints verify integrity, not evaluator truth.</p><Link className="text-link" href={embedded ? "#help" : "/kit"} onClick={event => { if (onHelp && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onHelp(); } }}>How scoring works <Arrow diagonal /></Link></div>
      </>}
    </Container>{!embedded && <Footer/>}
  </>;
}
