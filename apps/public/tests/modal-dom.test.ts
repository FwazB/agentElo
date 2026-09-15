import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { act, createElement, StrictMode } from "react";
import type { Root } from "react-dom/client";
import { buildPlayerReceipt } from "../../../packages/elo-engine/src/receipts.ts";
import type { Me, Overview, PlayerView } from "../../../packages/public-api/types.ts";

/**
 * Mounted React 19 tests, with actual DOM events, state, effects, and scheduling.
 * No browser, GUI, remote request, or production write is used. jsdom runs with
 * scripts/resources disabled. Next Link is the navigation boundary: a plain a
 * element keeps real click/default-prevention semantics without a Next router.
 * Missing dialog showModal/close are minimally polyfilled as open+close events.
 * We explicitly dispatch the cancel event a browser would produce for Escape.
 * This does NOT test top-layer inertness, native focus trapping, layout, actual
 * backdrop geometry, CSS, browser clipboard permissions, or hydration.
 */
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: "https://computer-elo.test/", pretendToBeVisual: true,
});
const win = dom.window;
const replacedGlobals = new Map<string, PropertyDescriptor | undefined>();
function installGlobal(key: string, value: unknown) {
  replacedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLDialogElement", "Event", "MouseEvent", "HashChangeEvent", "Node"] as const) {
  installGlobal(key, key === "window" ? win : key === "document" ? win.document : (win as any)[key]);
}
installGlobal("IS_REACT_ACT_ENVIRONMENT", true);
installGlobal("requestAnimationFrame", win.requestAnimationFrame.bind(win));
installGlobal("cancelAnimationFrame", win.cancelAnimationFrame.bind(win));
win.matchMedia = ((media: string) => ({ matches: true, media, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return true; }, onchange: null })) as typeof win.matchMedia;
win.scrollTo = () => {};
const copied: string[] = [];
Object.defineProperty(win.navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { copied.push(value); } } });
if (!win.HTMLDialogElement.prototype.showModal) win.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
if (!win.HTMLDialogElement.prototype.close) win.HTMLDialogElement.prototype.close = function () {
  if (!this.open) return;
  this.removeAttribute("open");
  queueMicrotask(() => this.dispatchEvent(new win.Event("close")));
};
const intervals = new Map<number, () => unknown>();
let intervalId = 0;
win.setInterval = ((callback: () => unknown) => { intervals.set(++intervalId, callback); return intervalId; }) as typeof win.setInterval;
win.clearInterval = ((id: number) => { intervals.delete(id); }) as typeof win.clearInterval;
const { createRoot } = await import("react-dom/client");
const requirePublic = createRequire(new URL("../package.json", import.meta.url));
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../components/league.tsx", import.meta.url))],
  bundle: true, write: false, format: "esm", platform: "node", jsx: "automatic", logLevel: "silent", loader: { ".module.css": "empty" },
  plugins: [{ name: "dom-navigation-boundary", setup(builder) {
    builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: pathToFileURL(requirePublic.resolve(args.path)).href, external: true }));
    builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: "next-link", namespace: "test-boundary" }));
    builder.onLoad({ filter: /.*/, namespace: "test-boundary" }, () => ({ loader: "js", contents: `import{createElement}from"react";export default function Link({children,...props}){return createElement('a',props,children)}` }));
  } }],
});
const { League } = await import(`data:text/javascript;base64,${Buffer.from(`${bundle.outputFiles[0]!.text}\n//# sourceURL=league-test-bundle.js`).toString("base64")}`);

const weekId = "2026-W37";
const playerId = `p_${"1".repeat(32)}`;
const competitionId = `c_${"2".repeat(32)}`;
const score = { weekId, formScore: 849, coveragePpm: 430000, certaintyPpm: 800000 };
function player(username = "local_player", withReceipt = false): Me {
  return { player: { id: playerId, username, receipt: withReceipt ? buildPlayerReceipt({ player_id: playerId, competition_id: competitionId, week_id: weekId, form_score: score.formScore, coverage_ppm: score.coveragePpm, certainty_ppm: score.certaintyPpm }) : null }, queue: [], matches: [], usernames: { [playerId]: username }, formLocked: false };
}
function overview(mode: "scalar" | "binary" = "scalar", username?: string): Overview {
  return { weekId, competitionId, mode, players: username ? [{ id: playerId, username, rank: null, ratingMilli: 1200000, ratedMatches: 0, formScore: 849, confidencePpm: 430000, weekId }] : [], matches: [], usernames: username ? { [playerId]: username } : {}, stats: { players: username ? 1 : 0, matches: 0, ratedPlayers: 0, queued: 0 } };
}
type RequestRecord = { url: string; method: string; body: any; signal: AbortSignal | undefined };
type Handler = (request: RequestRecord) => Response | Promise<Response> | undefined;
let root: Root | null = null;
let requests: RequestRecord[] = [];
let handler: Handler | undefined;
let currentPlayer: Me | null = player();
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const record = { url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null, signal: init?.signal ?? undefined };
  assert.ok(record.url.startsWith("/api/"), `External fetch forbidden: ${record.url}`);
  requests.push(record);
  const result = handler?.(record);
  if (result !== undefined) return result;
  if (record.url.startsWith("/api/overview")) return Response.json(overview(record.url.includes("binary") ? "binary" : "scalar"));
  if (record.url === "/api/me") return currentPlayer ? Response.json(currentPlayer) : Response.json({ error: "Not signed in" }, { status: 401 });
  if (record.url.startsWith("/api/users/")) return Response.json(player(decodeURIComponent(record.url.split("/").at(-1)!)));
  throw new Error(`Unhandled mock boundary: ${record.method} ${record.url}`);
};
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 24)); }); }
async function mount(props: Record<string, unknown> = {}, options: { signedIn?: boolean; hash?: string; strict?: boolean } = {}) {
  currentPlayer = options.signedIn === false ? null : currentPlayer;
  win.history.replaceState({ preserved: "router-state" }, "", `/${options.hash ?? ""}`);
  const container = win.document.querySelector("#root")!;
  root = createRoot(container);
  await act(async () => { root!.render(options.strict ? createElement(StrictMode, null, createElement(League, props)) : createElement(League, props)); });
  await flush();
}
async function rerender(props: Record<string, unknown>) { await act(async () => { root!.render(createElement(League, props)); }); await flush(); }
function dialog() { const element = win.document.querySelector<HTMLDialogElement>("dialog[data-view]")!; assert.ok(element); return element; }
function view() { return dialog().getAttribute("data-view"); }
function byId<T extends HTMLElement = HTMLElement>(id: string): T { const element = win.document.getElementById(id); assert.ok(element, `Missing #${id}`); return element as T; }
function findButton(label: string, container: ParentNode = dialog().open ? dialog() : win.document): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(item => item.textContent?.includes(label));
  assert.ok(found, `Missing button '${label}'; view=${view()}`); return found;
}
function hasButton(label: string) { return [...dialog().querySelectorAll("button")].some(item => item.textContent?.includes(label)); }
async function click(element: HTMLElement) { await act(async () => { element.focus(); element.click(); }); await flush(); }
async function press(label: string, container?: ParentNode) { await click(findButton(label, container)); }
async function type(id: string, value: string) {
  const element = byId<HTMLInputElement | HTMLTextAreaElement>(id);
  const prototype = element instanceof win.HTMLTextAreaElement ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value); element.dispatchEvent(new win.Event("input", { bubbles: true })); });
}
async function escape() { await act(async () => { dialog().dispatchEvent(new win.Event("cancel", { cancelable: true })); }); await flush(); }
async function hash(value: string) { await act(async () => { const oldURL = win.location.href; win.history.replaceState(win.history.state, "", `/#${value}`); win.dispatchEvent(new win.HashChangeEvent("hashchange", { oldURL, newURL: win.location.href })); }); await flush(); }
async function prepareSignup() { await press("Let’s play", win.document); await type("new-username", "local_player"); await press("That’s me"); assert.equal(view(), "key"); return byId<HTMLTextAreaElement>("new-recovery-key").value; }
async function saveKey() { await click(dialog().querySelector<HTMLInputElement>('input[type="checkbox"]')!); }
async function review(value: unknown) { await type("assessment-json", typeof value === "string" ? value : JSON.stringify(value)); await press("Preview my result"); }
const writes = () => requests.filter(item => item.method !== "GET");

