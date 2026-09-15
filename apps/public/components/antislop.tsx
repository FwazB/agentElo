"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { AntiSlopArena, AntiSlopMe, CreateDuelRequest, DuelView, OwnedEntry, PublicEntry, SubmitEntryRequest } from "../../../packages/public-api/antislop";
import type { Me } from "../../../packages/public-api/types";
import type { EntryDraft } from "../../../packages/referee/drafts";
import { approvedPublicSummary, parseEntryPreview } from "./antislop-preview";
import { createGuestPlayer, validGuestName } from "./guest-player";
import { api, Arrow, CopyButton, Notice, playerLabel } from "./shared";
import styles from "./antislop.module.css";

export interface AntiSlopProps {
  me: Me | null;
  sessionLoading: boolean;
  onGuestPlayer: (player: Me) => void;
  onAccount: () => void;
  onOpenForm: () => void;
  privateDataRevision?: number;
  initialChallengeId?: string;
  initialDuelId?: string;
}

interface PreparationPrompt { prompt: string; window: { startsAt: string; endsAt: string } }
type Intent = "duel" | "challenge";
type Overlay = "entry" | "invite" | "result" | "share";
const message = (error: unknown) => error instanceof Error ? error.message : "Something went wrong. Please try again.";
const date = (value: string) => new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const windowLabel = (entry: Pick<PublicEntry, "window">) => `${date(entry.window.startsAt)}–${date(entry.window.endsAt)} · UTC`;
const paired = (duel: DuelView, a: string, b: string) => (duel.a.entryId === a && duel.b.entryId === b) || (duel.a.entryId === b && duel.b.entryId === a);
const isFresh = (entry: PublicEntry, now: string) => { const time = Date.parse(now), end = Date.parse(entry.window.endsAt), created = Date.parse(entry.createdAt); return end <= time && time - end <= 86_400_000 && created <= time && time - created <= 86_400_000; };
const isFinished = (duel: DuelView) => duel.state === "complete" || duel.state === "failed";
const formOutOf100 = (score: number) => (score / 10).toLocaleString("en-US", { maximumFractionDigits: 1, useGrouping: false });
const outcomeLabel = (duel: DuelView) => duel.state === "failed" ? "No verdict this time." : duel.state !== "complete" ? "The referee is up next." : duel.outcome === "draw" ? "A well-earned draw." : duel.outcome === "unrated" ? "No fair verdict this time." : `${playerLabel(duel.outcome === "a_wins" ? duel.a.username : duel.b.username)} takes this one.`;
const outcomeNote = (duel: DuelView) => duel.state === "failed" ? "The referee could not finish this duel. No result or rating change was recorded." : duel.state === "judging" ? "Both entries are being compared in both orders. You can leave and return to this link." : duel.state === "pending" ? "The entries are locked. A participant can ask the referee to compare them." : duel.outcome === "unrated" ? (duel.reason === "order_disagreement" ? "The referee’s decisions changed when the entry order changed. This duel is unrated." : "There wasn’t enough comparable evidence for a supported decision. This is unrated, not a draw.") : "A shared referee compared the submitted work and evidence in both orders. Pilot result · no Elo change.";

function Checkmark() { return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true"><path d="m5 12 4.5 4.5L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>; }

function PlayModal({ open, label, busy, onClose, children }: { open: boolean; label: string; busy: boolean; onClose: () => void; children: ReactNode }) {
  const element = useRef<HTMLDialogElement>(null);
  const restore = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const dialog = element.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    } else if (!open && dialog.open) dialog.close();
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => { dialog.scrollTop = 0; const heading = dialog.querySelector<HTMLElement>("h2, h3"); heading?.setAttribute("tabindex", "-1"); heading?.focus({ preventScroll: true }); });
    return () => { cancelAnimationFrame(frame); document.body.style.overflow = previous; };
  }, [open, label]);
  return <dialog ref={element} className={styles.modal} aria-label={label} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onClose={() => { if (!element.current?.open && restore.current?.isConnected) restore.current.focus(); }} onClick={event => { if (busy || event.target !== event.currentTarget) return; const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose(); }}><button className={styles.closeModal} aria-label="Close dialog" disabled={busy} onClick={onClose}>×</button>{children}</dialog>;
}

