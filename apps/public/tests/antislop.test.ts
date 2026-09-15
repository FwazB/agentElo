import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import type { AntiSlopArena, AntiSlopMe, DuelView, OwnedEntry, SubmitEntryRequest } from "../../../packages/public-api/antislop.ts";
import type { Me } from "../../../packages/public-api/types.ts";
import { buildPlayerReceipt } from "../../../packages/elo-engine/src/receipts.ts";

// Mounted component tests; no browser, provider, production data, or GUI control.
// Native dialog top-layer layout/focus trapping remains a browser responsibility.
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "https://antislop.test/", pretendToBeVisual: true });
const win = dom.window;
const prior = new Map<string, PropertyDescriptor | undefined>();
function install(name: string, value: unknown) { prior.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); }
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLDialogElement", "Event", "MouseEvent", "Node"] as const) install(name, name === "window" ? win : name === "document" ? win.document : win[name]);
install("IS_REACT_ACT_ENVIRONMENT", true);
install("requestAnimationFrame", win.requestAnimationFrame.bind(win)); install("cancelAnimationFrame", win.cancelAnimationFrame.bind(win));
win.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
win.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); queueMicrotask(() => this.dispatchEvent(new win.Event("close"))); };
const { createRoot } = await import("react-dom/client");
const requirePublic = createRequire(new URL("../package.json", import.meta.url));
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../components/antislop.tsx", import.meta.url))], bundle: true, write: false, format: "esm", platform: "browser", jsx: "automatic", logLevel: "silent",
  plugins: [{ name: "test-surface-boundaries", setup(builder) {
    builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: pathToFileURL(requirePublic.resolve(args.path)).href, external: true }));
    builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: "next-link", namespace: "test" }));
    builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({ loader: "js", contents: "import{createElement}from'react';export default function Link({children,...props}){return createElement('a',props,children)}" }));
    builder.onResolve({ filter: /\.module\.css$/ }, () => ({ path: "styles", namespace: "styles" }));
    builder.onLoad({ filter: /.*/, namespace: "styles" }, () => ({ loader: "js", contents: "export default new Proxy({}, {get:(_,name)=>String(name)})" }));
  } }],
});
const { AntiSlop } = await import(`data:text/javascript;base64,${Buffer.from(`${bundle.outputFiles[0]!.text}\n//# sourceURL=antislop-test-bundle.js`).toString("base64")}`);
const playerId = `p_${"1".repeat(32)}`;
const windowValue = { startsAt: "2026-09-08T12:00:00.000Z", endsAt: "2026-09-15T12:00:00.000Z" };
const user: Me = { player: { id: playerId, username: "player_one", receipt: null }, matches: [], usernames: {}, queue: [], formLocked: false };
const draft = () => ({ version: "antislop.entry-draft.v1", status: "ready", window: windowValue, summary: "PRIVATE-EVIDENCE-CANARY: fixed retries.", accomplishments: [{ id: "a1", outcome: "Retries preserve the original order.", evidenceIds: ["e1"] }], evidence: [{ id: "e1", kind: "check", excerpt: "Private check: two requests, one order.", occurredAt: "2026-09-14" }], publicSummary: null });
const arena: AntiSlopArena = { serverNow: "2026-09-15T12:30:00.000Z", season: { seasonId: "pilot", phase: "pilot", judgeFingerprint: `sha256:${"1".repeat(64)}`, ratingEligible: false }, entries: [], duels: [], limits: { duelsPerPlayerPerDay: 10, duelsGlobalPerDay: 100, maxInFlightPerPlayer: 1 } };
const ownEntry = (): OwnedEntry => ({ entryId: `ae_${"1".repeat(32)}`, participantId: playerId, username: "player_one", window: windowValue, publicSummary: null, createdAt: arena.serverNow, optedIn: true, entry: { ...draft(), version: "antislop.entry.v1", entryId: `ae_${"1".repeat(32)}`, participantId: playerId, refereeConsent: { approved: true, approvedAt: arena.serverNow } } as OwnedEntry["entry"] });
let owned: AntiSlopMe = { entries: [], duels: [], quota: { day: "2026-09-15", used: 0, remaining: 10, inFlight: 0 } };
type Request = { url: string; method: string; body: Record<string, unknown> | null; headers: Headers };
let requests: Request[] = [];
let handler: ((request: Request) => Response | Promise<Response> | undefined) | undefined;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const request: Request = { url: String(url), method: options?.method ?? "GET", body: options?.body ? JSON.parse(String(options.body)) : null, headers: new Headers(options?.headers) };
  assert.ok(request.url.startsWith("/api/antislop/") || request.url.startsWith("/api/guest/"), "Only local mock API routes are allowed"); requests.push(request);
  const result = handler?.(request); if (result !== undefined) return result;
  if (request.url === "/api/antislop/arena") return Response.json(arena);
  if (request.url === "/api/antislop/me") return Response.json(owned);
  if (request.url === "/api/antislop/prompt") return Response.json({ prompt: "Prepare an approved-context entry; do not submit it.", window: windowValue });
  throw new Error(`Unhandled mock ${request.method} ${request.url}`);
};
let root: Root | null = null;
const props = { me: user, sessionLoading: false, onGuestPlayer() {}, onAccount() {}, onOpenForm() {} };
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); }); }
async function mount(extra: Record<string, unknown> = {}) { root = createRoot(win.document.querySelector("#root")!); await act(async () => { root!.render(createElement(AntiSlop, { ...props, ...extra })); }); await flush(); }
const dialog = () => win.document.querySelector("dialog")!;
function button(text: string, scope: ParentNode = dialog().open ? dialog() : win.document): HTMLButtonElement { const result = [...scope.querySelectorAll("button")].find(item => item.textContent?.includes(text)); assert.ok(result, `Missing button: ${text}`); return result; }
async function click(element: HTMLElement) { await act(async () => { element.focus(); element.click(); }); await flush(); }
async function press(text: string) { await click(button(text)); }
async function type(id: string, value: string) { const element = win.document.getElementById(id) as HTMLTextAreaElement | HTMLInputElement; assert.ok(element); await act(async () => { Object.getOwnPropertyDescriptor(element instanceof win.HTMLInputElement ? win.HTMLInputElement.prototype : win.HTMLTextAreaElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new win.Event("input", { bubbles: true })); }); }
function checkbox(text: string): HTMLInputElement { const label = [...dialog().querySelectorAll("label")].find(item => item.textContent?.includes(text)); const result = label?.querySelector<HTMLInputElement>('input[type="checkbox"]'); assert.ok(result, `Missing checkbox: ${text}`); return result; }
const writes = () => requests.filter(request => request.method !== "GET");
async function review() { await press("Challenge a friend"); await type("antislop-entry-json", JSON.stringify(draft())); await press("Review my entry"); }