afterEach(async () => {
  if (root) { await act(async () => { root!.unmount(); }); root = null; }
  assert.equal(intervals.size, 0, "Queue interval leaked after unmount");
  win.document.querySelector("#root")!.replaceChildren();
  win.document.body.style.overflow = "";
  win.localStorage.clear(); win.sessionStorage.clear();
  copied.length = 0; requests = []; handler = undefined; currentPlayer = player();
});
after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, previous] of replacedGlobals) { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); }
  dom.window.close();
});

test("real signup requires saving a key; lost responses preserve it for retry and recovery", async () => {
  let createCount = 0;
  handler = request => {
    if (request.url === "/api/players") { createCount++; if (createCount === 1) throw new Error("Lost signup response"); return Response.json({ ...player(), recoveryKey: request.body.token }); }
  };
  await mount({}, { signedIn: false });
  const key = await prepareSignup();
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(findButton("Create my profile").disabled, true);
  await press("Create my profile"); assert.equal(writes().length, 0);
  await escape(); assert.equal(view(), "key");
  await click(dialog()); assert.equal(view(), "key");
  await saveKey(); await press("Create my profile");
  assert.equal(view(), "key"); assert.match(dialog().textContent!, /Lost signup response/);
  assert.equal(byId<HTMLTextAreaElement>("new-recovery-key").value, key);
  assert.ok(hasButton("Try signing in with this saved key"));
  await press("Back to my name"); await press("That’s me");
  assert.equal(byId<HTMLTextAreaElement>("new-recovery-key").value, key);
  await press("Create my profile");
  assert.equal(view(), "rate");
  assert.equal(createCount, 2);
  assert.deepEqual(writes().map(item => item.body), [{ username: "local_player", token: key }, { username: "local_player", token: key }]);
  assert.equal(win.localStorage.length + win.sessionStorage.length, 0);
  assert.ok(!win.location.href.includes(key));
  assert.ok(!win.document.querySelector("main")!.textContent!.includes(key));
});

