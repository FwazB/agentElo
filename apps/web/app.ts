type Side = "a" | "b";
type Mode = "binary" | "scalar";
type Preset = "rated" | "low_confidence" | "established";
type DraftField = "form" | "coverage" | "certainty";

interface DraftPlayer {
  form: number;
  coverage: number;
  certainty: number;
}

interface StreamState {
  rating_milli: number;
  rated_matches: number;
}

interface RoomPlayer {
  form: number;
  coverage_ppm: number;
  certainty_ppm: number;
  effective_confidence_ppm: number;
  streams: Record<Mode, StreamState>;
}

interface HistoryEntry {
  applied_delta_milli_a: number;
  exhibition_reasons: string[];
  form_a: number;
  form_b: number;
  k: number;
  mode: Mode;
  rating_effect: "rated" | "exhibition";
  sequence: number;
}

interface RoomState {
  revision: number;
  history: HistoryEntry[];
  players: Record<Side, RoomPlayer>;
}

interface DuelPlayerResult {
  applied_delta_milli: number;
  rating_after_milli: number;
}

interface DuelResult {
  calculation: {
    actual_score_a: string;
    confidence_ppm: number;
    expected_score_a: string;
    k: number;
  };
  exhibition_reasons: string[];
  formula_version: string;
  mode: Mode;
  players: Record<Side, DuelPlayerResult>;
  rating_effect: "rated" | "exhibition";
  state: RoomState;
}

interface ResetResult {
  reset: true;
  state: RoomState;
}

interface ErrorPayload {
  error?: { message?: string };
  state?: RoomState;
}

class ApiError extends Error {
  constructor(message: string, readonly payload: ErrorPayload) {
    super(message);
  }
}

const SIDES: readonly Side[] = ["a", "b"];
const DRAFT_FIELDS: readonly DraftField[] = ["form", "coverage", "certainty"];

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing required element: #${id}`);
  return element as T;
}

function isMode(value: string | undefined): value is Mode {
  return value === "binary" || value === "scalar";
}

function isPreset(value: string | undefined): value is Preset {
  return value === "rated" || value === "low_confidence" || value === "established";
}

const roomOrigin: string = window.location.origin;
const fragmentToken = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
let storedToken = "";
try {
  if (fragmentToken) window.sessionStorage.setItem("computerEloRoomToken", fragmentToken);
  storedToken = window.sessionStorage.getItem("computerEloRoomToken") || "";
} catch {
  storedToken = "";
}
const token = fragmentToken || storedToken;
if (fragmentToken) window.history.replaceState(null, "", window.location.pathname);
const modeButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-mode]")];
const presetButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-preset]")];

let room: RoomState | null = null;
let mode: Mode = "scalar";
let compatible = true;
let activePreset: Preset | "custom" = "rated";
let lastCardSvg = "";
const drafts: Record<Side, DraftPlayer> = {
  a: { form: 700, coverage: 90, certainty: 80 },
  b: { form: 500, coverage: 75, certainty: 60 },
};

const controls: Record<Side, Record<DraftField, HTMLInputElement>> = {
  a: { form: byId("a-form"), coverage: byId("a-coverage"), certainty: byId("a-certainty") },
  b: { form: byId("b-form"), coverage: byId("b-coverage"), certainty: byId("b-certainty") },
};