afterEach(async () => { if (root) { await act(async () => root!.unmount()); root = null; } win.document.querySelector("#root")!.replaceChildren(); win.document.body.style.overflow = ""; Reflect.deleteProperty(win.navigator, "locks"); requests = []; handler = undefined; owned = { entries: [], duels: [], quota: { day: "2026-09-15", used: 0, remaining: 10, inFlight: 0 } }; });
after(() => { globalThis.fetch = originalFetch; for (const [name, descriptor] of prior) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } dom.window.close(); });

test("paste/preview stay local, consent starts unchecked, and editing invalidates approval", async () => {
  await mount(); await review();
  assert.equal(writes().length, 0); assert.equal(dialog().open, true);
  assert.match(dialog().textContent!, /PRIVATE-EVIDENCE-CANARY/);
  assert.equal(win.document.querySelector("main")!.textContent!.includes("PRIVATE-EVIDENCE-CANARY"), false);
  for (const item of dialog().querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) assert.equal(item.checked, false);
  assert.equal(button("Approve & create").disabled, true);
  await click(checkbox("approve sending")); assert.equal(button("Approve & create").disabled, true);
  await click(checkbox("Allow challenges")); assert.equal(button("Approve & create").disabled, false);
  await type("antislop-entry-json", JSON.stringify({ ...draft(), summary: "Edited private work" }));
  assert.equal(dialog().textContent!.includes("PRIVATE-EVIDENCE-CANARY"), false);
  await press("Review my entry"); assert.equal(checkbox("approve sending").checked, false); assert.equal(checkbox("Allow challenges").checked, false);
  assert.equal(writes().length, 0);
});