test("AntiSlop guests open Form with only a player name, preserving the separate legacy key flow", async () => {
  const pendingClaim = deferred<Response>();
  handler = request => {
    if (request.url === "/api/antislop/arena") return Response.json({ serverNow: "2026-09-15T12:30:00.000Z", entries: [], duels: [], season: { phase: "pilot", ratingEligible: false }, limits: { duelsPerPlayerPerDay: 10 } });
    if (request.url === "/api/antislop/me") return Response.json({ entries: [], duels: [], quota: { used: 0, remaining: 10, inFlight: 0 } });
    if (request.url === "/api/guest/session") return Response.json({ ok: true });
    if (request.url === "/api/guest/player") return pendingClaim.promise;
  };
  await mount({ surface: "antislop" }, { signedIn: false, strict: true });
  await press("Computer Form", win.document); assert.equal(view(), "join");
  await type("new-username", "local_player"); await press("That’s me");
  assert.equal(view(), "join"); assert.equal(findButton("Getting your player ready").disabled, true);
  assert.equal(byId<HTMLInputElement>("new-username").disabled, true);
  await press("Getting your player ready");
  assert.deepEqual(writes().map(({ url, body }) => ({ url, body })), [{ url: "/api/guest/session", body: {} }, { url: "/api/guest/player", body: { username: "local_player" } }]);
  await act(async () => pendingClaim.resolve(Response.json(player()))); await flush();
  assert.equal(view(), "rate"); assert.ok(hasButton("Copy my prompt"));
  assert.equal(win.document.getElementById("new-recovery-key"), null);
  assert.equal(win.localStorage.length + win.sessionStorage.length, 0);
});