function DuelCard({ duel, origin, busy, onJudge, onRefresh }: { duel: DuelView; origin: string; busy: boolean; onJudge: () => void; onRefresh: () => void }) {
  const completed = duel.state === "complete";
  const playerStats = (side: "a" | "b") => {
    const stats = duel.playerStats?.[side];
    if (!stats) return <p className={styles.statsUnavailable}>Player stats unavailable</p>;
    return <dl className={styles.playerStats}><div><dt>Form</dt><dd>{stats.formScore === null ? <span className={styles.unscored}>Not scored yet</span> : <>{formOutOf100(stats.formScore)}<small>/100</small></>}</dd></div><div><dt>Elo</dt><dd>{Math.round(stats.ratingMilli / 1000)}</dd></div></dl>;
  };
  return <section className={styles.resultCard} aria-labelledby="duel-result-title">
    <div className={styles.cardTop}><span className={styles.pill}>SHARED REFEREE · PILOT</span><span className={styles.small}>{date(duel.createdAt)}</span></div>
    <div className={styles.duelPair}><div><span className={styles.small}>ENTRY A</span><strong>{playerLabel(duel.a.username)}</strong>{playerStats("a")}</div><span className={styles.versus}>vs</span><div><span className={styles.small}>ENTRY B</span><strong>{playerLabel(duel.b.username)}</strong>{playerStats("b")}</div></div>
    {duel.playerStats && <p className={styles.statsCaption}>Current public player stats, shown for context. The pilot verdict does not change Elo.</p>}
    <h2 id="duel-result-title">{outcomeLabel(duel)}</h2><p className={styles.resultNote}>{outcomeNote(duel)}</p>
    {(duel.a.publicSummary || duel.b.publicSummary) && <div className={styles.publicPair}>{[duel.a, duel.b].map(entry => <div key={entry.entryId}><span className={styles.small}>{playerLabel(entry.username)} · APPROVED PUBLIC SUMMARY</span><p>{entry.publicSummary || "This player kept their work summary private."}</p></div>)}</div>}
    <div className={styles.actionRow}>
      {duel.canJudge && <button className="button primary" disabled={busy} onClick={onJudge}>{busy ? "Calling the referee…" : "Ask the referee"}<Arrow/></button>}
      {(duel.state === "pending" || duel.state === "judging") && <button className="button secondary" disabled={busy} onClick={onRefresh}>Check result</button>}
      {origin && <CopyButton value={`${origin}/duel/${duel.duelId}`}>Copy duel link</CopyButton>}
      {completed && <a className="text-link" href={`/duel/${duel.duelId}/opengraph-image`} download={`antislop-${duel.duelId}.png`}>Download card<Arrow diagonal/></a>}
    </div>
    <p className={styles.finePrint}>Player stats, approved summaries and the duel result are public. Private evidence stays out of this card.</p>
  </section>;
}