test("public summary requires its own approval and entry retries preserve request identity", async () => {
  let attempts = 0;
  handler = request => {
    if (request.url === "/api/antislop/entries") {
      attempts++; if (attempts === 1) throw new Error("Connection interrupted");
      const entry = ownEntry(); entry.publicSummary = "A public note."; owned.entries = [entry]; return Response.json(entry);
    }
  };
  await mount(); await review(); await click(checkbox("approve sending")); await click(checkbox("Allow challenges")); await click(checkbox("Add a public summary"));
  assert.equal((win.document.getElementById("antislop-public-summary") as HTMLTextAreaElement).value, "");
  await type("antislop-public-summary", "First public note."); await click(checkbox("approve publishing"));
  await type("antislop-public-summary", "A public note."); assert.equal(checkbox("approve publishing").checked, false); assert.equal(button("Approve & create").disabled, true);
  await click(checkbox("approve publishing")); await press("Approve & create"); await press("Approve & create");
  const submitted = writes().filter(request => request.url === "/api/antislop/entries");
  assert.equal(submitted.length, 2); assert.equal(submitted[0]!.body!.requestId, submitted[1]!.body!.requestId);
  for (const request of submitted) assert.equal(request.headers.get("X-Expected-Player-Id"), playerId, "Existing-player evidence uploads must bind the approved identity");
  const body = submitted[1]!.body as unknown as SubmitEntryRequest;
  assert.deepEqual(body.publicSummary, { text: "A public note.", approved: true }); assert.equal(body.refereeApproved, true); assert.equal(body.optedIn, true);
  assert.match(dialog().textContent!, /Your work. Their move./); assert.equal(dialog().textContent!.includes("PRIVATE-EVIDENCE-CANARY"), false);
  assert.match((dialog().querySelector("input") as HTMLInputElement).value, /^https:\/\/antislop.test\/challenge\/ae_/);
});

test("insufficient context never enables an entry submission", async () => {
  await mount(); await press("Challenge a friend");
  await type("antislop-entry-json", JSON.stringify({ version: "antislop.entry-draft.v1", status: "insufficient_context", window: windowValue, reason: "no_safe_evidence" })); await press("Review my entry");
  assert.match(dialog().textContent!, /Nothing was submitted/); assert.equal(dialog().querySelectorAll('input[type="checkbox"]').length, 0); assert.equal(writes().length, 0);
});

test("shared duel links open a result modal with distinct unrated copy and close on Escape", async () => {
  const a = ownEntry(), b = { ...a, entryId: `ae_${"2".repeat(32)}`, participantId: `p_${"2".repeat(32)}`, username: "player_two" };
  const result: DuelView = { duelId: `ad_${"3".repeat(32)}`, seasonId: "pilot", state: "complete", a, b, outcome: "unrated", reason: "order_disagreement", judgeFingerprint: arena.season.judgeFingerprint, ratingEligible: false, createdAt: arena.serverNow, completedAt: arena.serverNow, canJudge: false, playerStats: { a: { formScore: 849, ratingMilli: 1_200_349, ratedMatches: 0 }, b: { formScore: null, ratingMilli: 1_250_800, ratedMatches: 2 } } };
  handler = request => request.url === `/api/antislop/duels/${result.duelId}` ? Response.json(result) : undefined;
  const receipt = buildPlayerReceipt({ player_id: playerId, competition_id: `c_${"2".repeat(32)}`, week_id: "2026-W37", form_score: 849, coverage_ppm: 700_000, certainty_ppm: 800_000 });
  await mount({ initialDuelId: result.duelId, me: { ...user, player: { ...user.player, receipt } } });
  assert.equal(dialog().open, true); assert.match(dialog().textContent!, /changed when the entry order changed/); assert.match(dialog().textContent!, /unrated/); assert.equal(dialog().textContent!.includes("PRIVATE-EVIDENCE-CANARY"), false);
  const stats = [...dialog().querySelectorAll("dl")];
  assert.equal(stats.length, 2); assert.match(stats[0]!.textContent!, /Form84\.9\/100Elo1200/); assert.match(stats[1]!.textContent!, /FormNot scored yetElo1251/);
  assert.match(dialog().textContent!, /Current public player stats/); assert.match(dialog().textContent!, /pilot verdict does not change Elo/);
  assert.equal(win.document.querySelector("main .formPanel strong")!.textContent, "84.9/100");
  await act(async () => { dialog().dispatchEvent(new win.Event("cancel", { cancelable: true })); }); await flush();
  assert.equal(dialog().open, false); assert.equal(win.document.body.style.overflow, "");
});