test("recovery and key rotation use real form events and retain a lost-response replacement", async () => {
  const recovered = player();
  handler = request => {
    if (request.url === "/api/session" && request.method === "POST") return Response.json(recovered);
    if (request.url === "/api/session/rotate") throw new Error("Lost rotation response");
  };
  await mount({}, { signedIn: false });
  await press("Let’s play", win.document); await press("Already in the club");
  await type("recovery-token", "a".repeat(64)); await press("Let me in");
  assert.equal(view(), "rate"); assert.equal(writes()[0]!.body.token, "a".repeat(64));
  await escape(); await press("@local_player", win.document);
  const details = dialog().querySelector("details")!; await click(details.querySelector("summary")!);
  await press("Replace recovery key"); const key = byId<HTMLTextAreaElement>("new-recovery-key").value;
  assert.equal(findButton("Replace old key").disabled, true);
  await saveKey(); await press("Replace old key"); await press("Replace old key");
  assert.equal(view(), "key"); assert.equal(byId<HTMLTextAreaElement>("new-recovery-key").value, key);
  assert.deepEqual(writes().filter(item => item.url.includes("rotate")).map(item => item.body), [{ replacementToken: key }, { replacementToken: key }]);
  await press("Try signing in with this saved key"); assert.equal(view(), "account");
  assert.equal(writes().at(-1)!.body.token, key);
  assert.equal(win.localStorage.length + win.sessionStorage.length, 0);
});

test("mounted score flow previews, clears stale/insufficient results, discards, and publishes only the aggregate", async () => {
  const pending = deferred<Response>();
  handler = request => request.url === "/api/assessment" ? pending.promise : undefined;
  await mount(); await press("Rate my week", win.document);
  await press("Copy my prompt");
  const assessmentPrompt = copied.at(-1)!;
  assert.match(assessmentPrompt, /authorize/);
  assert.match(assessmentPrompt, new RegExp(weekId));
  for (const dimension of [/output and closure \(30%\)/i, /focus and attention \(25%\)/i, /tools, automation, delegation and reuse \(20%\)/i, /verification and checks \(15%\)/i, /organization, privacy and recoverability \(10%\)/i]) {
    assert.match(assessmentPrompt, dimension, "The copied prompt must include every dimension and weight");
  }
  assert.match(assessmentPrompt, /direct estimate/i);
  assert.match(assessmentPrompt, /do not ask follow-up questions/i);
  assert.match(assessmentPrompt, /"aiSystem"/);
  assert.match(assessmentPrompt, /"contextSource"/);
  assert.doesNotMatch(dialog().textContent!, /answer.*questions|Copy follow-up/i);
  assert.equal(dialog().querySelector<HTMLTextAreaElement>('[aria-label="Full assessment prompt with evidence requirements"]')!.value, assessmentPrompt);
  const cases = [
    score,
    { status: "insufficient_evidence", weekId, missing: ["focus", "verification"] },
    score, { ...score, coveragePpm: 0 }, score, { ...score, certaintyPpm: 0 },
    { ...score, notes: "PRIVATE_CANARY" }, { ...score, weekId: "2026-W36" },
    { status: "insufficient_evidence", weekId, missing: ["focus", "focus"] },
  ];
  for (const candidate of cases) {
    await review(candidate);
    assert.equal(hasButton("Publish my score"), candidate === score);
    assert.ok(!dialog().querySelector(".notice")?.textContent?.includes("PRIVATE_CANARY"));
    assert.equal(writes().length, 0);
    if ("status" in candidate && candidate.missing.length === 2 && candidate.missing[1] === "verification") {
      assert.equal(dialog().querySelector(".receipt-preview"), null, "Insufficient evidence must clear the previous score preview");
      assert.match(dialog().querySelector(".insufficient-result")!.textContent!, /existing chat/);
      await press("Copy direct prompt");
      const directPrompt = copied.at(-1)!;
      assert.equal(directPrompt, assessmentPrompt);
      assert.equal(dialog().querySelector<HTMLTextAreaElement>('[aria-label="Direct assessment retry prompt"]')!.value, directPrompt);
      assert.equal(hasButton("Copy follow-up"), false);
      assert.equal(hasButton("Publish my score"), false);
      assert.equal(writes().length, 0);
    }
  }
  await review(score); assert.match(dialog().textContent!, /43%/); assert.match(dialog().textContent!, /exhibitions/);
  await press("Discard"); assert.equal(hasButton("Publish my score"), false);
  await review(score); await press("Publish my score");
  assert.equal(view(), "rate"); assert.equal(findButton("Publishing").disabled, true);
  await escape(); assert.equal(view(), "rate");
  assert.deepEqual(writes().map(({ url, body }) => ({ url, body })), [{ url: "/api/assessment", body: score }]);
  await act(async () => pending.resolve(Response.json(player("local_player", true)))); await flush();
  assert.equal(view(), "share"); assert.match(dialog().textContent!, /849/);
  const shareDraft = new URL(dialog().querySelector<HTMLAnchorElement>('a[href^="https://twitter.com/intent/tweet?"]')!.href);
  assert.equal(shareDraft.searchParams.get("text"), "My AI rated me with a 849/1000.\nWhat’s your Elo?");
  assert.equal(shareDraft.searchParams.get("url"), "https://antislop.org/u/local_player", "Public shares must use the canonical site even when opened on another origin");
  await press("Copy profile link");
  assert.equal(copied.at(-1), "https://antislop.org/u/local_player");
  assert.equal(writes().length, 1, "Publication must not enter a matchup or post to X");
  await escape(); await press("Rate my week", win.document);
  assert.equal(byId<HTMLTextAreaElement>("assessment-json").value, "");
});