export function AntiSlop({ me, sessionLoading, onGuestPlayer, onAccount, onOpenForm, privateDataRevision = 0, initialChallengeId, initialDuelId }: AntiSlopProps) {
  const accountId = me?.player.id;
  const [arena, setArena] = useState<AntiSlopArena | null>(null);
  const [owned, setOwned] = useState<AntiSlopMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [origin, setOrigin] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [invitation, setInvitation] = useState<PublicEntry | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [duel, setDuel] = useState<DuelView | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [intent, setIntent] = useState<Intent>("duel");
  const [prompt, setPrompt] = useState<PreparationPrompt | null>(null);
  const [promptLoading, setPromptLoading] = useState(false);
  const [source, setSource] = useState("");
  const [preview, setPreview] = useState<EntryDraft | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [refereeApproved, setRefereeApproved] = useState(false);
  const [optedIn, setOptedIn] = useState(false);
  const [shareSummary, setShareSummary] = useState(false);
  const [summaryText, setSummaryText] = useState("");
  const [summaryApproved, setSummaryApproved] = useState(false);
  const [guestName, setGuestName] = useState("");
  const [shareEntry, setShareEntry] = useState<PublicEntry | null>(null);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const entryRequest = useRef<string | null>(null);
  const duelRequests = useRef(new Map<string, string>());
  const epoch = useRef(0);
  const accountRef = useRef(accountId);
  accountRef.current = accountId;
  const previousAccount = useRef(accountId);
  const previousPrivateDataRevision = useRef(privateDataRevision);
  const guestAdoption = useRef<{ accountId: string; epoch: number } | null>(null);
  const openedRoute = useRef("");
  const refreshVersion = useRef(0);
  const preparingRef = useRef<HTMLElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const inviteRef = useRef<HTMLElement>(null);
  const busyRef = useRef(false);
  const selected = owned?.entries.find(entry => entry.entryId === selectedId) ?? owned?.entries[0] ?? null;
  const selectedFresh = !!selected && (!arena || isFresh(selected, arena.serverNow));
  const invitationFresh = !!invitation && (!arena || isFresh(invitation, arena.serverNow));
  const ready = preview?.status === "ready" ? preview : null;
  const available = arena?.entries.filter(entry => entry.participantId !== accountId && entry.optedIn && (!selected || !owned?.duels.some(duel => paired(duel, selected.entryId, entry.entryId)))) ?? [];
  const quotaBlocked = !!owned && (owned.quota.remaining <= 0 || owned.quota.inFlight > 0);

  const updateDuel = useCallback((result: DuelView) => setDuel(current => current && (current.duelId !== result.duelId || (isFinished(current) && !isFinished(result))) ? current : result), []);

  const refresh = useCallback(async (includePrivate = !!accountRef.current) => {
    const current = epoch.current;
    const version = ++refreshVersion.current;
    const results = await Promise.allSettled([api<AntiSlopArena>("/antislop/arena"), includePrivate ? api<AntiSlopMe>("/antislop/me") : Promise.resolve(null)]);
    if (current !== epoch.current || version !== refreshVersion.current) return;
    const arenaResult = results[0], meResult = results[1];
    if (arenaResult.status === "fulfilled") { setArena(arenaResult.value as AntiSlopArena); setLoadError(null); }
    else setLoadError(message(arenaResult.reason));
    if (meResult.status === "fulfilled") setOwned(meResult.value as AntiSlopMe | null);
    else setLoadError(message(meResult.reason));
    setLoading(false);
  }, []);

  useEffect(() => { setOrigin(window.location.origin); return () => { epoch.current++; }; }, []);
  useEffect(() => {
    const expected = guestAdoption.current;
    const erased = previousPrivateDataRevision.current !== privateDataRevision;
    previousPrivateDataRevision.current = privateDataRevision;
    const adopting = !erased && !!expected && !previousAccount.current && expected.accountId === accountId && expected.epoch === epoch.current;
    previousAccount.current = accountId;
    guestAdoption.current = null;
    if (adopting) { void refresh(); return; }
    epoch.current++; setOwned(null); setSelectedId(""); setSource(""); setPreview(null); setPreviewError(null); setRefereeApproved(false); setOptedIn(false); setShareSummary(false); setSummaryText(""); setSummaryApproved(false); setShareEntry(null); setBusy(null); setPromptLoading(false); busyRef.current = false; entryRequest.current = null; duelRequests.current.clear(); setActionError(null); setFeedback(null); setLoading(true); setDuel(previous => previous ? { ...previous, canJudge: false } : null);
    setGuestName("");
    if (accountId && preparing && !erased) { setOverlay("entry"); if (!prompt) void loadPrompt(); }
    else if (!accountId || erased) { setOverlay(null); if (erased) setPreparing(false); }
    void refresh();
  }, [accountId, privateDataRevision, refresh]);

  useEffect(() => {
    const controller = new AbortController();
    const route = `${initialChallengeId ?? ""}:${initialDuelId ?? ""}`;
    const openRoute = openedRoute.current !== route;
    setRouteError(null);
    if (initialChallengeId) void api<PublicEntry>(`/antislop/entries/${encodeURIComponent(initialChallengeId)}`, { signal: controller.signal }).then(entry => { if (controller.signal.aborted) return; setInvitation(entry); if (openRoute) { openedRoute.current = route; setOverlay("invite"); } }).catch(error => { if (!controller.signal.aborted) setRouteError(message(error)); });
    if (initialDuelId) void api<DuelView>(`/antislop/duels/${encodeURIComponent(initialDuelId)}`, { signal: controller.signal }).then(result => { if (controller.signal.aborted) return; setDuel(current => openRoute || !current || current.duelId === result.duelId ? result : current); if (openRoute) { openedRoute.current = route; setOverlay("result"); } }).catch(error => { if (!controller.signal.aborted) setRouteError(message(error)); });
    return () => controller.abort();
  }, [initialChallengeId, initialDuelId, accountId]);

  useEffect(() => {
    if (!duel || (duel.state !== "pending" && duel.state !== "judging")) return;
    const controller = new AbortController();
    let reading = false;
    const timer = setInterval(() => { if (reading) return; reading = true; void api<DuelView>(`/antislop/duels/${duel.duelId}`, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) updateDuel(result); }).catch(() => {}).finally(() => { reading = false; }); }, 4_000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [duel?.duelId, duel?.state, accountId, updateDuel]);

  async function loadPrompt() {
    const current = epoch.current; setPromptLoading(true); setPreviewError(null);
    try { const result = await api<PreparationPrompt>("/antislop/prompt"); if (current === epoch.current) setPrompt(result); }
    catch (error) { if (current === epoch.current) setPreviewError(message(error)); }
    finally { if (current === epoch.current) setPromptLoading(false); }
  }

  function prepare(nextIntent: Intent) {
    setIntent(nextIntent); setPreparing(true); setActionError(null); setFeedback(null);
    setOverlay("entry");
    if (!prompt) void loadPrompt();
  }

  function invalidatePreview(value: string) {
    setSource(value); setPreview(null); setPreviewError(null); setRefereeApproved(false); setOptedIn(false); setSummaryApproved(false); entryRequest.current = null;
  }

  function review() {
    setPreviewError(null); setRefereeApproved(false); setOptedIn(false); setSummaryApproved(false); entryRequest.current = null;
    try { setPreview(parseEntryPreview(source)); } catch (error) { setPreview(null); setPreviewError(message(error)); }
  }

  async function checkDuel(id: string) {
    const current = epoch.current;
    try { const result = await api<DuelView>(`/antislop/duels/${id}`); if (current === epoch.current) { updateDuel(result); await refresh(); } }
    catch (error) { if (current === epoch.current) setActionError(message(error)); }
  }

  async function judge(result: DuelView) {
    const current = epoch.current;
    setBusy("judge"); busyRef.current = true; setActionError(null);
    try { const judged = await api<DuelView>(`/antislop/duels/${result.duelId}/judge`, { method: "POST", body: "{}" }); if (current === epoch.current) updateDuel(judged); }
    catch (error) { if (current === epoch.current) { setActionError(`${message(error)} Your duel link is saved below; check its result before trying again.`); await checkDuel(result.duelId); } }
    finally { if (current === epoch.current) { setBusy(null); busyRef.current = false; void refresh(); } }
  }

  async function startDuel(entry: OwnedEntry, opponent: PublicEntry) {
    if (busyRef.current || !entry.optedIn) return;
    const current = epoch.current;
    busyRef.current = true; setBusy("duel"); setActionError(null); setFeedback(null);
    const pair = `${entry.entryId}:${opponent.entryId}`;
    if (!duelRequests.current.has(pair)) duelRequests.current.set(pair, crypto.randomUUID());
    const body: CreateDuelRequest = { requestId: duelRequests.current.get(pair)!, entryId: entry.entryId, opponentEntryId: opponent.entryId };
    let created: DuelView | null = null;
    try {
      created = await api<DuelView>("/antislop/duels", { method: "POST", body: JSON.stringify(body) });
      if (current !== epoch.current) return;
      setDuel(created); setShareEntry(null); setPreparing(false); setOverlay("result");
    } catch (error) { if (current === epoch.current) setActionError(message(error)); }
    finally { if (current === epoch.current) { setBusy(null); busyRef.current = false; } }
    if (created && current === epoch.current) {
      if (created.canJudge) await judge(created); else void refresh();
    }
  }

  function play(opponent?: PublicEntry) {
    if (opponent) setInvitation(opponent);
    const target = opponent ?? (invitation?.participantId !== accountId && invitation?.optedIn && invitationFresh ? invitation : null) ?? available[0];
    if (!me || !selected || !selectedFresh) { prepare("duel"); return; }
    if (!selected.optedIn) { setActionError("Allow challenges and public duel results for your entry first."); return; }
    if (target) void startDuel(selected, target);
    else { setShareEntry(selected); setOverlay("share"); setFeedback("Your entry is ready. Invite a friend while another player gets ready."); }
  }

  function challengeFriend() {
    setIntent("challenge");
    if (!me || !selected || !selectedFresh) { prepare("challenge"); return; }
    if (!selected.optedIn) { setActionError("Allow challenges and public duel results for your entry first."); return; }
    setShareEntry(selected); setOverlay("share"); setFeedback(null);
  }

  async function publishEntry() {
    if (!ready || sessionLoading || (!me && !validGuestName(guestName)) || !refereeApproved || !optedIn || (shareSummary && !summaryApproved) || busyRef.current) return;
    const current = epoch.current;
    const originalAccount = accountId;
    const isCurrent = () => current === epoch.current && accountRef.current === originalAccount;
    const submittedIntent = intent;
    const submittedOpponent = (invitation?.participantId !== accountId && invitation?.optedIn && invitationFresh ? invitation : null) ?? available[0];
    const submittedName = guestName;
    setActionError(null); setPreviewError(null);
    let publicSummary: SubmitEntryRequest["publicSummary"] = null;
    try { if (shareSummary) publicSummary = { text: approvedPublicSummary(summaryText), approved: true }; }
    catch (error) { setPreviewError(message(error)); return; }
    entryRequest.current ??= crypto.randomUUID();
    const body: SubmitEntryRequest = { requestId: entryRequest.current, draft: ready, refereeApproved: true, optedIn, publicSummary };
    busyRef.current = true; setBusy("entry");
    let entry: OwnedEntry | null = null;
    try {
      const guest = me ? null : await createGuestPlayer(submittedName, isCurrent);
      if (!isCurrent()) return;
      entry = await api<OwnedEntry>("/antislop/entries", { method: "POST", headers: { "X-Expected-Player-Id": guest?.player.id ?? accountId! }, body: JSON.stringify(body) });
      if (!isCurrent()) return;
      if (guest) {
        // Only this expected, initially anonymous transition may preserve the
        // approved submission. Every other account change clears private state.
        guestAdoption.current = { accountId: guest.player.id, epoch: current };
        onGuestPlayer(guest);
      }
      setSelectedId(entry.entryId); setSource(""); setPreview(null); setPreparing(false); setRefereeApproved(false); setOptedIn(false); setShareSummary(false); setSummaryText(""); setSummaryApproved(false); entryRequest.current = null;
      await refresh(true);
    } catch (error) { if (current === epoch.current) setPreviewError(message(error)); }
    finally { if (current === epoch.current) { setBusy(null); busyRef.current = false; } }
    if (!entry || current !== epoch.current) return;
    const opponent = submittedOpponent?.participantId !== entry.participantId ? submittedOpponent : null;
    if (submittedIntent === "duel" && opponent) await startDuel(entry, opponent);
    else { setShareEntry(entry); setOverlay("share"); setFeedback(submittedIntent === "duel" ? "Entry approved. Invite a friend while another player gets ready." : "Your challenge is ready to share."); }
  }

  async function participation(entry: OwnedEntry, enabled: boolean) {
    if (busyRef.current) return;
    const current = epoch.current; busyRef.current = true; setBusy("participation"); setActionError(null);
    try { await api(`/antislop/entries/${entry.entryId}/participation`, { method: "POST", body: JSON.stringify({ optedIn: enabled }) }); if (current === epoch.current) { setShareEntry(null); await refresh(); } }
    catch (error) { if (current === epoch.current) setActionError(message(error)); }
    finally { if (current === epoch.current) { busyRef.current = false; setBusy(null); } }
  }

  const invitationPanel = <>{invitation && <section ref={inviteRef} tabIndex={-1} className={styles.invitation} aria-labelledby="invite-title"><span className={styles.eyebrow}>YOU’RE INVITED</span><div className={styles.sectionRow}><div><h2 id="invite-title">{invitation.participantId === accountId ? "Your challenge is ready." : `${playerLabel(invitation.username)} brought their work.`}</h2><p>{invitation.publicSummary ?? "Their evidence goes to the referee. Bring your own entry to meet them."}</p><span className={styles.small}>{windowLabel(invitation)}</span></div>{invitation.participantId === accountId ? origin && <CopyButton value={`${origin}/challenge/${invitation.entryId}`}>Copy challenge link</CopyButton> : <button className="button primary" disabled={!invitation.optedIn || !invitationFresh || busy !== null || sessionLoading || quotaBlocked} onClick={() => play(invitation)}>{!invitationFresh ? "Entry has expired" : invitation.optedIn ? "Accept challenge" : "Challenge paused"}<Arrow/></button>}</div></section>}</>;

  const resultPanel = <>{duel && <div ref={resultRef} tabIndex={-1} className={styles.resultWrap}><DuelCard duel={duel} origin={origin} busy={busy !== null} onJudge={() => { if (!busyRef.current) void judge(duel); }} onRefresh={() => void checkDuel(duel.duelId)}/></div>}</>;

  const sharePanel = <>{shareEntry && origin && <section id="antislop-invite-link" tabIndex={-1} className={styles.sharePanel}><div><span className={styles.eyebrow}>SEND THE CHALLENGE</span><h2>Your work. Their move.</h2><p>This link shares your invitation, not your private evidence.</p></div><div className={styles.shareLink}><input aria-label="Your challenge link" value={`${origin}/challenge/${shareEntry.entryId}`} readOnly onFocus={event => event.currentTarget.select()}/><CopyButton value={`${origin}/challenge/${shareEntry.entryId}`} className="button primary">Copy challenge<Arrow/></CopyButton></div></section>}</>;

  const preparationPanel = <>{preparing && <section ref={preparingRef} tabIndex={-1} className={styles.preparation} aria-labelledby="prepare-title"><div className={styles.sectionRow}><div><span className={styles.eyebrow}>YOUR NEXT SEVEN-DAY ENTRY</span><h2 id="prepare-title">Let the work speak.</h2><p>Prepare privately. Review here. Submit when you’re ready.</p></div><button className="text-link" disabled={busy !== null} onClick={() => setOverlay(null)}>Close</button></div><div className={styles.prepareGrid}><div className={styles.step}><div className={styles.stepTitle}><span>1</span><h3>Ask your AI.</h3></div><p>Use a chat that knows your work. The prompt asks for a short recap and supporting excerpts from the last seven days.</p>{prompt ? <><CopyButton value={prompt.prompt} className="button primary">Copy preparation prompt<Arrow/></CopyButton><details className={styles.promptDetails}><summary>Read the prompt</summary><textarea readOnly value={prompt.prompt} rows={8} aria-label="Full entry preparation prompt"/></details><span className={styles.small}>{date(prompt.window.startsAt)}–{date(prompt.window.endsAt)} · UTC</span><button className="text-link" disabled={promptLoading || busy !== null} onClick={() => void loadPrompt()}>{promptLoading ? "Refreshing…" : "Refresh preparation window"}</button></> : <button className="button secondary" disabled={promptLoading} onClick={() => void loadPrompt()}>{promptLoading ? "Getting your prompt…" : "Get preparation prompt"}</button>}</div><div className={styles.step}><div className={styles.stepTitle}><span>2</span><h3>Bring back your entry.</h3></div><label htmlFor="antislop-entry-json">Paste the JSON from your AI. Nothing uploads when you paste or preview.</label><textarea id="antislop-entry-json" value={source} onChange={event => invalidatePreview(event.target.value)} rows={7} maxLength={65_536} disabled={busy !== null} spellCheck={false} placeholder={'{\n  "status": "ready",\n  "summary": "…"\n}'}/><button className="button secondary" disabled={!source.trim() || busy !== null} onClick={review}>Review my entry<Arrow/></button></div></div>
      {previewError && <Notice>{previewError}</Notice>}
      {preview?.status === "insufficient_context" && <div className={styles.insufficient}><h3>Give your AI a little more to work with.</h3><p>It couldn’t prepare a supported entry from the context it could safely use. Try a relevant existing chat, or privately provide a few dated outcomes and checks. Nothing was submitted.</p>{prompt && <CopyButton value={prompt.prompt}>Copy prompt again</CopyButton>}</div>}
      {ready && <div className={styles.review}><div className={styles.stepTitle}><span>3</span><h3>Review. Then make it official.</h3></div><p className={styles.reviewIntro}>The referee will receive the text below. Remove names or private details you don’t want to send; your text is not automatically anonymized.</p><div className={styles.previewHeader}><span className={styles.pill}>PRIVATE REFEREE EVIDENCE</span><span className={styles.small}>{windowLabel(ready)}</span></div><p className={styles.entrySummary}>{ready.summary}</p><div className={styles.accomplishments}>{ready.accomplishments.map((item, index) => <article key={item.id}><span className={styles.accomplishmentNumber}>{String(index + 1).padStart(2, "0")}</span><div><p>{item.outcome}</p><div className={styles.evidenceList}>{item.evidenceIds.map(reference => { const evidence = ready.evidence.find(item => item.id === reference)!; return <details key={reference}><summary><Checkmark/><span>{evidence.kind === "check" ? "Check" : evidence.kind === "artifact" ? "Artifact excerpt" : "Self-report"} · {evidence.occurredAt.length === 10 ? evidence.occurredAt : date(evidence.occurredAt)}</span></summary><p>{evidence.excerpt}</p></details>; })}</div></div></article>)}</div>
      {ready.evidence.some(evidence => !ready.accomplishments.some(item => item.evidenceIds.includes(evidence.id))) && <details className={styles.extraEvidence}><summary>Additional evidence sent to the referee</summary>{ready.evidence.filter(evidence => !ready.accomplishments.some(item => item.evidenceIds.includes(evidence.id))).map(evidence => <p key={evidence.id}><strong>{evidence.kind} · {evidence.occurredAt}</strong><br/>{evidence.excerpt}</p>)}</details>}
      <div className={styles.consents}>{!me && <div className={styles.guestName}><label htmlFor="antislop-player-name">Your public player name</label><div><span aria-hidden="true">@</span><input id="antislop-player-name" value={guestName} onChange={event => setGuestName(event.target.value.toLowerCase().replace(/^@/, ""))} pattern="[a-z][a-z0-9_]{2,19}" minLength={3} maxLength={20} autoComplete="username" autoCapitalize="none" spellCheck={false} disabled={busy !== null} aria-describedby="antislop-name-help"/></div><p id="antislop-name-help">3–20 letters, numbers, or underscores. Start with a letter. No email or password; your player stays in this browser.</p></div>}<label><input type="checkbox" checked={refereeApproved} disabled={busy !== null} onChange={event => { setRefereeApproved(event.target.checked); entryRequest.current = null; }}/><span>I approve sending this exact recap and evidence to the shared referee.<small>AntiSlop stores new private recaps for 7 days. Judging sends them through Vercel AI Gateway to Alibaba’s Qwen model.</small></span></label><label><input type="checkbox" checked={optedIn} disabled={busy !== null} onChange={event => { setOptedIn(event.target.checked); entryRequest.current = null; }}/><span>Allow challenges and make my player name, entry dates, and duel outcomes public.</span></label><label><input type="checkbox" checked={shareSummary} disabled={busy !== null} onChange={event => { setShareSummary(event.target.checked); setSummaryApproved(false); entryRequest.current = null; }}/><span>Add a public summary <small>Optional. Private evidence is never copied here.</small></span></label>{shareSummary && <div className={styles.summaryEditor}><label htmlFor="antislop-public-summary">Write exactly what others may see</label><textarea id="antislop-public-summary" value={summaryText} onChange={event => { setSummaryText(event.target.value); setSummaryApproved(false); entryRequest.current = null; }} maxLength={2_000} rows={3} disabled={busy !== null} placeholder="A short public description, in your own words."/><label><input type="checkbox" checked={summaryApproved} onChange={event => { setSummaryApproved(event.target.checked); entryRequest.current = null; }} disabled={!summaryText.trim() || busy !== null}/><span>I approve publishing this exact summary on my entry and duel cards.</span></label></div>}</div><div className={styles.reviewFooter}><button className="button primary" disabled={sessionLoading || (!me && !validGuestName(guestName)) || !refereeApproved || !optedIn || (shareSummary && (!summaryApproved || !summaryText.trim())) || busy !== null} onClick={() => void publishEntry()}>{busy === "entry" ? "Saving approved entry…" : intent === "challenge" ? "Approve & create challenge" : "Approve & start a duel"}<Arrow/></button><span className={styles.small}>Pilot comparisons. No Elo changes.</span></div></div>}</section>}</>;

  const personalDuels = owned?.duels ?? [];
  const visibleDuels = me ? personalDuels : arena?.duels ?? [];
  return <div className={styles.page}>
    <header className={styles.header}><Link href="/" className={styles.brand} aria-label="AntiSlop home">anti<span>slop</span><span className={styles.brandStar} aria-hidden="true">✳</span></Link><nav aria-label="Main navigation"><a href="#antislop-how">How it works</a><button className={styles.account} onClick={me ? onAccount : () => prepare("duel")} disabled={sessionLoading || busy !== null}>{sessionLoading ? "One sec…" : me ? "Your player" : "Start playing"}<Arrow/></button></nav></header>
    <main id="main" className={styles.shell}>
      <section className={styles.hero} aria-labelledby="antislop-title"><div><span className={styles.eyebrow}><span className={styles.spark} aria-hidden="true">✳</span> LESS SLOP. MORE PROOF.</span><h1 id="antislop-title">Show your<br/><span>work.</span></h1><p>Bring your last seven days.<br/>Challenge a friend. Same referee.</p><div className={styles.heroActions}><button className="button primary" disabled={sessionLoading || busy !== null || quotaBlocked} onClick={() => play()}>Start a duel<Arrow/></button><button className="button secondary" disabled={sessionLoading || busy !== null} onClick={challengeFriend}>Challenge a friend</button></div><span className={styles.heroNote}>AI assistance welcome. Evidence decides.</span></div><div className={styles.heroArt} aria-hidden="true"><div className={styles.playerTile}><span>PLAYER ONE</span><div className={styles.playerGlyph}>✳</div><strong>your work.</strong><small>EVIDENCE READY</small></div><div className={styles.opponentTile}><span>PLAYER TWO</span><div className={styles.playerGlyph}>↗</div><strong>their work.</strong><small>CHALLENGE ACCEPTED</small></div><span className={styles.heroVs}>VS</span><span className={styles.artSticker}>same<br/>referee.</span></div></section>

      <div className={styles.pilotStrip}><span className={styles.pilotDot}/><strong>Shared referee pilot</strong><span>No Elo changes while the referee is being calibrated.</span><a href="#antislop-how">The rules<Arrow diagonal/></a></div>
      {routeError && <div className={styles.noticeWrap}><Notice>{routeError}</Notice></div>}
      {actionError && <div className={styles.noticeWrap}><Notice>{actionError}</Notice></div>}
      {feedback && <div className={styles.noticeWrap}><Notice kind="info">{feedback}</Notice></div>}

      {me && <section className={styles.personal} aria-label="Your entry and Form"><div className={styles.personalEntry}><span className={styles.eyebrow}>YOUR ENTRY</span><div className={styles.entryHeading}><h2>{selected ? selectedFresh ? "Ready when you are." : "Time for fresh work." : "Good work starts here."}</h2>{selected && <span className={`${styles.status} ${selected.optedIn && selectedFresh ? styles.activeStatus : ""}`}>{!selectedFresh ? "Entry expired" : selected.optedIn ? "Open to duels" : "Paused"}</span>}</div>{selected ? <><p className={styles.small}>{windowLabel(selected)} · {selected.entry.accomplishments.length} accomplishment{selected.entry.accomplishments.length === 1 ? "" : "s"}</p>{owned && owned.entries.length > 1 && <label className={styles.entrySelect}>Use entry<select value={selected.entryId} disabled={busy !== null} onChange={event => { setSelectedId(event.target.value); setShareEntry(null); }} aria-label="Choose your entry">{owned.entries.map(entry => <option key={entry.entryId} value={entry.entryId}>{windowLabel(entry)}{entry.optedIn ? "" : " · paused"}</option>)}</select></label>}<div className={styles.actionRow}><button className="text-link" disabled={busy !== null} onClick={() => prepare("duel")}>Prepare fresh entry<Arrow/></button><button className="text-link" disabled={busy !== null || !selectedFresh} onClick={() => void participation(selected, !selected.optedIn)}>{selected.optedIn ? "Pause challenges" : "Allow challenges & public duel results"}</button></div></> : <><p>Your AI prepares the recap. You choose the evidence.</p><button className="text-link" onClick={() => prepare("duel")}>Prepare my entry<Arrow/></button></>}{selected && !selectedFresh && <p className={styles.quota}>Entries can duel for 24 hours after their window ends. Prepare a fresh entry to play.</p>}{owned && <p className={styles.quota}>{owned.quota.inFlight > 0 ? "One duel is already in progress. Its result will appear below." : `${owned.quota.remaining} of ${arena?.limits.duelsPerPlayerPerDay ?? owned.quota.used + owned.quota.remaining} pilot duels left today · UTC`}</p>}</div><div className={styles.formPanel}><span className={styles.eyebrow}>YOUR FORM</span><strong>{me.player.receipt ? formOutOf100(me.player.receipt.form.score) : "—"}<small>/100</small></strong><p>Your personal AI reflection.<br/>Never used by the referee.</p><button className="text-link" onClick={onOpenForm}>Open my Form<Arrow/></button></div></section>}

      <section className={styles.arena} aria-labelledby="arena-title"><div className={styles.sectionRow}><div><span className={styles.eyebrow}>THE ARENA</span><h2 id="arena-title">Meet your next matchup.</h2></div><button className="text-link" disabled={loading} onClick={() => { setLoading(true); void refresh(); }}>Refresh<Arrow/></button></div>{loadError && <Notice>{loadError}</Notice>}{loading && !arena ? <div className={styles.empty} role="status">Getting the arena ready…</div> : available.length ? <div className={styles.entryGrid}>{available.slice(0, 6).map(entry => <article className={styles.opponentCard} key={entry.entryId}><div className={styles.opponentHeading}><span className={styles.avatar} aria-hidden="true">{(entry.username ?? "?").slice(0, 1).toUpperCase()}</span><div><h3>{playerLabel(entry.username)}</h3><span className={styles.small}>{windowLabel(entry)}</span></div></div><p>{entry.publicSummary ?? "Work submitted. Evidence reserved for the referee."}</p><button className="text-link" disabled={sessionLoading || busy !== null || quotaBlocked} onClick={() => play(entry)}>Challenge<Arrow/></button></article>)}</div> : !loadError && <div className={styles.empty}><span className={styles.emptyStar} aria-hidden="true">✳</span><h3>{selected ? "Make the first move." : "Your next opponent is getting ready."}</h3><p>Bring an entry and send a friend your challenge link.</p><button className="button secondary" onClick={challengeFriend} disabled={sessionLoading || busy !== null}>Challenge a friend<Arrow/></button></div>}</section>

      <section className={styles.duels} aria-labelledby="recent-duels-title"><div className={styles.sectionRow}><div><span className={styles.eyebrow}>THE RECEIPTS</span><h2 id="recent-duels-title">{me ? "Your duels." : "Recent duels."}</h2></div><span className={styles.small}>Same referee. Same rules.</span></div>{visibleDuels.length ? <div className={styles.duelList}>{visibleDuels.slice(0, 8).map(item => <Link className={styles.duelRow} key={item.duelId} href={`/duel/${item.duelId}`} onClick={event => { event.preventDefault(); setDuel(item); setOverlay("result"); void checkDuel(item.duelId); }}><div><strong>{playerLabel(item.a.username)}<span>vs</span>{playerLabel(item.b.username)}</strong><small>{date(item.createdAt)} · Pilot</small></div><span className={styles.duelStatus}>{item.state === "complete" ? item.outcome === "unrated" ? "Unrated" : item.outcome === "draw" ? "Draw" : `${playerLabel(item.outcome === "a_wins" ? item.a.username : item.b.username)} won` : item.state === "failed" ? "No verdict" : item.state === "judging" ? "With the referee" : "Ready for referee"}<Arrow diagonal/></span></Link>)}</div> : <p className={styles.quietEmpty}>{me ? "Your completed and in-progress duels will land here." : "Results appear here when players complete a duel."}</p>}</section>

      <section id="antislop-how" className={styles.how} aria-labelledby="how-title"><span className={styles.eyebrow}>GOOD WORK HAS RECEIPTS</span><h2 id="how-title">Your AI helps. The referee decides.</h2><div className={styles.howGrid}><article><span>01</span><h3>Bring the work.</h3><p>Your AI prepares seven days of outcomes and evidence. You review every excerpt before sending it.</p></article><article><span>02</span><h3>Meet your match.</h3><p>Challenge a friend or someone in the arena. Account and rating fields are removed before judging; names in your submitted text can still identify you.</p></article><article><span>03</span><h3>Share the result.</h3><p>Both entry orders must agree. A fair draw counts as a draw; missing evidence or disagreement stays unrated.</p></article></div><div className={styles.rulesNote}><Checkmark/><p>AI assistance is welcome. This is a comparison of demonstrated work, not an AI detector. Submissions aren’t independently verified, and the referee can be wrong. This pilot does not change Elo.</p></div></section>
    </main><footer className={styles.footer}><Link href="/" className={styles.brand}>anti<span>slop</span></Link><span>Less slop. More proof.</span><button className="text-link" onClick={onOpenForm}>Computer Form<Arrow diagonal/></button></footer>
    <PlayModal open={overlay !== null} label={overlay === "entry" ? "Prepare your entry" : overlay === "invite" ? "Player challenge" : overlay === "share" ? "Share your challenge" : "Duel result"} busy={busy === "entry" || busy === "duel" || busy === "participation"} onClose={() => setOverlay(null)}>{actionError && <Notice>{actionError}</Notice>}{feedback && <Notice kind="info">{feedback}</Notice>}{overlay === "entry" ? preparationPanel : overlay === "invite" ? invitationPanel : overlay === "result" ? resultPanel : overlay === "share" ? sharePanel : null}</PlayModal>
  </div>;
}