test("modal Escape restores focus to the opening control", async () => {
  await mount(); const opener = button("Challenge a friend"); await click(opener);
  assert.equal(dialog().open, true);
  await act(async () => { dialog().dispatchEvent(new win.Event("cancel", { cancelable: true })); }); await flush();
  assert.equal(win.document.activeElement, opener);
});

test("an approved entry starts an on-demand duel and requests the shared referee", async () => {
  const a = ownEntry(), b = { ...a, entryId: `ae_${"2".repeat(32)}`, participantId: `p_${"2".repeat(32)}`, username: "player_two" };
  owned.entries = [a];
  const pending: DuelView = { duelId: `ad_${"4".repeat(32)}`, seasonId: "pilot", state: "pending", a, b, outcome: null, reason: "pending", judgeFingerprint: arena.season.judgeFingerprint, ratingEligible: false, createdAt: arena.serverNow, completedAt: null, canJudge: true };
  handler = request => {
    if (request.url === "/api/antislop/arena") return Response.json({ ...arena, entries: [b] });
    if (request.url === "/api/antislop/duels") return Response.json(pending, { status: 202 });
    if (request.url === `/api/antislop/duels/${pending.duelId}/judge`) return Response.json({ ...pending, state: "complete", outcome: "draw", reason: "order_agreement", canJudge: false, completedAt: arena.serverNow });
  };
  await mount(); await press("Start a duel");
  assert.deepEqual(writes().map(request => request.url), ["/api/antislop/duels", `/api/antislop/duels/${pending.duelId}/judge`]);
  assert.equal(writes()[0]!.body!.entryId, a.entryId); assert.equal(writes()[0]!.body!.opponentEntryId, b.entryId);
  assert.match(dialog().textContent!, /well-earned draw/); assert.match(dialog().textContent!, /no Elo change/);
  assert.equal(dialog().textContent!.includes("PRIVATE-EVIDENCE-CANARY"), false);
  assert.equal(dialog().querySelectorAll("dl").length, 0, "Missing playerStats must not produce fabricated default scores");
});

test("guests start preparing immediately and need a name only for approved submission", async () => {
  await mount({ me: null });
  assert.doesNotMatch(win.document.querySelector("header")!.textContent!, /Sign in/);
  await press("Start playing");
  assert.equal(dialog().open, true); assert.match(dialog().textContent!, /Copy preparation prompt/);
  assert.equal(win.document.getElementById("antislop-player-name"), null);
  await type("antislop-entry-json", JSON.stringify(draft())); await press("Review my entry");
  assert.match(dialog().textContent!, /PRIVATE-EVIDENCE-CANARY/);
  await click(checkbox("approve sending")); await click(checkbox("Allow challenges"));
  assert.equal(button("Approve & start").disabled, true);
  await type("antislop-player-name", "player_one");
  assert.equal(button("Approve & start").disabled, false); assert.equal(writes().length, 0);
});