test("modal navigation uses real events, restores focus/body scroll, and updates profile props", async () => {
  win.document.body.style.overflow = "scroll";
  await mount();
  const trigger = [...win.document.querySelectorAll("a")].find(item => item.textContent === "How to play")!;
  await click(trigger); assert.equal(view(), "help"); assert.equal(dialog().open, true);
  assert.equal(win.document.body.style.overflow, "hidden"); assert.equal(win.document.activeElement?.id, "dialog-title");
  dialog().scrollTop = 400;
  await press("Connect my AI"); assert.equal(view(), "connect"); assert.equal(dialog().scrollTop, 0);
  await escape(); assert.equal(dialog().open, false); assert.equal(win.document.body.style.overflow, "scroll");
  assert.equal(win.document.activeElement, trigger);
  await hash("help"); assert.equal(view(), "help");
  await act(async () => dialog().dispatchEvent(new win.MouseEvent("click", { bubbles: true, clientX: -1, clientY: -1 }))); await flush();
  assert.equal(dialog().open, false);
  await rerender({ initialProfile: { username: "alice" } }); assert.equal(view(), "profile"); assert.match(dialog().querySelector(".profile-heading")!.textContent!, /@alice/);
  await rerender({ initialProfile: { username: "bob" } }); assert.match(dialog().querySelector(".profile-heading")!.textContent!, /@bob/);
  assert.equal(win.document.querySelectorAll("main").length, 1); assert.equal(dialog().querySelectorAll("h1").length, 0);
  await click([...dialog().querySelectorAll("a")].find(item => item.textContent?.includes("How scoring works"))!); assert.equal(view(), "help");
});