function requestId(): string {
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function formatRating(milli: number): string {
  return (milli / 1000).toFixed(3);
}

function formatDelta(milli: number): string {
  if (milli === 0) return "0.000";
  return `${milli > 0 ? "+" : "−"}${(Math.abs(milli) / 1000).toFixed(3)}`;
}

function formatPercentFromPpm(ppm: number, digits = 0): string {
  return `${(ppm / 10000).toFixed(digits)}%`;
}

function clearResult(): void {
  byId("result-panel").hidden = true;
  byId("share-card-section").hidden = true;
  lastCardSvg = "";
}

function effectiveConfidence(side: Side): number {
  const player = drafts[side];
  return Math.min(player.coverage, player.certainty);
}

function currentStream(side: Side): StreamState {
  return room?.players[side].streams[mode] ?? { rating_milli: 1200000, rated_matches: 0 };
}

function syncDrafts(state: RoomState): void {
  for (const side of SIDES) {
    const player = state.players[side];
    drafts[side] = {
      form: player.form,
      coverage: player.coverage_ppm / 10000,
      certainty: player.certainty_ppm / 10000,
    };
  }
}

function applyRoom(state: RoomState, updateDrafts = true): void {
  room = state;
  if (updateDrafts) syncDrafts(state);
  renderAll();
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("X-Computer-Elo-Token", token);
  const response = await fetch(path, { ...options, headers });
  const data = await response.json() as T & ErrorPayload;
  if (!response.ok) {
    throw new ApiError(data.error?.message || "The local server rejected the request.", data);
  }
  return data;
}

function setConnection(online: boolean, message: string): void {
  const dot = byId("server-dot");
  dot.classList.toggle("online", online);
  dot.classList.toggle("offline", !online);
  byId("server-state").textContent = message;
  byId<HTMLButtonElement>("run-duel").disabled = !online;
}

function renderPlayer(side: Side): void {
  const draft = drafts[side];
  const stream = currentStream(side);
  controls[side].form.value = String(draft.form);
  controls[side].coverage.value = String(draft.coverage);
  controls[side].certainty.value = String(draft.certainty);
  byId(`${side}-form-value`).textContent = String(draft.form);
  byId(`${side}-coverage-value`).textContent = `${draft.coverage}%`;
  byId(`${side}-certainty-value`).textContent = `${draft.certainty}%`;
  byId(`${side}-rating`).textContent = formatRating(stream.rating_milli);
  byId(`${side}-matches`).textContent = `${stream.rated_matches} rated ${stream.rated_matches === 1 ? "match" : "matches"}`;
  byId(`${side}-mode-label`).textContent = mode === "binary" ? "Binary" : "Scalar";
  const stage = byId(`${side}-stage`);
  stage.textContent = stream.rated_matches < 5 ? "Provisional" : "Established";
  stage.classList.toggle("established", stream.rated_matches >= 5);
  const effective = effectiveConfidence(side);
  const confidence = byId(`${side}-confidence`);
  confidence.textContent = `Effective confidence ${effective}%`;
  confidence.classList.toggle("low", effective < 50);
}

function gateReasons(): string[] {
  const reasons: string[] = [];
  if (!compatible) reasons.push("incompatible context");
  if (Math.min(effectiveConfidence("a"), effectiveConfidence("b")) < 50) reasons.push("low confidence");
  return reasons;
}

function renderGate(): void {
  const preview = byId("gate-preview");
  const button = byId<HTMLButtonElement>("run-duel");
  const reasons = gateReasons();
  const confidence = Math.min(effectiveConfidence("a"), effectiveConfidence("b"));
  const k = currentStream("a").rated_matches < 5 || currentStream("b").rated_matches < 5 ? 64 : 32;
  if (reasons.length) {
    preview.textContent = `Exhibition · ${reasons.join(" + ")} · no Elo change`;
    preview.classList.add("exhibition-preview");
    button.textContent = `Preview ${mode} exhibition`;
  } else {
    preview.textContent = `Rated · confidence ${confidence}% · K=${k}`;
    preview.classList.remove("exhibition-preview");
    button.textContent = `Run ${mode} duel`;
  }
}

function renderHistory(): void {
  const list = byId("match-history");
  list.replaceChildren();
  const history = room?.history || [];
  if (!history.length) {
    const empty = document.createElement("li");
    empty.className = "empty-history";
    empty.textContent = "Run a duel to start the room trail.";
    list.append(empty);
    return;
  }
  history.forEach((entry) => {
    const item = document.createElement("li");
    const modeLabel = document.createElement("span");
    modeLabel.className = "history-mode";
    modeLabel.textContent = entry.mode;
    const summary = document.createElement("span");
    summary.textContent = entry.rating_effect === "rated"
      ? `Form ${entry.form_a} vs ${entry.form_b} · K=${entry.k}`
      : entry.exhibition_reasons.map((reason) => reason.replaceAll("_", " ")).join(" + ");
    const delta = document.createElement("span");
    delta.className = `history-delta${entry.rating_effect === "rated" ? "" : " exhibition"}`;
    delta.textContent = entry.rating_effect === "rated" ? `${formatDelta(entry.applied_delta_milli_a)} A` : "No change";
    item.append(modeLabel, summary, delta);
    list.append(item);
  });
}

function renderAll(): void {
  renderPlayer("a");
  renderPlayer("b");
  modeButtons.forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  presetButtons.forEach((button) => button.classList.toggle("active", button.dataset.preset === activePreset));
  byId("mode-explainer").textContent = mode === "scalar"
    ? "Magnitude matters: a wider Form gap produces a stronger match score."
    : "Higher Form wins, equal Form draws. The size of the gap does not matter.";
  byId<HTMLInputElement>("compatible").checked = compatible;
  renderGate();
  renderHistory();
}

function duelPayload(): {
  compatible: boolean;
  expected_revision: number;
  mode: Mode;
  players: Record<Side, { form: number; coverage_ppm: number; certainty_ppm: number }>;
  request_id: string;
} {
  if (room === null) throw new Error("Room state is unavailable");
  const players = {} as Record<Side, { form: number; coverage_ppm: number; certainty_ppm: number }>;
  for (const side of SIDES) {
    players[side] = {
      form: drafts[side].form,
      coverage_ppm: drafts[side].coverage * 10000,
      certainty_ppm: drafts[side].certainty * 10000,
    };
  }
  return {
    compatible,
    expected_revision: room.revision,
    mode,
    players,
    request_id: requestId(),
  };
}

function renderResult(result: DuelResult): void {
  const panel = byId("result-panel");
  const rated = result.rating_effect === "rated";
  panel.hidden = false;
  panel.classList.toggle("exhibition", !rated);
  byId("result-badge").textContent = rated ? "Rated match" : "Exhibition";
  byId("result-headline").textContent = rated ? "Ratings updated" : "Ratings protected";
  byId("result-reason").textContent = rated
    ? "Compatibility was self-attested and confidence cleared the rating gate."
    : result.exhibition_reasons.map((reason) => reason.replaceAll("_", " ")).join(" · ");
  byId("result-context").textContent = `${result.mode === "binary" ? "Binary" : "Scalar"} stream · room revision ${result.state.revision}`;
  byId("result-delta-a").textContent = formatDelta(result.players.a.applied_delta_milli);
  byId("result-delta-b").textContent = formatDelta(result.players.b.applied_delta_milli);
  byId("calculation-grid").hidden = false;
  byId("result-k").textContent = String(result.calculation.k);
  byId("result-confidence").textContent = formatPercentFromPpm(result.calculation.confidence_ppm);
  byId("result-actual").textContent = `${(Number(result.calculation.actual_score_a) * 100).toFixed(2)}%`;
  byId("result-expected").textContent = `${(Number(result.calculation.expected_score_a) * 100).toFixed(2)}%`;
  renderShareCard(result);
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderError(error: unknown): void {
  const message = error instanceof Error ? error.message : "The local server rejected the request.";
  const payload = error instanceof ApiError ? error.payload : undefined;
  const panel = byId("result-panel");
  panel.hidden = false;
  panel.classList.add("exhibition");
  byId("result-badge").textContent = "Room notice";
  byId("result-headline").textContent = "Duel not applied";
  byId("result-reason").textContent = message;
  byId("result-context").textContent = "No rating state changed.";
  byId("result-delta-a").textContent = "0.000";
  byId("result-delta-b").textContent = "0.000";
  byId("calculation-grid").hidden = true;
  byId("share-card-section").hidden = true;
  lastCardSvg = "";
  if (payload?.state) applyRoom(payload.state, true);
}

function shareCardSvg(result: DuelResult): string {
  const rated = result.rating_effect === "rated";
  const modeLabel = result.mode.toUpperCase();
  const effectLabel = rated ? "RATED" : "EXHIBITION";
  const status = rated
    ? `${formatDelta(result.players.a.applied_delta_milli)} / ${formatDelta(result.players.b.applied_delta_milli)} ELO`
    : "NO RATING CHANGE";
  const gate = rated ? "SELF-ATTESTED COMPATIBLE · CONFIDENCE GATE PASSED" : "RATING PROTECTED BY ELIGIBILITY GATE";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675" role="img" aria-label="Computer Elo ${effectLabel.toLowerCase()} card">
  <defs><linearGradient id="card-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#070d0a"/><stop offset="1" stop-color="#142018"/></linearGradient><linearGradient id="card-accent" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#7cff6b"/><stop offset="1" stop-color="#36e4c3"/></linearGradient></defs>
  <rect width="1200" height="675" fill="url(#card-bg)"/><circle cx="1110" cy="60" r="190" fill="#7cff6b" opacity=".06"/><circle cx="60" cy="660" r="220" fill="#36e4c3" opacity=".04"/>
  <text x="72" y="72" fill="#7cff6b" font-family="Inter,ui-sans-serif,system-ui,sans-serif" font-size="24" font-weight="800" letter-spacing="3">COMPUTER ELO · ${modeLabel} · ${effectLabel}</text>
  <text x="1128" y="72" fill="#91a69b" font-family="Inter,ui-sans-serif,system-ui,sans-serif" font-size="18" text-anchor="end">K=${result.calculation.k}</text><line x1="72" y1="100" x2="1128" y2="100" stroke="#2b4435"/>
  <text x="300" y="170" fill="#f5fff8" font-family="Inter,ui-sans-serif,system-ui,sans-serif" font-size="28" font-weight="700" text-anchor="middle">PLAYER A</text><text x="900" y="170" fill="#f5fff8" font-family="Inter,ui-sans-serif,system-ui,sans-serif" font-size="28" font-weight="700" text-anchor="middle">PLAYER B</text>
  <text x="300" y="325" fill="#f5fff8" font-family="Inter,ui-sans-serif,system-ui,sans-serif" font-size="112" font-weight="900" text-anchor="middle">${formatRating(result.players.a.rating_after_milli)}</text><text x="900" y="325" fill="#f5fff8" font-family="Inter,ui-sans-serif,system-ui,sans-serif" font-size="112" font-weight="900" text-anchor="middle">${formatRating(result.players.b.rating_after_milli)}</text><text x="600" y="285" fill="#91a69b" font-family="Inter,ui-sans-serif,system-ui,sans-serif" font-size="42" font-weight="800" text-anchor="middle">VS</text>
  <text x="300" y="375" fill="#91a69b" font-family="Inter,ui-sans-serif,system-ui,sans-serif" font-size="22" text-anchor="middle">${rated ? formatDelta(result.players.a.applied_delta_milli) : "0.000"} ELO</text><text x="900" y="375" fill="#91a69b" font-family="Inter,ui-sans-serif,system-ui,sans-serif" font-size="22" text-anchor="middle">${rated ? formatDelta(result.players.b.applied_delta_milli) : "0.000"} ELO</text>
  <rect x="340" y="425" width="520" height="68" rx="34" fill="#7cff6b" opacity=".12" stroke="#7cff6b"/><text x="600" y="469" fill="#7cff6b" font-family="Inter,ui-sans-serif,system-ui,sans-serif" font-size="25" font-weight="900" text-anchor="middle">${status}</text>
  <line x1="72" y1="530" x2="1128" y2="530" stroke="#2b4435"/><text x="72" y="574" fill="#7cff6b" font-family="Inter,ui-sans-serif,system-ui,sans-serif" font-size="19" font-weight="800">NO RAW ACTIVITY OR PRIVATE EVIDENCE INCLUDED</text><text x="72" y="612" fill="#91a69b" font-family="Inter,ui-sans-serif,system-ui,sans-serif" font-size="16">${gate}</text><text x="1128" y="642" fill="#91a69b" font-family="Inter,ui-sans-serif,system-ui,sans-serif" font-size="14" text-anchor="end">${result.formula_version} · LOCAL DEMO</text>
</svg>`;
}

function renderShareCard(result: DuelResult): void {
  lastCardSvg = shareCardSvg(result);
  const parsed = new DOMParser().parseFromString(lastCardSvg, "image/svg+xml");
  const preview = byId("share-card-preview");
  preview.replaceChildren(document.importNode(parsed.documentElement, true));
  byId("share-card-section").hidden = false;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadSvg(): void {
  if (!lastCardSvg) return;
  downloadBlob(new Blob([lastCardSvg], { type: "image/svg+xml;charset=utf-8" }), "computer-elo-match.svg");
}

function downloadPng(): void {
  if (!lastCardSvg) return;
  const svgUrl = URL.createObjectURL(new Blob([lastCardSvg], { type: "image/svg+xml;charset=utf-8" }));
  const image = new Image();
  image.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 675;
    canvas.getContext("2d")?.drawImage(image, 0, 0, 1200, 675);
    canvas.toBlob((blob) => {
      if (blob) downloadBlob(blob, "computer-elo-match.png");
      URL.revokeObjectURL(svgUrl);
    }, "image/png");
  };
  image.onerror = () => URL.revokeObjectURL(svgUrl);
  image.src = svgUrl;
}

async function runDuel(): Promise<void> {
  if (!room) return;
  const button = byId<HTMLButtonElement>("run-duel");
  button.disabled = true;
  try {
    const result = await api<DuelResult>("/api/duel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(duelPayload()),
    });
    applyRoom(result.state, true);
    renderResult(result);
  } catch (error) {
    renderError(error);
  } finally {
    button.disabled = false;
  }
}

async function resetPreset(preset: Preset): Promise<void> {
  if (!room) return;
  if (room.history.length && !window.confirm("Reset this shared room and erase its match trail for everyone?")) return;
  presetButtons.forEach((button) => { button.disabled = true; });
  try {
    const result = await api<ResetResult>("/api/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expected_revision: room.revision,
        preset,
        request_id: requestId(),
      }),
    });
    activePreset = preset;
    compatible = true;
    clearResult();
    applyRoom(result.state, true);
  } catch (error) {
    renderError(error);
  } finally {
    presetButtons.forEach((button) => { button.disabled = false; });
  }
}

async function copyLanLink(): Promise<void> {
  const value = `${roomOrigin}/#${token}`;
  const button = byId<HTMLButtonElement>("copy-link");
  const manual = byId<HTMLInputElement>("manual-link");
  let copied = false;
  try {
    await navigator.clipboard.writeText(value);
    copied = true;
  } catch {
    const field = document.createElement("textarea");
    field.value = value;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.append(field);
    field.select();
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    field.remove();
  }
  if (!copied) {
    manual.hidden = false;
    manual.value = value;
    manual.focus();
    manual.select();
    button.textContent = "Select the shown link";
    return;
  }
  manual.hidden = true;
  const original = button.textContent;
  button.textContent = "Link copied";
  window.setTimeout(() => { button.textContent = original; }, 1400);
}

async function refreshRoom(): Promise<void> {
  if (!token) return;
  try {
    const state = await api<RoomState>("/api/state");
    if (!room || state.revision !== room.revision) {
      if (room) clearResult();
      applyRoom(state, true);
    }
    setConnection(true, "Shared room online");
  } catch {
    setConnection(false, "Room unavailable");
  }
}

for (const side of SIDES) {
  for (const field of DRAFT_FIELDS) {
    controls[side][field].addEventListener("input", (event: Event) => {
      drafts[side][field] = Number((event.currentTarget as HTMLInputElement).value);
      activePreset = "custom";
      clearResult();
      renderPlayer(side);
      renderGate();
      presetButtons.forEach((button) => button.classList.remove("active"));
    });
  }
}

modeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const selectedMode = button.dataset.mode;
    if (!isMode(selectedMode)) return;
    mode = selectedMode;
    clearResult();
    renderAll();
  });
});
presetButtons.forEach((button) => button.addEventListener("click", () => {
  const preset = button.dataset.preset;
  if (isPreset(preset)) void resetPreset(preset);
}));
byId<HTMLInputElement>("compatible").addEventListener("change", (event: Event) => {
  compatible = (event.currentTarget as HTMLInputElement).checked;
  clearResult();
  renderGate();
});
byId("run-duel").addEventListener("click", () => { void runDuel(); });
byId("copy-link").addEventListener("click", copyLanLink);
byId("download-svg").addEventListener("click", downloadSvg);
byId("download-png").addEventListener("click", downloadPng);

if (!token) {
  setConnection(false, "Private link required");
  byId("result-panel").hidden = false;
  byId("result-panel").classList.add("exhibition");
  byId("result-badge").textContent = "Access needed";
  byId("result-headline").textContent = "Open the complete room link";
  byId("result-reason").textContent = "The capability token lives after # in the URL and is never sent in request paths.";
} else {
  refreshRoom();
  window.setInterval(refreshRoom, 2500);
}

renderAll();