test("guest approval locks cookie bootstrap and player claim, retries the same entry, and keeps its share result after adoption", async () => {
  let locked = false, lockCalls = 0, attempts = 0, adopted = 0;
  Object.defineProperty(win.navigator, "locks", { configurable: true, value: { async request(name: string, task: () => Promise<Me>) { assert.equal(name, "antislop-guest-player"); assert.equal(locked, false); lockCalls++; locked = true; try { return await task(); } finally { locked = false; } } } });
  handler = request => {
    if (request.url.startsWith("/api/guest/")) assert.equal(locked, true);
    if (request.url === "/api/guest/session") return Response.json({ ok: true });
    if (request.url === "/api/guest/player") return Response.json(user);
    if (request.url === "/api/antislop/entries") {
      assert.equal(locked, false); attempts++; owned.entries = [ownEntry()];
      if (attempts === 1) throw new Error("Entry response lost. Retry safely.");
      return Response.json(ownEntry());
    }
  };
  const onGuestPlayer = (player: Me) => { adopted++; root!.render(createElement(AntiSlop, { ...props, me: player, onGuestPlayer })); };
  await mount({ me: null, onGuestPlayer }); await review(); await type("antislop-player-name", "player_one"); await click(checkbox("approve sending")); await click(checkbox("Allow challenges"));
  await press("Approve & create");
  assert.equal(adopted, 0); assert.match(dialog().textContent!, /PRIVATE-EVIDENCE-CANARY/); assert.equal((win.document.getElementById("antislop-player-name") as HTMLInputElement).value, "player_one");
  await press("Approve & create");
  assert.equal(adopted, 1); assert.equal(lockCalls, 2);
  assert.deepEqual(writes().map(request => request.url), ["/api/guest/session", "/api/guest/player", "/api/antislop/entries", "/api/guest/session", "/api/guest/player", "/api/antislop/entries"]);
  assert.deepEqual(writes()[1]!.body, { username: "player_one" }); assert.deepEqual(writes()[4]!.body, writes()[1]!.body);
  assert.deepEqual(writes()[2]!.body, writes()[5]!.body);
  for (const request of writes().filter(item => item.url === "/api/antislop/entries")) assert.equal(request.headers.get("X-Expected-Player-Id"), playerId, "Guest evidence uploads must bind the claimed identity");
  assert.match(dialog().textContent!, /Your work. Their move./); assert.doesNotMatch(win.document.body.textContent!, /PRIVATE-EVIDENCE-CANARY|recovery key/i);
  assert.match(win.document.querySelector("header")!.textContent!, /Your player/);
});

test("a guest follows a friend challenge through approval, player adoption, and the referee result", async () => {
  const a = ownEntry(), b = { ...a, entryId: `ae_${"2".repeat(32)}`, participantId: `p_${"2".repeat(32)}`, username: "player_two" };
  const pending: DuelView = { duelId: `ad_${"4".repeat(32)}`, seasonId: "pilot", state: "pending", a, b, outcome: null, reason: "pending", judgeFingerprint: arena.season.judgeFingerprint, ratingEligible: false, createdAt: arena.serverNow, completedAt: null, canJudge: true };
  handler = request => {
    if (request.url === `/api/antislop/entries/${b.entryId}`) return Response.json(b);
    if (request.url === "/api/guest/session") return Response.json({ ok: true });
    if (request.url === "/api/guest/player") return Response.json(user);
    if (request.url === "/api/antislop/entries") { owned.entries = [a]; return Response.json(a); }
    if (request.url === "/api/antislop/duels") return Response.json(pending, { status: 202 });
    if (request.url === `/api/antislop/duels/${pending.duelId}/judge`) return Response.json({ ...pending, state: "complete", outcome: "draw", reason: "order_agreement", canJudge: false, completedAt: arena.serverNow });
  };
  const onGuestPlayer = (player: Me) => root!.render(createElement(AntiSlop, { ...props, me: player, onGuestPlayer, initialChallengeId: b.entryId }));
  await mount({ me: null, onGuestPlayer, initialChallengeId: b.entryId }); await press("Accept challenge");
  await type("antislop-entry-json", JSON.stringify(draft())); await press("Review my entry"); await type("antislop-player-name", "player_one"); await click(checkbox("approve sending")); await click(checkbox("Allow challenges")); await press("Approve & start");
  assert.deepEqual(writes().map(request => request.url), ["/api/guest/session", "/api/guest/player", "/api/antislop/entries", "/api/antislop/duels", `/api/antislop/duels/${pending.duelId}/judge`]);
  assert.equal(writes()[3]!.body!.opponentEntryId, b.entryId);
  assert.match(dialog().textContent!, /well-earned draw/); assert.doesNotMatch(dialog().textContent!, /PRIVATE-EVIDENCE-CANARY|YOU’RE INVITED/);
});

test("an unrelated account transition cancels an in-flight guest continuation and clears its private draft", async () => {
  let resolveClaim!: (response: Response) => void, adopted = 0;
  handler = request => {
    if (request.url === "/api/guest/session") return Response.json({ ok: true });
    if (request.url === "/api/guest/player") return new Promise(resolve => { resolveClaim = resolve; });
  };
  await mount({ me: null, onGuestPlayer() { adopted++; } }); await review(); await type("antislop-player-name", "player_one"); await click(checkbox("approve sending")); await click(checkbox("Allow challenges")); await press("Approve & create");
  assert.equal(button("Saving approved entry").disabled, true);
  const other = { ...user, player: { ...user.player, id: `p_${"9".repeat(32)}`, username: "other_player" } };
  await act(async () => root!.render(createElement(AntiSlop, { ...props, me: other }))); await flush();
  await act(async () => resolveClaim(Response.json(user))); await flush();
  assert.equal(adopted, 0); assert.equal(writes().some(request => request.url === "/api/antislop/entries"), false);
  assert.doesNotMatch(win.document.body.textContent!, /PRIVATE-EVIDENCE-CANARY/);
});