test("a late scalar refresh cannot overwrite the newly selected binary leaderboard", async () => {
  const lateScalar = deferred<Response>(); let scalarReads = 0;
  handler = request => {
    if (request.url === "/api/assessment") return Response.json(player("local_player", true));
    if (request.url === "/api/overview?mode=scalar") return ++scalarReads === 1 ? Response.json(overview("scalar")) : lateScalar.promise;
    if (request.url === "/api/overview?mode=binary") return Response.json(overview("binary", "binary_player"));
  };
  await mount(); await press("Rate my week", win.document); await review(score); await press("Publish my score");
  assert.equal(view(), "share"); await escape();
  const tableSection = byId("leaderboard"); await click(tableSection.querySelector("summary")!); await press("Win / loss", tableSection);
  assert.match(tableSection.textContent!, /@binary_player/);
  await act(async () => lateScalar.resolve(Response.json(overview("scalar", "stale_scalar")))); await flush();
  assert.match(tableSection.textContent!, /@binary_player/);
  assert.doesNotMatch(tableSection.textContent!, /@stale_scalar/);
});

test("a late profile decode cannot replace a newer profile", async () => {
  const lateAlice = deferred<PlayerView>();
  handler = request => {
    if (request.url === "/api/users/alice") { const response = Response.json({}); response.json = () => lateAlice.promise; return response; }
  };
  await mount({ initialProfile: { username: "alice" } });
  const oldRead = requests.find(item => item.url === "/api/users/alice")!;
  await rerender({ initialProfile: { username: "bob" } });
  assert.equal(oldRead.signal?.aborted, true);
  assert.match(dialog().querySelector(".profile-heading")!.textContent!, /@bob/);
  await act(async () => lateAlice.resolve(player("alice"))); await flush();
  assert.match(dialog().querySelector(".profile-heading")!.textContent!, /@bob/);
});

test("a delayed receipt file cannot resurrect publication after a newer invalid result", async () => {
  const lateFile = deferred<string>();
  await mount(); await press("Rate my week", win.document);
  const input = dialog().querySelector<HTMLInputElement>('input[type="file"]')!;
  await click(input.closest("details")!.querySelector("summary")!);
  Object.defineProperty(input, "files", { configurable: true, value: [{ name: "player.json", size: 1500, text: () => lateFile.promise }] });
  await act(async () => { input.dispatchEvent(new win.Event("change", { bubbles: true })); });
  await review("not a result"); assert.equal(hasButton("Publish my score"), false);
  await act(async () => lateFile.resolve(JSON.stringify(player("local_player", true).player.receipt))); await flush();
  assert.equal(hasButton("Publish my score"), false);
  assert.equal(writes().length, 0);
});

test("pending read requests are cancelled on unmount and scroll is restored", async () => {
  const pending = deferred<Response>();
  handler = () => pending.promise;
  win.document.body.style.overflow = "auto";
  await mount({ initialProfile: { username: "alice" } }, { strict: true });
  const reads = requests.filter(item => item.method === "GET");
  await act(async () => { root!.unmount(); root = null; });
  await act(async () => pending.resolve(Response.json(player("alice")))); await flush();
  assert.equal(win.document.body.style.overflow, "auto");
  assert.ok(reads.length >= 3);
  for (const read of reads) assert.equal(read.signal?.aborted, true, `${read.url} did not cancel`);
});

test("copy feedback resets when navigating to a different public profile", async () => {
  await mount({ initialProfile: { username: "alice" } }); await press("Copy profile link");
  assert.equal(copied.at(-1), "https://antislop.org/u/alice"); assert.ok(hasButton("Copied"));
  await rerender({ initialProfile: { username: "bob" } });
  assert.ok(hasButton("Copy profile link"), "A previous player's copied state must not label a new link copied");
  await press("Copy profile link"); assert.equal(copied.at(-1), "https://antislop.org/u/bob");
});

test("hash and route-prop navigation cannot interrupt an unsaved key flow", async () => {
  await mount({}, { signedIn: false }); const key = await prepareSignup();
  await hash("help"); assert.equal(view(), "key");
  await rerender({ initialDialog: "help" });
  assert.equal(view(), "key"); assert.equal(byId<HTMLTextAreaElement>("new-recovery-key").value, key);
  assert.equal(writes().length, 0);
});

