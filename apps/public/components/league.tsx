"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import type { EloMode, Me, Overview, PlayerReceipt, QueueResult } from "../../../packages/public-api/types";
import { buildAssessmentPrompt, parseAssessmentResult, type AssessmentScore, type InsufficientEvidence } from "../../../packages/public-api/scoring-guide";
import { api, ApiError, Arrow, AssessmentContextCaption, CopyButton, Footer, Header, MatchList, ModeSwitch, Notice, percent, rating, ReceiptLinks, ShareActions, playerHref, playerLabel } from "./shared";
import { PlayerProfile, UserProfile } from "./player-profile";

type DialogView = "join" | "recover" | "key" | "rate" | "share" | "matches" | "account" | "help" | "connect" | "profile";
type ProfileTarget = { username?: string; id?: string };
export interface LeagueProps { initialDialog?: "connect" | "help" | "rate"; initialProfile?: ProfileTarget }

const RUBRIC = [
  ["Output & closure", "Useful things, finished.", 30],
  ["Focus & attention", "Intentional time, fewer detours.", 25],
  ["Workflow leverage", "Make your tools work for you.", 20],
  ["Verification discipline", "Check that it actually worked.", 15],
  ["Operational hygiene", "Leave things clear and recoverable.", 10],
] as const;

function message(error: unknown) { return error instanceof Error ? error.message : "Something went wrong. Please try again."; }
function scrollBehavior(): ScrollBehavior { return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"; }

function previewReceipt(value: unknown, weekId: string): PlayerReceipt {
  const exact = (v: unknown, names: string[], label: string): Record<string, unknown> => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${label} must be an object.`);
    const record = v as Record<string, unknown>;
    if (Object.keys(record).sort().join("|") !== names.sort().join("|")) throw new Error(`${label} contains unexpected or missing fields. Use a public receipt from the scoring kit; do not upload your private assessment.`);
    return record;
  };
  const r = exact(value, ["canonical_json_profile", "competition_id", "elo", "fingerprint", "form", "parent_fingerprint", "player_id", "privacy", "protocol_version", "receipt_type", "schema_version", "week_id"], "Receipt");
  if (r.receipt_type !== "player" || typeof r.player_id !== "string" || !/^p_[0-9a-f]{32}$/.test(r.player_id) || typeof r.competition_id !== "string" || !/^c_[0-9a-f]{32}$/.test(r.competition_id)) throw new Error("This must be a public player receipt with valid opaque player and competition IDs.");
  if (r.week_id !== weekId) throw new Error(`The league is accepting ${weekId}. Generate a receipt for that completed week.`);
  const form = exact(r.form, ["confidence", "score", "version"], "Form");
  if (!Number.isInteger(form.score) || (form.score as number) < 1 || (form.score as number) > 1000) throw new Error("Computer Form must be an integer from 1 to 1000.");
  const confidence = exact(form.confidence, ["band", "certainty_ppm", "coverage_ppm", "effective_ppm", "version"], "Confidence");
  for (const name of ["certainty_ppm", "coverage_ppm", "effective_ppm"]) if (!Number.isInteger(confidence[name]) || (confidence[name] as number) < 0 || (confidence[name] as number) > 1000000) throw new Error("Confidence values must be integers from 0 to 1,000,000.");
  if (confidence.effective_ppm !== Math.min(confidence.coverage_ppm as number, confidence.certainty_ppm as number)) throw new Error("Effective confidence must be the lower of coverage and certainty.");
  const privacy = exact(r.privacy, ["private_evidence_included", "raw_activity_included"], "Privacy");
  if (privacy.private_evidence_included !== false || privacy.raw_activity_included !== false) throw new Error("Only public aggregate receipts are accepted. Keep your computer history private.");
  const elo = exact(r.elo, ["binary", "scalar"], "Elo");
  const isFingerprint = (value: unknown) => typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
  for (const mode of ["binary", "scalar"]) {
    const state = exact(elo[mode], ["formula_version", "last_match_fingerprint", "rated_matches", "rating_milli"], "Elo state");
    if (state.formula_version !== (mode === "scalar" ? "computer-elo.scalar-tanh200.v1" : "computer-elo.binary.v1") || !Number.isSafeInteger(state.rating_milli) || !Number.isSafeInteger(state.rated_matches) || (state.rated_matches as number) < 0 || (state.last_match_fingerprint !== null && !isFingerprint(state.last_match_fingerprint))) throw new Error("Elo fields must contain only the versioned public rating state from the scoring kit.");
  }
  if (r.parent_fingerprint !== null && !isFingerprint(r.parent_fingerprint)) throw new Error("Invalid parent receipt fingerprint.");
  if (!["low", "medium", "high"].includes(confidence.band as string)) throw new Error("Invalid confidence band.");
  if (typeof r.fingerprint !== "string" || !/^sha256:[0-9a-f]{64}$/.test(r.fingerprint)) throw new Error("The receipt needs a valid SHA-256 fingerprint from the scoring kit.");
  if (r.schema_version !== "1.0.0" || r.protocol_version !== "computer-elo.protocol.v1" || r.canonical_json_profile !== "cej-ascii-integer.v1" || form.version !== "computer-form.general.v1" || confidence.version !== "computer-confidence.coverage-certainty-min.v1") throw new Error("This receipt uses an unsupported version. Generate it with the current scoring kit.");
  return value as PlayerReceipt;
}

export function League({ initialDialog, initialProfile }: LeagueProps = {}) {
  const [mode, setMode] = useState<EloMode>("scalar");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<Me | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogView | null>(initialProfile ? "profile" : initialDialog ?? null);
  const [profileTarget, setProfileTarget] = useState<ProfileTarget | null>(initialProfile ?? null);
  const [recoveryKey, setRecoveryKey] = useState("");
  const [keyAction, setKeyAction] = useState<"create" | "rotate">("create");
  const [keyUsername, setKeyUsername] = useState("");
  const [keyAttempted, setKeyAttempted] = useState(false);
  const [saved, setSaved] = useState(false);
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");
  const [assessmentText, setAssessmentText] = useState("");
  const [assessmentPreview, setAssessmentPreview] = useState<AssessmentScore | null>(null);
  const [includeAssessmentContext, setIncludeAssessmentContext] = useState(true);
  const [insufficientEvidence, setInsufficientEvidence] = useState<InsufficientEvidence | null>(null);
  const [preview, setPreview] = useState<PlayerReceipt | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [origin, setOrigin] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const lastFocusRef = useRef<HTMLElement | null>(null);
  const overviewRequestRef = useRef<AbortController | null>(null);
  const meRequestRef = useRef<AbortController | null>(null);
  const sessionEpochRef = useRef(0);
  const draftReadRef = useRef(0);
  const mountedRef = useRef(true);
  const currentModeRef = useRef(mode);
  const navigationBlockedRef = useRef(false);
  currentModeRef.current = mode;
  navigationBlockedRef.current = dialog === "key" || busy !== null;
  const dialogIsOpen = dialog !== null;

  useEffect(() => setOrigin(window.location.origin), []);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      overviewRequestRef.current?.abort(); meRequestRef.current?.abort();
      sessionEpochRef.current++; draftReadRef.current++;
    };
  }, []);
  useEffect(() => {
    if (!dialogIsOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [dialogIsOpen]);
  useEffect(() => {
    if (navigationBlockedRef.current) return;
    if (initialProfile?.username || initialProfile?.id) {
      setProfileTarget({ username: initialProfile.username, id: initialProfile.id });
      setDialog("profile");
    } else if (initialDialog) setDialog(initialDialog);
  }, [initialProfile?.username, initialProfile?.id, initialDialog]);
  useEffect(() => {
    const match = window.location.hash.slice(1);
    if (["connect", "help", "rate", "share", "matches", "account"].includes(match)) setDialog(match as DialogView);
  }, []);
  useEffect(() => {
    const handleHash = () => {
      if (dialog === "key" || busy) return;
      const match = window.location.hash.slice(1);
      if (["connect", "help", "rate", "share", "matches", "account"].includes(match)) setDialog(match as DialogView);
    };
    window.addEventListener("hashchange", handleHash);
    return () => window.removeEventListener("hashchange", handleHash);
  }, [dialog, busy]);
  const loadOverview = useCallback(async (requestedMode: EloMode) => {
    if (!mountedRef.current || requestedMode !== currentModeRef.current) return;
    overviewRequestRef.current?.abort();
    const controller = new AbortController(); overviewRequestRef.current = controller;
    try {
      const next = await api<Overview>(`/overview?mode=${requestedMode}`, { signal: controller.signal });
      if (!controller.signal.aborted && mountedRef.current && requestedMode === currentModeRef.current) { setOverview(next); setOverviewError(null); }
    } catch (error) { if (!controller.signal.aborted && mountedRef.current) setOverviewError(message(error)); }
    finally { if (!controller.signal.aborted && mountedRef.current) setLoading(false); }
  }, []);
  useEffect(() => {
    setLoading(true); setOverviewError(null); setOverview(null);
    void loadOverview(mode);
    return () => overviewRequestRef.current?.abort();
  }, [mode, loadOverview]);
  const refreshMe = useCallback(async () => {
    if (!mountedRef.current) return null;
    meRequestRef.current?.abort();
    const controller = new AbortController(); meRequestRef.current = controller;
    const epoch = sessionEpochRef.current;
    try {
      const current = await api<Me>("/me", { signal: controller.signal });
      if (controller.signal.aborted || !mountedRef.current || epoch !== sessionEpochRef.current) return null;
      setMe(current); setSessionError(null); return current;
    } catch (error) {
      if (controller.signal.aborted || !mountedRef.current || epoch !== sessionEpochRef.current) return null;
      if (error instanceof ApiError && error.status === 401) { setMe(null); setSessionError(null); return null; } throw error;
    }
  }, []);
  useEffect(() => {
    let alive = true;
    refreshMe().catch(error => { if (alive) setSessionError(message(error)); }).finally(() => { if (alive) setSessionLoading(false); });
    return () => { alive = false; meRequestRef.current?.abort(); };
  }, [refreshMe]);
  const refreshOverview = useCallback(() => loadOverview(mode), [mode, loadOverview]);

  const queueKey = me?.queue.map(item => `${item.mode}:${item.weekId}`).join("|") ?? "";
  const accountId = me?.player.id;
  useEffect(() => {
    if (!queueKey) return;
    let alive = true;
    let pending: AbortController | null = null;
    const interval = window.setInterval(async () => {
      if (pending) return;
      const controller = new AbortController(); pending = controller;
      const epoch = sessionEpochRef.current;
      try {
        const current = await api<Me>("/me", { signal: controller.signal });
        if (!alive || controller.signal.aborted || epoch !== sessionEpochRef.current) return;
        setMe(current); setActionError(null);
        if (current.queue.map(item => `${item.mode}:${item.weekId}`).join("|") !== queueKey) {
          setFeedback("Your queue status changed. Open Matchups for the latest result.");
          void refreshOverview();
        }
      } catch (error) { if (alive && !controller.signal.aborted && epoch === sessionEpochRef.current) setActionError(`Couldn’t refresh your matchup: ${message(error)}`); }
      finally { if (pending === controller) pending = null; }
    }, 15000);
    return () => { alive = false; pending?.abort(); window.clearInterval(interval); };
  }, [queueKey, accountId, refreshOverview]);

  useEffect(() => {
    const element = dialogRef.current;
    if (dialog && element && !element.open) {
      lastFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      element.showModal();
    }
    if (!dialog && element?.open) element.close();
    if (dialog) {
      const frame = requestAnimationFrame(() => {
        if (!element) return;
        element.scrollTop = 0;
        element.querySelector<HTMLElement>("#dialog-title")?.focus({ preventScroll: true });
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [dialog]);

  function openDialog(view: DialogView) {
    if (dialog === "key" || busy) return;
    setActionError(null); setDialog(view);
  }
  function closeDialog() {
    if (dialog === "key" || busy) return;
    setDialog(null); setActionError(null);
    if (window.location.hash && window.location.hash !== "#leaderboard") window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  }
  function openProfile(profile: ProfileTarget) {
    if (dialog === "key" || busy) return;
    setProfileTarget(profile); setDialog("profile");
  }
  function join() {
    setActionError(null);
    openDialog(me ? "rate" : "join");
  }
  function commitMe(player: Me | null) {
    if (!mountedRef.current) return;
    sessionEpochRef.current++; meRequestRef.current?.abort(); setMe(player);
  }
  function prepareKey(action: "create" | "rotate") {
    if (recoveryKey && action === keyAction && (action === "rotate" || username === keyUsername)) {
      setActionError(null); setDialog("key"); return;
    }
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    setRecoveryKey(Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join(""));
    setKeyAction(action); setKeyUsername(username); setKeyAttempted(false); setSaved(false); setActionError(null); setDialog("key");
  }
  function finishKeyAction(player: Me, feedback: string) {
    draftReadRef.current++;
    commitMe(player); setSessionError(null); setDialog(keyAction === "rotate" ? "account" : "rate"); setRecoveryKey(""); setFeedback(feedback);
    void refreshOverview();
  }
  async function createPlayer() {
    if (!/^[a-z][a-z0-9_]{2,19}$/.test(username) || !saved || !/^[0-9a-f]{64}$/.test(recoveryKey)) return;
    setBusy("create"); setActionError(null); setKeyAttempted(true);
    try {
      const result = await api<Me & { recoveryKey: string }>("/players", { method: "POST", body: JSON.stringify({ username, token: recoveryKey }) });
      const { recoveryKey: _key, ...player } = result;
      finishKeyAction(player, "Your profile is ready. Get your first weekly score below.");
    } catch (error) { setActionError(message(error)); }
    finally { setBusy(null); }
  }
  async function recover(event: FormEvent) {
    event.preventDefault(); setBusy("recover"); setActionError(null);
    try {
      draftReadRef.current++;
      commitMe(await api<Me>("/session", { method: "POST", body: JSON.stringify({ token: token.trim() }) }));
      setToken(""); setRecoveryKey(""); setKeyAttempted(false); setDialog("rate"); setSessionError(null);
    } catch (error) { setActionError(message(error)); }
    finally { setBusy(null); }
  }
  async function signOut() {
    setBusy("signout"); setActionError(null);
    try { await api("/session", { method: "DELETE" }); draftReadRef.current++; commitMe(null); setDialog(null); setPreview(null); setAssessmentPreview(null); setInsufficientEvidence(null); setAssessmentText(""); setUsername(""); setRecoveryKey(""); setKeyAttempted(false); setSaved(false); setFeedback(null); }
    catch (error) { setActionError(message(error)); }
    finally { setBusy(null); }
  }
  async function readFile(event: ChangeEvent<HTMLInputElement>) {
    const revision = ++draftReadRef.current;
    setPreview(null); setAssessmentPreview(null); setIncludeAssessmentContext(true); setInsufficientEvidence(null); setFileError(null); setFeedback(null);
    const file = event.target.files?.[0];
    if (!file || !me || !overview) return;
    try {
      if (!file.name.toLowerCase().endsWith(".json")) throw new Error("Choose the public player .json receipt from your assessment.");
      if (file.size > 16384) throw new Error("This file is too large. Public receipts must be 16 KB or less. Don’t upload private history.");
      const candidate = previewReceipt(JSON.parse(await file.text()) as unknown, overview.weekId);
      if (revision !== draftReadRef.current || !mountedRef.current) return;
      if (candidate.form.confidence.coverage_ppm === 0 || candidate.form.confidence.certainty_ppm === 0) throw new Error("No score yet: coverage and certainty must be above zero. Try an existing chat or AI with relevant context.");
      setPreview(candidate);
    } catch (error) { if (revision === draftReadRef.current && mountedRef.current) setFileError(error instanceof SyntaxError ? "This file is not valid JSON. Choose the player receipt produced by the scoring kit." : message(error)); }
    if (revision === draftReadRef.current) event.target.value = "";
  }
  async function publish() {
    if (insufficientEvidence || (!preview && !assessmentPreview)) return;
    setBusy("publish"); setActionError(null);
    try {
      const payload = assessmentPreview ? {
        weekId: assessmentPreview.weekId,
        formScore: assessmentPreview.formScore,
        coveragePpm: assessmentPreview.coveragePpm,
        certaintyPpm: assessmentPreview.certaintyPpm,
        ...(includeAssessmentContext && assessmentPreview.aiSystem !== undefined && assessmentPreview.contextSource !== undefined
          ? { aiSystem: assessmentPreview.aiSystem, contextSource: assessmentPreview.contextSource } : {}),
      } : { receipt: preview };
      commitMe(await api<Me>(assessmentPreview ? "/assessment" : "/form", { method: "POST", body: JSON.stringify(payload) }));
      draftReadRef.current++;
      setPreview(null); setAssessmentPreview(null); setInsufficientEvidence(null); setAssessmentText(""); setIncludeAssessmentContext(true); setFeedback("Your Form is published. Share your week, or join a matchup."); setDialog("share");
      void refreshOverview();
    } catch (error) { setActionError(message(error)); }
    finally { setBusy(null); }
  }
  async function queue(cancel = false) {
    setBusy("queue"); setActionError(null); setFeedback(null);
    try {
      if (cancel) { await api(`/queue?mode=${mode}`, { method: "DELETE" }); setFeedback("You have left the matchup queue."); }
      else {
        const result = await api<QueueResult>("/queue", { method: "POST", body: JSON.stringify({ mode }) });
        setFeedback(result.status === "matched" ? "Matchup complete. Your result is below." : "You’re in. We’ll match you with an eligible player from the same week.");
      }
      sessionEpochRef.current++; await refreshMe(); void refreshOverview();
    } catch (error) { setActionError(message(error)); }
    finally { setBusy(null); }
  }

  async function claimUsername(event: FormEvent) {
    event.preventDefault(); setBusy("username"); setActionError(null);
    try { commitMe(await api<Me>("/username", { method: "POST", body: JSON.stringify({ username }) })); void refreshOverview(); }
    catch (error) { setActionError(message(error)); }
    finally { setBusy(null); }
  }
  async function rotateKey() {
    if (!saved || !/^[0-9a-f]{64}$/.test(recoveryKey)) return;
    setBusy("rotate"); setActionError(null); setKeyAttempted(true);
    try {
      const result = await api<Me & { recoveryKey: string }>("/session/rotate", { method: "POST", body: JSON.stringify({ replacementToken: recoveryKey }) });
      const { recoveryKey: _key, ...player } = result;
      finishKeyAction(player, "Your recovery key has been replaced. The old key no longer works.");
    } catch (error) { setActionError(message(error)); }
    finally { setBusy(null); }
  }
  async function recoverPreparedKey() {
    setBusy("key-recover"); setActionError(null);
    try { finishKeyAction(await api<Me>("/session", { method: "POST", body: JSON.stringify({ token: recoveryKey }) }), "Signed in with your saved key."); }
    catch (error) { setActionError(message(error)); }
    finally { setBusy(null); }
  }
  function reviewAssessment() {
    draftReadRef.current++;
    setFileError(null); setPreview(null); setAssessmentPreview(null); setIncludeAssessmentContext(true); setInsufficientEvidence(null); setFeedback(null);
    try {
      if (new TextEncoder().encode(assessmentText).length > 16384) throw new Error("Paste only the small score JSON, not your private assessment or history.");
      const cleaned = assessmentText.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```$/, "").trim();
      const value: unknown = JSON.parse(cleaned);
      if (!overview) throw new Error("Refresh the league to load the current completed week.");
      const result = parseAssessmentResult(value, overview.weekId);
      if ("status" in result) setInsufficientEvidence(result);
      else setAssessmentPreview(result);
    } catch (error) { setFileError(error instanceof SyntaxError ? "That isn’t valid result JSON. Paste only the small JSON object from your agent’s response." : message(error)); }
  }

  const receipt = me?.player.receipt;
  const queued = me?.queue.some(item => item.mode === mode) ?? false;
  const currentReceipt = receipt?.week_id === overview?.weekId;
  const matchedThisWeek = me?.matches.some(match => match.mode === mode && match.players.a.week_id === overview?.weekId) ?? false;
  const locked = me?.formLocked ?? false;
  const assessmentPrompt = overview ? buildAssessmentPrompt(overview.weekId) : "";
  const assessmentContext = assessmentPreview?.aiSystem !== undefined && assessmentPreview.contextSource !== undefined
    ? { aiSystem: assessmentPreview.aiSystem, contextSource: assessmentPreview.contextSource } : undefined;
  const draft = insufficientEvidence ? null : assessmentPreview ?? (preview ? { weekId: preview.week_id, formScore: preview.form.score, coveragePpm: preview.form.confidence.coverage_ppm, certaintyPpm: preview.form.confidence.certainty_ppm } : null);
  const profileUrl = me ? `${origin}${playerHref(me.player.id, me.player.username)}` : "";
  const nameValid = /^[a-z][a-z0-9_]{2,19}$/.test(username);

  const needsUsername = me && !me.player.username;
  const usernameForm = <form className="claim-username" onSubmit={event => void claimUsername(event)}><h3>Pick your player name.</h3><p>Your score deserves a name. This becomes your permanent public profile address.</p><label className="field-label" htmlFor="claim-username">Username</label><div className="username-input"><span aria-hidden="true">@</span><input id="claim-username" value={username} onChange={event => setUsername(event.target.value.toLowerCase().replace(/^@/, ""))} pattern="[a-z][a-z0-9_]{2,19}" minLength={3} maxLength={20} autoComplete="username" autoCapitalize="none" spellCheck={false} required aria-describedby="claim-name-help"/></div><p id="claim-name-help" className="caption">3–20 lowercase letters, numbers, or underscores. Start with a letter. Your username is permanent.</p><button className="button primary" disabled={busy !== null || !nameValid}>{busy === "username" ? "Saving…" : "That’s my name"}<Arrow/></button></form>;
  const wideDialog = dialog && ["rate", "profile", "share", "matches", "help", "connect"].includes(dialog);

  return <>
    <Header onHelp={() => openDialog("help")} onConnect={() => openDialog("connect")} onHome={() => { closeDialog(); window.scrollTo({ top: 0, behavior: scrollBehavior() }); }} action={<button className="nav-link account-link" onClick={() => me ? openDialog("account") : join()} disabled={sessionLoading}>{sessionLoading ? "One sec…" : me ? playerLabel(me.player.username) : "Let’s play"}<Arrow/></button>}/>
    <main id="main">
      <section className="hero shell" aria-labelledby="hero-title">
        <div className="hero-copy"><h1 id="hero-title">how was<br/><span>your week?</span></h1><p className="hero-description">Ask your AI to rate your week.<br/>Bring back one score to share.</p><div className="hero-actions"><button className="button primary hero-cta" onClick={join} disabled={sessionLoading}>{me?.player.receipt ? "Rate my week again" : "Rate my week"}<Arrow/></button></div><p className="hero-assurance">Real evidence needed. Your history stays private.</p><ol className="hero-steps" aria-label="How to play"><li>Pick a name</li><li>Rate your week</li><li>Share your score</li></ol></div>
      </section>

      {me && <section className="home-player-card shell" aria-label="Your player"><div className="home-player-name"><h2>{me.player.username ? `@${me.player.username}` : "Pick your player name"}</h2><p className="caption">{receipt ? `${receipt.week_id} · ${percent(receipt.form.confidence.effective_ppm)} confidence` : "Your first score is waiting to happen."}</p></div><div className="home-score"><span className="eyebrow">COMPUTER FORM</span><strong>{receipt?.form.score ?? "—"}<small>/1000</small></strong></div><div className="home-player-actions"><button className="button secondary" onClick={() => openDialog(receipt ? "share" : "rate")}>{receipt ? "Share my card" : "Get my score"}<Arrow/></button><button className="text-link" onClick={() => openDialog("matches")}>Matchups{me.queue.length > 0 ? ` (${me.queue.length} waiting)` : ""}</button></div></section>}
      {!me && sessionError && <div className="shell session-notice"><Notice>{sessionError} <button className="text-link" onClick={() => void refreshMe().catch(error => setSessionError(message(error)))}>Retry session</button></Notice></div>}

      <section id="leaderboard" className="shell league-section" aria-labelledby="league-title"><div className="section-heading"><div><h2 id="league-title">The league</h2><p className="caption">Real weeks. Shared scores.</p></div><div className="leaderboard-toolbar"><span className="caption mono">{overview?.weekId ?? "WEEKLY STANDINGS"}</span><ModeSwitch mode={mode} onChange={setMode}/></div></div>
        <div className="standings-table-wrap"><table className="standings-table"><thead><tr><th scope="col">Rank</th><th scope="col">Player</th><th scope="col" className="number">Form / 1000</th><th scope="col" className="number">Elo</th><th scope="col" className="number">Confidence</th><th scope="col" className="number">Matches</th></tr></thead><tbody>{overview?.players.map(player => <tr key={player.id} className={player.id === me?.player.id ? "your-row" : ""}><td className="rank-cell">{player.rank === null ? "—" : String(player.rank).padStart(2, "0")}</td><td><button className="player-name" onClick={() => openProfile({ id: player.id, username: player.username ?? undefined })}>{playerLabel(player.username)}{player.id === me?.player.id && <span className="you-tag">you!</span>}</button></td><td className="number form-cell">{player.formScore ?? "—"}<small>{player.weekId ?? "No score yet"}</small></td><td className="number elo-cell">{rating(player.ratingMilli)}{player.ratedMatches === 0 && <small>Unrated</small>}</td><td className="number">{player.confidencePpm === null ? "—" : percent(player.confidencePpm)}</td><td className="number">{player.ratedMatches}</td></tr>)}</tbody></table>
        {loading ? <div className="empty-state" role="status"><span className="loading-mark"/><p>Waking up the scoreboard…</p></div> : overviewError ? <div className="empty-state"><h3>The scoreboard needs a minute.</h3><p>{overviewError}</p><button className="button secondary" onClick={() => { setLoading(true); void refreshOverview(); }}>Try again</button></div> : overview?.players.length === 0 ? <div className="empty-state"><h3>No scores yet.</h3><p>Published weekly scores will appear here.</p></div> : null}</div><div className="table-footer"><span className="caption">Self-attested scores. Elo rank starts after a rated matchup.</span><span className="mono caption">{overview ? `${overview.stats.players} players · ${overview.stats.matches} matchups` : "Live data unavailable"}</span></div>
      </section>
    </main><Footer onConnect={() => openDialog("connect")}/>

    <dialog ref={dialogRef} className={`player-dialog modal-${dialog ?? "closed"}${wideDialog ? " modal-wide" : ""}`} data-view={dialog ?? "closed"} aria-labelledby="dialog-title" onCancel={event => { event.preventDefault(); closeDialog(); }} onClick={event => { if (event.target !== event.currentTarget) return; const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeDialog(); }} onClose={event => { if (event.currentTarget.open) return; setDialog(null); if (lastFocusRef.current?.isConnected) lastFocusRef.current.focus(); }}>
      {dialog !== "key" && <button className="dialog-close" aria-label="Close dialog" disabled={busy !== null} onClick={closeDialog}>×</button>}
      <div className="dialog-content">
        {actionError && dialog !== "key" && <Notice>{actionError}</Notice>}
        {feedback && dialog && ["rate", "share", "matches", "account"].includes(dialog) && <Notice kind="info">{feedback}</Notice>}

        {dialog === "join" && <form onSubmit={event => { event.preventDefault(); if (nameValid) prepareKey("create"); }}><h2 id="dialog-title" tabIndex={-1}>Pick your username.</h2><p>A public profile for your score. No email needed.</p><label className="field-label" htmlFor="new-username">Your player name</label><div className="username-input"><span aria-hidden="true">@</span><input id="new-username" value={username} onChange={event => setUsername(event.target.value.toLowerCase().replace(/^@/, ""))} pattern="[a-z][a-z0-9_]{2,19}" minLength={3} maxLength={20} autoComplete="username" autoCapitalize="none" spellCheck={false} required aria-describedby="new-name-help"/></div><p id="new-name-help" className="caption">3–20 letters, numbers, or underscores. Start with a letter. Public and permanent, so pick a keeper.</p><button className="button primary full-width" disabled={busy !== null || !nameValid}>That’s me <Arrow/></button><button type="button" className="text-link recovery-link" disabled={busy !== null} onClick={() => { setDialog("recover"); setActionError(null); }}>Already in the club? Sign in.</button></form>}

        {dialog === "recover" && <form onSubmit={event => void recover(event)}><h2 id="dialog-title" tabIndex={-1}>Welcome back.</h2><p>Use the private recovery key you saved with your profile.</p><label className="field-label" htmlFor="recovery-token">Recovery key</label><input id="recovery-token" className="text-input" type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} required maxLength={256}/><button className="button primary full-width" disabled={busy !== null || !token.trim()}>{busy === "recover" ? "Signing in…" : "Let me in"}<Arrow/></button><button type="button" className="text-link recovery-link" disabled={busy !== null} onClick={() => { setDialog("join"); setActionError(null); }}>Create a new profile</button></form>}

        {dialog === "key" && <><h2 id="dialog-title" tabIndex={-1}>Save your recovery key.</h2><p>{keyAction === "create" ? "Save this private key before creating your profile. It lets you recover your account even if this connection drops." : "Save this new key before replacing the old one. The old key stops working as soon as you confirm below."}</p><div className="recovery-key"><label className="field-label" htmlFor="new-recovery-key">PRIVATE RECOVERY KEY</label><textarea id="new-recovery-key" readOnly value={recoveryKey} rows={3} spellCheck={false}/><CopyButton value={recoveryKey}>Copy recovery key</CopyButton></div><p className="caption">Anyone with this key can control your profile. Keep it in a password manager, out of your assessment and public posts.</p><label className="checkbox-label"><input type="checkbox" checked={saved} onChange={event => setSaved(event.target.checked)} disabled={busy !== null}/><span>I’ve saved this recovery key somewhere safe.</span></label>{actionError && <><Notice>{actionError}</Notice><p className="caption">If the request completed but its response was lost, your saved key can still recover the profile.</p></>}<button className="button primary full-width" disabled={!saved || busy !== null} onClick={() => void (keyAction === "create" ? createPlayer() : rotateKey())}>{busy ? "Working…" : keyAction === "create" ? "Create my profile" : "Replace old key"}<Arrow/></button>{keyAttempted && actionError && <button className="text-link recovery-link" disabled={busy !== null} onClick={() => void recoverPreparedKey()}>Try signing in with this saved key</button>}<button className="text-link recovery-link" disabled={busy !== null} onClick={() => { setDialog(keyAction === "create" ? "join" : "account"); setActionError(null); }}>{keyAction === "create" ? "Back to my name" : "Back to account"}</button></>}

        {dialog === "rate" && <><span className="modal-sticker">{overview?.weekId ?? "YOUR WEEK"}</span><h2 id="dialog-title" tabIndex={-1}>Rate your week.</h2>{!me ? <><p>Your private history stays with your AI. Your public score gets a player name.</p><button className="button primary" disabled={sessionLoading} onClick={() => openDialog("join")}>Pick my player name <Arrow/></button></> : needsUsername ? usernameForm : !overview ? <Notice kind="info">We need the current league week first. <button className="text-link" onClick={() => void refreshOverview()}>Try again</button></Notice> : <>
          <p className="modal-intro">{locked ? "This week’s score is locked for matchups. Share it, play, or come back next week." : "Paste the prompt into an AI that knows you. It rates your week from its available context and returns a score to bring back here."}</p>
          {!locked && <div className="score-flow"><div className="flow-step"><div className="flow-title"><span className="step-chip">1</span><h3>Ask your AI.</h3></div><div className="evidence-needed"><strong>Use an AI that already knows your work.</strong><p>Your existing chat, saved memory, or authorized activity can inform the rating. Your AI should use that context directly; your history stays private.</p></div><CopyButton value={assessmentPrompt} className="button primary">Copy my prompt <Arrow/></CopyButton><details className="prompt-details"><summary>See the prompt</summary><textarea className="prompt-text" aria-label="Full assessment prompt with evidence requirements" readOnly value={assessmentPrompt} rows={7}/></details><button className="text-link ai-connect-link" onClick={() => openDialog("connect")}>Connect your AI (optional) <Arrow/></button></div>
          <div className="flow-step"><div className="flow-title"><span className="step-chip">2</span><h3>Bring back the result.</h3></div><label className="field-label" htmlFor="assessment-json">Paste only the result JSON: a score or an insufficient-evidence response. Keep private notes and history with your AI.</label><textarea id="assessment-json" className="assessment-input" value={assessmentText} onChange={event => { draftReadRef.current++; setAssessmentText(event.target.value); setAssessmentPreview(null); setIncludeAssessmentContext(true); setInsufficientEvidence(null); setPreview(null); setFileError(null); }} placeholder="Your AI’s tiny JSON result goes here…" rows={5} maxLength={16384} spellCheck={false} disabled={busy !== null}/><button className="button secondary" onClick={reviewAssessment} disabled={busy !== null || !assessmentText.trim()}>Preview my result <Arrow/></button></div>
          <details className="advanced-import"><summary>Advanced: import a receipt</summary><p className="caption">Already using the scoring kit? Choose its public player receipt. <button className="text-link" onClick={() => openDialog("connect")}>Get the kit</button></p><input aria-label="Public player receipt JSON" type="file" accept=".json,application/json" onChange={event => void readFile(event)} disabled={busy !== null}/><p className="caption">JSON only · 16 KB max. Selecting a file does not publish it.</p></details></div>}
          {fileError && <Notice>{fileError}</Notice>}
          {insufficientEvidence && <section className="insufficient-result" role="status" aria-labelledby="insufficient-title"><span className="eyebrow">{insufficientEvidence.weekId} / NO USABLE CONTEXT</span><h3 id="insufficient-title">Try a chat that knows you.</h3><p>This AI could not find enough usable context to give a score. Paste the direct prompt into an existing chat with relevant work history or an AI with memory enabled.</p><p>Nothing was published. Your history stays with your AI; bring back only its final result.</p><CopyButton value={assessmentPrompt}>Copy direct prompt</CopyButton><details className="prompt-details"><summary>See the prompt</summary><textarea className="prompt-text" aria-label="Direct assessment retry prompt" readOnly value={assessmentPrompt} rows={5}/></details></section>}
          {draft && !locked && <section className="receipt-preview" aria-labelledby="preview-title"><h3 id="preview-title">Preview your public score.</h3><div className="preview-stats"><div><span>Form</span><strong>{draft.formScore}<small>/1000</small></strong></div><div><span>Confidence</span><strong>{percent(Math.min(draft.coveragePpm, draft.certaintyPpm))}</strong></div><div><span>Week</span><strong className="week-value">{draft.weekId}</strong></div></div><p className="caption">Coverage {percent(draft.coveragePpm)} · Certainty {percent(draft.certaintyPpm)}. This score, week, and confidence become public on @{me.player.username}. Your underlying history stays private.</p>{assessmentContext && <div className="assessment-context-preview"><AssessmentContextCaption context={assessmentContext}/><label className="checkbox-label"><input id="include-assessment-context" type="checkbox" checked={includeAssessmentContext} onChange={event => setIncludeAssessmentContext(event.target.checked)} disabled={busy !== null}/><span>Include AI and context source on my profile</span></label><p className="caption">{includeAssessmentContext ? "These two labels will also be public. They do not include your chats, memory, or activity." : "The AI and context-source labels will not be published. Your score and confidence stay the same."}</p></div>}{Math.min(draft.coveragePpm, draft.certaintyPpm) < 500000 && <Notice kind="info">Below 50% confidence: you can share your Form. Matchups are exhibitions with no Elo change.</Notice>}<div className="button-row"><button className="button primary" disabled={busy !== null} onClick={() => void publish()}>{busy === "publish" ? "Publishing…" : "Publish my score"}<Arrow/></button><button className="text-link" disabled={busy !== null} onClick={() => { setPreview(null); setAssessmentPreview(null); setIncludeAssessmentContext(true); }}>Discard</button></div></section>}
          {currentReceipt && <div className="modal-next-actions"><button className="button secondary" onClick={() => openDialog("share")}>Share current card <Arrow/></button><button className="text-link" onClick={() => openDialog("matches")}>Play a matchup</button></div>}
        </>}</>}

        {dialog === "share" && <><h2 id="dialog-title" tabIndex={-1}>Your weekly score.</h2>{me && receipt ? <><div className="modal-score-card"><span className="eyebrow">@{me.player.username ?? "player"} · {receipt.week_id}</span><div className="your-form">{receipt.form.score}<small>/1000</small></div><p>Computer Form · {percent(receipt.form.confidence.effective_ppm)} confidence</p><AssessmentContextCaption context={me.player.assessmentContext}/><div className="share-card-elo">{rating(receipt.elo.scalar.rating_milli)} Elo <span>{receipt.elo.scalar.rated_matches ? `${receipt.elo.scalar.rated_matches} rated matches` : "unrated"}</span></div></div><ShareActions username={me.player.username} receipt={receipt} url={profileUrl}/><p className="caption">Your public card contains your score. Your computer history stays private. Sharing on X opens a draft for you to review.</p><ReceiptLinks receipt={receipt} playerId={me.player.id}/><div className="modal-next-actions"><button className="button secondary" onClick={() => openDialog("matches")}>Find a matchup <Arrow/></button><button className="text-link" onClick={() => openProfile({ id: me.player.id, username: me.player.username ?? undefined })}>View my profile</button></div></> : <><p>Your card is waiting for its first score.</p><button className="button primary" onClick={join}>Rate my week <Arrow/></button></>}</>}

        {dialog === "matches" && <><h2 id="dialog-title" tabIndex={-1}>Your matchups.</h2>{!me ? <><p>Pick a name and publish your weekly Form to play.</p><button className="button primary" onClick={join}>Let’s start <Arrow/></button></> : <><div className="match-mode-bar"><p>Form decides the result. Matchups build your Elo.</p><ModeSwitch mode={mode} onChange={setMode}/></div>{currentReceipt ? <section className="queue-panel"><div className="queue-heading"><h3>{queued ? "Looking for your other half…" : matchedThisWeek ? "You played this week!" : "Ready, player?"}</h3>{queued && <span className="loading-mark"/>}</div><p className="caption">{queued ? "Waiting for an eligible player from the same week. You can close this window and return later." : matchedThisWeek ? "Try the other mode, or bring a fresh Form next week." : "One matchup per mode each week. Joining locks this week’s Form, even if you later leave the queue."}</p>{queued ? <button className="button secondary" disabled={busy !== null} onClick={() => void queue(true)}>{busy === "queue" ? "Leaving…" : "Leave queue"}</button> : !matchedThisWeek ? <button className="button primary" disabled={busy !== null} onClick={() => void queue()}>{busy === "queue" ? "Joining…" : "Join a matchup"}<Arrow/></button> : null}</section> : <div className="empty-state compact"><h3>First, bring this week’s Form.</h3><p>A published score is your ticket to the matchup.</p><button className="button primary" onClick={() => openDialog("rate")}>Rate this week <Arrow/></button></div>}<div className="your-matches"><h3>Your matchups</h3><MatchList matches={me.matches.filter(match => match.mode === mode)} playerId={me.player.id} usernames={me.usernames} onOpenProfile={openProfile}/></div></>}</>}

        {dialog === "account" && <><h2 id="dialog-title" tabIndex={-1}>{me?.player.username ? `hey, @${me.player.username}.` : "your player."}</h2>{!me ? <><p>Your next good week needs a player name.</p><button className="button primary" onClick={join}>Join the club <Arrow/></button></> : <>{needsUsername ? usernameForm : <div className="account-menu"><button className="button primary" onClick={() => openDialog("rate")}>Rate my week <Arrow/></button><button className="button secondary" onClick={() => openDialog("share")}>My scorecard</button><button className="text-link" onClick={() => openProfile({ id: me.player.id, username: me.player.username ?? undefined })}>My public profile <Arrow diagonal/></button></div>}<details className="account-details"><summary>Recovery key & sign out</summary><p className="caption">Your recovery key is your sign-in. Save the replacement before you confirm; the old key then stops working.</p><div className="button-row"><button className="button secondary small" disabled={busy !== null} onClick={() => prepareKey("rotate")}>Replace recovery key</button><button className="text-link" disabled={busy !== null} onClick={() => void signOut()}>{busy === "signout" ? "Signing out…" : "Sign out"}</button></div></details></>}</>}

        {dialog === "help" && <><h2 id="dialog-title" tabIndex={-1}>How to play.</h2><p>Your own AI reflects on your completed week, using evidence you authorize. You decide whether to publish its score.</p><div className="help-steps"><article><span className="step-chip">1</span><h3>Ask your AI.</h3><p>It uses the context it already has to rate your week directly. No context at all? Try an existing chat that knows your work.</p></article><article><span className="step-chip">2</span><h3>Get your Form.</h3><p>Your weekly score out of 1000, plus confidence. Paste the small result, review it, and choose to publish.</p></article><article><span className="step-chip">3</span><h3>Share or play.</h3><p>Your profile is ready to share immediately. Elo starts at 1200 and changes through opted-in weekly matchups.</p></article></div><details className="rubric-details"><summary>What actually counts? <span aria-hidden="true">+</span></summary><div className="rubric-list">{RUBRIC.map(([name, description, weight]) => <div className="rubric-row" key={name}><div><h3>{name}</h3><p>{description}</p></div><strong className="mono">{weight}<span>%</span></strong></div>)}</div><p className="caption">Confidence is the lower of evidence coverage and evaluator certainty. Zero coverage or certainty means no score. Grounded scores below 50% confidence can be shared, but matchups are exhibitions with no Elo change. Scores are self-attested and evaluators may disagree; fingerprints verify receipt integrity, not whether an assessment is true. This is a self-improvement game, not a measure of intelligence, worth, or employability.</p></details><div className="modal-next-actions"><button className="button primary" onClick={join}>Okay, rate my week <Arrow/></button><button className="text-link" onClick={() => openDialog("connect")}>Connect my AI / scoring kit</button></div></>}

        {dialog === "connect" && <><h2 id="dialog-title" tabIndex={-1}>Connect your AI.</h2><p>The copied prompt includes the full rubric. Your AI uses its available context to give you a direct rating.</p><section className="connect-option"><h3>The simple way</h3><p>Paste the prompt from “Rate my week” into an AI that knows you and bring back its score. No interview, connection, or link access is needed. The public guide below has the same rules.</p><label className="field-label" htmlFor="reference-url">Public scoring guide</label><input id="reference-url" className="text-input endpoint-input" readOnly value="https://computer-elo.vercel.app/rate.md"/><CopyButton value="https://computer-elo.vercel.app/rate.md">Copy guide link</CopyButton></section><details className="connect-option"><summary>Optional: add a remote MCP server</summary><p>If your AI supports remote MCP, add this URL in its connector settings. Authentication: none. It provides the public guide and prompt; it does not read activity or publish scores.</p><label className="field-label" htmlFor="mcp-url">MCP server URL</label><input id="mcp-url" className="text-input endpoint-input" readOnly value="https://computer-elo.vercel.app/mcp"/><CopyButton value="https://computer-elo.vercel.app/mcp">Copy MCP URL</CopyButton><p className="caption">Never put your recovery key in your AI or connector settings.</p></details><details className="advanced-import"><summary>Advanced: download the scoring kit</summary><p className="caption">A local CLI, the full rubric, and receipt tools. Node.js 22+ required. Your own evidence stays on your device.</p><a className="button secondary" href="/computer-elo-kit.zip" download>Download scoring kit <Arrow diagonal/></a></details><div className="evidence-needed"><strong>Your context stays with your AI.</strong><p>Use an existing chat, saved memory, or activity you already authorized. The AI can express limited context through lower confidence. With no usable context at all, it should return no score instead of inventing one.</p></div><button className="button primary" onClick={join}>Back to my score <Arrow/></button></>}

        {dialog === "profile" && <><h2 id="dialog-title" tabIndex={-1}>Player profile.</h2>{profileTarget?.username ? <UserProfile username={profileTarget.username} embedded onOpenProfile={openProfile} onHelp={() => openDialog("help")}/> : profileTarget?.id ? <PlayerProfile id={profileTarget.id} embedded onOpenProfile={openProfile} onHelp={() => openDialog("help")}/> : <Notice>This player could not be found.</Notice>}<div className="modal-next-actions"><button className="button secondary" onClick={join}>Get my own score <Arrow/></button><button className="text-link" onClick={() => openDialog("help")}>How scoring works</button></div></>}
      </div>
    </dialog>
  </>;
}