test("an entry identity mismatch preserves exact approval and retry identity without adopting a guest or starting a duel", async () => {
  let rejectIdentity = true, adopted = 0;
  const a = ownEntry(), b = { ...a, entryId: `ae_${"2".repeat(32)}`, participantId: `p_${"2".repeat(32)}`, username: "player_two" };
  handler = request => {
    if (request.url === "/api/antislop/arena") return Response.json({ ...arena, entries: [b] });
    if (request.url === "/api/guest/session") return Response.json({ ok: true });
    if (request.url === "/api/guest/player") return Response.json(user);
    if (request.url === "/api/antislop/entries") {
      assert.equal(request.headers.get("X-Expected-Player-Id"), playerId);
      if (rejectIdentity) return Response.json({ error: "Your player changed in another tab. Restore the approved player before retrying." }, { status: 409 });
      owned.entries = [ownEntry()]; return Response.json(ownEntry());
    }
    if (request.url === "/api/antislop/duels") return Response.json({ duelId: `ad_${"4".repeat(32)}`, seasonId: "pilot", state: "complete", a, b, outcome: "draw", reason: "order_agreement", judgeFingerprint: arena.season.judgeFingerprint, ratingEligible: false, createdAt: arena.serverNow, completedAt: arena.serverNow, canJudge: false });
  };
  const onGuestPlayer = (player: Me) => { adopted++; root!.render(createElement(AntiSlop, { ...props, me: player, onGuestPlayer })); };
  await mount({ me: null, onGuestPlayer }); await press("Start a duel");
  const source = JSON.stringify(draft());
  await type("antislop-entry-json", source); await press("Review my entry"); await type("antislop-player-name", "player_one");
  await click(checkbox("approve sending")); await click(checkbox("Allow challenges")); await press("Approve & start");
  assert.equal(adopted, 0); assert.equal(dialog().open, true);
  assert.match(dialog().textContent!, /Your player changed in another tab/); assert.match(dialog().textContent!, /PRIVATE-EVIDENCE-CANARY/);
  assert.equal((win.document.getElementById("antislop-entry-json") as HTMLTextAreaElement).value, source);
  assert.equal(checkbox("approve sending").checked, true); assert.equal(checkbox("Allow challenges").checked, true);
  assert.equal(button("Approve & start").disabled, false);
  assert.equal(writes().some(request => request.url.includes("/duels")), false);
  const first = writes().find(request => request.url === "/api/antislop/entries")!;
  rejectIdentity = false; await press("Approve & start");
  const attempts = writes().filter(request => request.url === "/api/antislop/entries");
  assert.equal(attempts.length, 2); assert.deepEqual(attempts[1]!.body, first.body); assert.equal(attempts[1]!.headers.get("X-Expected-Player-Id"), first.headers.get("X-Expected-Player-Id"));
  assert.equal(adopted, 1); assert.match(dialog().textContent!, /well-earned draw/);
});

test("expired entries lead to preparation instead of a doomed duel request", async () => {
  const expired = ownEntry(); expired.window = { startsAt: "2026-09-01T12:00:00.000Z", endsAt: "2026-09-08T12:00:00.000Z" }; owned.entries = [expired];
  await mount(); assert.match(win.document.querySelector("main")!.textContent!, /Entry expired/); await press("Start a duel");
  assert.match(dialog().textContent!, /Let the work speak/); assert.equal(writes().length, 0);
});

test("signout clears pasted private material before another account can render it", async () => {
  await mount(); await review();
  await act(async () => root!.render(createElement(AntiSlop, { ...props, me: null }))); await flush();
  assert.equal(dialog().open, false); assert.equal(win.document.body.textContent!.includes("PRIVATE-EVIDENCE-CANARY"), false);
  assert.equal(writes().length, 0);
});