test("queue entry is explicit, slow polls do not overlap, and leaving preserves the Form lock", async () => {
  currentPlayer = player("local_player", true);
  let poll: ReturnType<typeof deferred<Response>> | null = null;
  handler = request => {
    if (request.url === "/api/queue" && request.method === "POST") {
      currentPlayer = { ...currentPlayer!, formLocked: true, queue: [{ mode: "scalar", weekId }] };
      return Response.json({ status: "queued", match: null });
    }
    if (request.url === "/api/queue?mode=scalar" && request.method === "DELETE") {
      currentPlayer = { ...currentPlayer!, queue: [] }; return Response.json({ ok: true });
    }
    if (request.url === "/api/me" && poll) return poll.promise;
  };
  await mount(); await press("Matchups", win.document);
  assert.equal(writes().length, 0); await press("Join a matchup");
  assert.deepEqual(writes()[0]!.body, { mode: "scalar" });
  assert.equal(intervals.size, 1); assert.ok(hasButton("Leave queue"));
  poll = deferred<Response>();
  const before = requests.length;
  await act(async () => { for (const tick of intervals.values()) { void tick(); void tick(); } });
  const reads = requests.slice(before).filter(item => item.url === "/api/me");
  assert.equal(reads.length, 1, "A slow queue poll must not start overlapping reads");
  const pending = poll; poll = null;
  await act(async () => pending.resolve(Response.json(currentPlayer))); await flush();
  await press("Leave queue"); assert.equal(intervals.size, 0);
  assert.equal(writes().at(-1)!.method, "DELETE");
  await hash("rate"); assert.match(dialog().textContent!, /score is locked/);
  assert.equal(win.document.getElementById("assessment-json"), null);
});

test("a pending queue poll is cancelled on sign-out and cannot restore an old account", async () => {
  currentPlayer = { ...player("local_player", true), formLocked: true, queue: [{ mode: "scalar", weekId }] };
  const pending = deferred<Response>(); let polling = false;
  handler = request => {
    if (request.url === "/api/me" && polling) return pending.promise;
    if (request.url === "/api/session" && request.method === "DELETE") return Response.json({ ok: true });
  };
  await mount(); polling = true;
  await act(async () => { for (const tick of intervals.values()) void tick(); });
  const read = requests.at(-1)!;
  await press("@local_player", win.document);
  await click(dialog().querySelector("summary")!); await press("Sign out");
  assert.equal(read.signal?.aborted, true);
  assert.equal(intervals.size, 0);
  await act(async () => pending.resolve(Response.json(currentPlayer))); await flush();
  assert.equal(win.document.querySelector(".home-player-card"), null);
  assert.ok(findButton("Let’s play", win.document));
});

test("a queue mutation finishing after unmount does not start follow-up reads", async () => {
  currentPlayer = player("local_player", true);
  const pending = deferred<Response>();
  handler = request => request.url === "/api/queue" ? pending.promise : undefined;
  await mount(); await press("Matchups", win.document); await press("Join a matchup");
  const count = requests.length;
  await act(async () => { root!.unmount(); root = null; });
  await act(async () => pending.resolve(Response.json({ status: "queued", match: null }))); await flush();
  assert.equal(requests.length, count, "Unmounted queue completion must not fetch account data");
});

test("closing a hash modal preserves the router's existing history state", async () => {
  await mount({}, { hash: "#help" });
  assert.equal(view(), "help"); await escape();
  assert.deepEqual(win.history.state, { preserved: "router-state" });
  assert.equal(win.location.hash, "");
});


test("AI context labels are previewed before publication, can be omitted, and reset for a new result", async () => {
  const scoredWithContext = { ...score, aiSystem: "chatgpt", contextSource: "saved_memory" };
  handler = request => {
    if (request.url === "/api/assessment") {
      const next = player("local_player", true);
      return Response.json({ ...next, player: { ...next.player,
        ...(request.body.aiSystem ? { assessmentContext: { aiSystem: request.body.aiSystem, contextSource: request.body.contextSource } } : {}) } });
    }
  };
  await mount(); await press("Rate my week", win.document); await review(scoredWithContext);
  const metadata = () => dialog().querySelector(".assessment-context-preview")!;
  assert.match(metadata().textContent!, /ChatGPT/);
  assert.match(metadata().textContent!, /saved memory/i);
  assert.match(metadata().textContent!, /labels will also be public/);
  assert.equal(byId<HTMLInputElement>("include-assessment-context").checked, true);
  assert.equal(writes().length, 0);
  await click(byId("include-assessment-context"));
  assert.match(metadata().textContent!, /will not be published/);
  assert.match(dialog().querySelector(".preview-stats")!.textContent!, /849/);
  assert.match(dialog().querySelector(".preview-stats")!.textContent!, /43%/);
  assert.equal(writes().length, 0);
  await press("Publish my score");
  assert.deepEqual(writes().at(-1)!.body, score);
  assert.equal(view(), "share");
  assert.equal(dialog().querySelector(".assessment-context-caption"), null);

  await escape(); await press("Rate my week", win.document); await review(scoredWithContext);
  assert.equal(byId<HTMLInputElement>("include-assessment-context").checked, true);
  await click(byId("include-assessment-context")); await press("Discard");
  assert.equal(dialog().querySelector(".assessment-context-preview"), null);
  await review(scoredWithContext);
  assert.equal(byId<HTMLInputElement>("include-assessment-context").checked, true);
  await click(byId("include-assessment-context"));
  await type("assessment-json", JSON.stringify({ ...scoredWithContext, aiSystem: "claude" }));
  assert.equal(dialog().querySelector(".assessment-context-preview"), null);
  await press("Preview my result");
  assert.equal(byId<HTMLInputElement>("include-assessment-context").checked, true);
  assert.match(metadata().textContent!, /Claude/);
  assert.equal(writes().length, 1);
  await press("Publish my score");
  assert.deepEqual(writes().at(-1)!.body, { ...scoredWithContext, aiSystem: "claude" });
  assert.match(dialog().querySelector(".assessment-context-caption")!.textContent!, /Claude/);
});

test("unknown assessment labels are safe and unexpected metadata never becomes publishable", async () => {
  await mount(); await press("Rate my week", win.document);
  await review({ ...score, aiSystem: "unknown", contextSource: "unknown" });
  assert.match(dialog().querySelector(".assessment-context-preview")!.textContent!, /unknown/i);
  for (const invalid of [
    { ...score, aiSystem: "chatgpt" },
    { ...score, contextSource: "saved_memory" },
    { ...score, aiSystem: "PRIVATE_CANARY", contextSource: "saved_memory" },
    { ...score, aiSystem: "chatgpt", contextSource: "PRIVATE_CANARY" },
    { ...score, aiSystem: "chatgpt", contextSource: "saved_memory", notes: "PRIVATE_CANARY" },
  ]) {
    await review(invalid);
    assert.equal(hasButton("Publish my score"), false);
    assert.equal(dialog().querySelector(".assessment-context-preview"), null);
    assert.doesNotMatch(dialog().querySelector(".notice")!.textContent!, /PRIVATE_CANARY/);
  }
  assert.equal(writes().length, 0);
  const publicPlayer = player("alice", true);
  handler = request => request.url === "/api/users/alice" ? Response.json({ ...publicPlayer, player: {
    ...publicPlayer.player, assessmentContext: { aiSystem: "PRIVATE_CANARY", contextSource: "__proto__" },
  } }) : undefined;
  await escape(); await rerender({ initialProfile: { username: "alice" } });
  const caption = dialog().querySelector(".assessment-context-caption")!;
  assert.match(caption.textContent!, /unknown/i);
  assert.doesNotMatch(caption.textContent!, /PRIVATE_CANARY|__proto__/);
});
