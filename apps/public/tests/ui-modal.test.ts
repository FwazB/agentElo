import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { buildPlayerReceipt } from "../../../packages/elo-engine/src/receipts.ts";

// These source-level component probes exercise real callbacks and JSX branches.
// Hooks and host elements are deliberately small stubs: this is not a browser,
// DOM accessibility audit, or a test of React's concurrent scheduling.
type Element = { type: string | Function; props: Record<string, any> };
type Probe = {
  names: string[]; values: Record<string, any>; stateIndex: number;
  refs: { current: any }[]; refIndex: number; effects: (() => unknown)[];
};
const probeKey = "__computerEloModalProbe";
const globals = globalThis as typeof globalThis & { [probeKey]: Probe };
const publicRoot = fileURLToPath(new URL("../", import.meta.url));

async function loadComponent(relative: string) {
  const path = `${publicRoot}${relative}`;
  const source = await readFile(path, "utf8");
  const names = [...source.matchAll(/const\s*\[\s*(\w+)\s*,[^\]]+\]\s*=\s*useState/g)].map(match => match[1]!);
  const hooks = `
    const p=()=>globalThis[${JSON.stringify(probeKey)}];
    export function useState(initial){const h=p(),name=h.names[h.stateIndex++];if(!Object.hasOwn(h.values,name))h.values[name]=typeof initial==='function'?initial():initial;return[h.values[name],v=>{h.values[name]=typeof v==='function'?v(h.values[name]):v}];}
    export const useEffect=f=>p().effects.push(f);
    export const useLayoutEffect=useEffect;
    export const useCallback=f=>f;
    export const useMemo=f=>f();
    export const useId=()=>"probe-dialog-title";
    export function useRef(initial){const h=p(),i=h.refIndex++;return h.refs[i]??=( {current:initial} );}
  `;
  const bundle = await build({
    entryPoints: [path], bundle: true, write: false, format: "esm", platform: "node",
    jsx: "automatic", jsxImportSource: "probe-jsx", logLevel: "silent",
    plugins: [{ name: "component-probe", setup(builder) {
      builder.onResolve({ filter: /^(react|next\/link|probe-jsx\/jsx-runtime)$/ }, args => ({ path: args.path, namespace: "probe" }));
      builder.onLoad({ filter: /.*/, namespace: "probe" }, args => ({ loader: "js", contents:
        args.path === "react" ? hooks : args.path === "next/link" ? `export default 'Link';` :
          `export const Fragment='Fragment';export const jsx=(type,props)=>({type,props});export const jsxs=jsx;`,
      }));
    } }],
  });
  const compiled = `${bundle.outputFiles[0]!.text}\n//# sourceURL=computer-elo-ui-probe.mjs`;
  const exports = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
  return { names, exports };
}

function start(names: string[], values: Record<string, unknown> = {}) {
  globals[probeKey] = { names, values, stateIndex: 0, refs: [], refIndex: 0, effects: [] };
}
function render(component: Function, props: Record<string, unknown> = {}) {
  const probe = globals[probeKey];
  probe.stateIndex = 0; probe.refIndex = 0; probe.effects = [];
  return component(props) as Element;
}
function elements(value: any, result: Element[] = []): Element[] {
  if (Array.isArray(value)) for (const child of value) elements(child, result);
  else if (value && typeof value === "object" && value.props) {
    result.push(value); elements(value.props.children, result);
  }
  return result;
}
function content(value: any): string {
  if (Array.isArray(value)) return value.map(content).join("");
  if (value && typeof value === "object") return content(value.props?.children);
  return typeof value === "string" ? value : "";
}
function byId(tree: Element, id: string) {
  const node = elements(tree).find(item => item.props.id === id);
  assert.ok(node, `Missing ${id}`); return node;
}
function button(tree: Element, label: string) {
  const node = elements(tree).find(item => item.type === "button" && content(item).includes(label));
  assert.ok(node, `Missing button ${label}`); return node;
}

const weekId = "2026-W37";
const account = { player: { id: `p_${"1".repeat(32)}`, username: "local_player", receipt: null }, queue: [], matches: [], usernames: {}, formLocked: false };
const overview = { weekId, players: [], matches: [], usernames: {}, stats: { players: 1, matches: 0, ratedPlayers: 0, queued: 0 } };
const score = { weekId, formScore: 849, coveragePpm: 430000, certaintyPpm: 800000 };

let loadedLeague: ReturnType<typeof loadComponent> | undefined;
async function league(values: Record<string, unknown> = {}) {
  const loaded = await (loadedLeague ??= loadComponent("components/league.tsx"));
  start(loaded.names, { me: account, overview, loading: false, sessionLoading: false, ...values });
  return () => render(loaded.exports.League);
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test("insufficient and invalid assessment results remove publication, while 43% stays shareable", async () => {
  const view = await league({ dialog: "rate" });
  const previousFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("No network is expected during review"); };
  try {
    const cases: [unknown, number][] = [
      [score, 1],
      [{ status: "insufficient_evidence", weekId, missing: ["focus", "verification"] }, 0],
      [score, 1],
      [{ ...score, coveragePpm: 0 }, 0],
      [{ ...score, certaintyPpm: 0 }, 0],
      [{ ...score, notes: "PRIVATE_CANARY" }, 0],
      [{ ...score, weekId: "2026-W36" }, 0],
      [{ status: "insufficient_evidence", weekId, missing: ["PRIVATE_CANARY"] }, 0],
    ];
    for (const [value, publishButtons] of cases) {
      byId(view(), "assessment-json").props.onChange({ target: { value: JSON.stringify(value) } });
      assert.equal(elements(view()).filter(item => item.type === "button" && content(item).includes("Publish my score")).length, 0);
      button(view(), "Preview my result").props.onClick();
      const tree = view();
      assert.equal(elements(tree).filter(item => item.type === "button" && content(item).includes("Publish my score")).length, publishButtons);
      assert.ok(!content(tree).includes("PRIVATE_CANARY"));
    }
    assert.equal(requests, 0);
  } finally { globalThis.fetch = previousFetch; }
});

test("signup requires a saved key and retains the same candidate after a lost response", async () => {
  const view = await league({ me: null, dialog: "join" });
  const previousFetch = globalThis.fetch;
  const requests: { url: string; body: any }[] = [];
  globalThis.fetch = async (url, init) => { requests.push({ url: String(url), body: JSON.parse(String(init?.body)) }); throw new Error("Simulated lost response"); };
  try {
    byId(view(), "new-username").props.onChange({ target: { value: "local_player" } });
    elements(view()).find(item => item.type === "form")!.props.onSubmit({ preventDefault() {} });
    const key = byId(view(), "new-recovery-key").props.value;
    assert.match(key, /^[0-9a-f]{64}$/);
    const disabled = button(view(), "Create my profile");
    assert.equal(disabled.props.disabled, true);
    disabled.props.onClick(); await settle();
    assert.equal(requests.length, 0, "The callback guard must also reject an unsaved key");
    elements(view()).find(item => item.type === "input" && item.props.type === "checkbox")!.props.onChange({ target: { checked: true } });
    button(view(), "Create my profile").props.onClick(); await settle();
    assert.deepEqual(requests[0], { url: "/api/players", body: { username: "local_player", token: key } });
    assert.equal(byId(view(), "new-recovery-key").props.value, key);
    button(view(), "Try signing in with this saved key");
    button(view(), "Create my profile").props.onClick(); await settle();
    assert.deepEqual(requests[1], requests[0]);
    button(view(), "Back to my name").props.onClick();
    elements(view()).find(item => item.type === "form")!.props.onSubmit({ preventDefault() {} });
    assert.equal(byId(view(), "new-recovery-key").props.value, key, "Reopening unchanged signup must not silently regenerate the key");
  } finally { globalThis.fetch = previousFetch; }
});

test("rotation requires saving the new key and preserves the retry candidate", async () => {
  const view = await league({ dialog: "account" });
  const previousFetch = globalThis.fetch;
  const requests: { url: string; body: any }[] = [];
  globalThis.fetch = async (url, init) => { requests.push({ url: String(url), body: JSON.parse(String(init?.body)) }); throw new Error("Simulated lost response"); };
  try {
    button(view(), "Replace recovery key").props.onClick();
    const key = byId(view(), "new-recovery-key").props.value;
    assert.match(key, /^[0-9a-f]{64}$/);
    const disabled = button(view(), "Replace old key");
    assert.equal(disabled.props.disabled, true);
    disabled.props.onClick(); await settle(); assert.equal(requests.length, 0);
    elements(view()).find(item => item.type === "input" && item.props.type === "checkbox")!.props.onChange({ target: { checked: true } });
    button(view(), "Replace old key").props.onClick(); await settle();
    button(view(), "Replace old key").props.onClick(); await settle();
    assert.deepEqual(requests, Array.from({ length: 2 }, () => ({ url: "/api/session/rotate", body: { replacementToken: key } })));
    assert.equal(byId(view(), "new-recovery-key").props.value, key);
  } finally { globalThis.fetch = previousFetch; }
});

test("embedded profiles preserve the page's main landmark and use a subordinate heading", async () => {
  const loaded = await loadComponent("components/player-profile.tsx");
  start(loaded.names, { data: account, loading: false, error: null });
  for (const [name, props] of [
    ["UserProfile", { username: "local_player", embedded: true }],
    ["PlayerProfile", { id: account.player.id, embedded: true }],
  ] as const) {
    const wrapper = render(loaded.exports[name], props);
    const tree = render(wrapper.type as Function, wrapper.props);
    assert.equal(elements(tree).filter(item => item.type === "main").length, 0);
    assert.equal(elements(tree).filter(item => item.type === "h1").length, 0);
    assert.ok(elements(tree).some(item => item.type === "h2" && content(item).includes("local_player")));
  }
});

test("opening matchups is read-only and queue entry requires its explicit button", async () => {
  const receipt = buildPlayerReceipt({ player_id: account.player.id, competition_id: `c_${"2".repeat(32)}`, week_id: weekId, form_score: 849, coverage_ppm: 430000, certainty_ppm: 800000 });
  const player = { ...account, player: { ...account.player, receipt } };
  const view = await league({ me: player, dialog: null });
  const previousFetch = globalThis.fetch;
  const requests: { url: string; method: string; body: any }[] = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    return Response.json(String(url).includes("/queue") ? { status: "queued", match: null } : String(url).includes("/overview") ? overview : player);
  };
  try {
    button(view(), "Matchups").props.onClick();
    const tree = view();
    assert.equal(globals[probeKey].values.dialog, "matches");
    assert.equal(requests.length, 0);
    const enter = elements(tree).find(item => item.type === "button" && /join|enter|find|queue/i.test(content(item)) && typeof item.props.onClick === "function");
    assert.ok(enter, "The matchup dialog needs an explicit queue action");
    enter.props.onClick(); await settle();
    const writes = requests.filter(item => item.method !== "GET");
    assert.deepEqual(writes, [{ url: "/api/queue", method: "POST", body: { mode: "scalar" } }]);
  } finally { globalThis.fetch = previousFetch; }
});

test("native dialog lifecycle focuses its title, restores the trigger, and protects key or busy flows", async () => {
  const view = await league({ dialog: "help" });
  const previous = Object.fromEntries(["window", "document", "HTMLElement", "requestAnimationFrame", "cancelAnimationFrame"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  class FocusTarget { isConnected = true; focusCount = 0; focus() { this.focusCount++; } }
  const trigger = new FocusTarget();
  const title = new FocusTarget();
  const frames: (() => unknown)[] = [];
  const element = { open: false, showCount: 0, closeCount: 0,
    showModal() { this.open = true; this.showCount++; }, close() { this.open = false; this.closeCount++; },
    querySelector(selector: string) { assert.equal(selector, "#dialog-title"); return title; },
    getBoundingClientRect() { return { left: 10, right: 100, top: 10, bottom: 100 }; },
  };
  const setGlobal = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const bodyStyle = { overflow: "scroll" };
  setGlobal("HTMLElement", FocusTarget); setGlobal("document", { activeElement: trigger, body: { style: bodyStyle } });
  setGlobal("window", { location: { hash: "", pathname: "/", search: "" }, history: { replaceState() {} } });
  setGlobal("requestAnimationFrame", (callback: () => unknown) => frames.push(callback)); setGlobal("cancelAnimationFrame", () => {});
  try {
    let tree = view();
    assert.equal(elements(tree).filter(item => item.type === "main").length, 1);
    let dialog = elements(tree).find(item => item.type === "dialog")!;
    assert.equal(dialog.props["aria-labelledby"], "dialog-title");
    assert.equal(byId(tree, "dialog-title").props.tabIndex, -1);
    dialog.props.ref.current = element;
    const restoreOverflow = globals[probeKey].effects.find(effect => String(effect).includes(".style.overflow"))!() as () => void;
    assert.equal(bodyStyle.overflow, "hidden");
    globals[probeKey].effects.find(effect => String(effect).includes(".showModal("))!();
    frames.shift()!();
    assert.equal(element.showCount, 1); assert.equal(title.focusCount, 1);
    dialog.props.onClick({ target: element, currentTarget: element, clientX: 50, clientY: 50 });
    assert.equal(globals[probeKey].values.dialog, "help", "An empty interior click must not dismiss the dialog");
    let prevented = false;
    dialog.props.onCancel({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true); assert.equal(globals[probeKey].values.dialog, null);
    tree = view(); globals[probeKey].effects.find(effect => String(effect).includes(".showModal("))!();
    assert.equal(element.closeCount, 1);
    elements(tree).find(item => item.type === "dialog")!.props.onClose({ currentTarget: element });
    assert.equal(trigger.focusCount, 1);
    restoreOverflow(); assert.equal(bodyStyle.overflow, "scroll");
    globals[probeKey].values.dialog = "help";
    element.open = true;
    elements(view()).find(item => item.type === "dialog")!.props.onClose({ currentTarget: element });
    assert.equal(globals[probeKey].values.dialog, "help", "A delayed native close event cannot close a reopened modal");
    assert.equal(trigger.focusCount, 1);

    for (const values of [{ dialog: "key", busy: null }, { dialog: "rate", busy: "publish" }]) {
      Object.assign(globals[probeKey].values, values);
      dialog = elements(view()).find(item => item.type === "dialog")!;
      dialog.props.onCancel({ preventDefault() {} });
      assert.equal(globals[probeKey].values.dialog, values.dialog);
      dialog.props.onClick({ target: element, currentTarget: element, clientX: -1, clientY: -1 });
      assert.equal(globals[probeKey].values.dialog, values.dialog);
    }
    Object.assign(globals[probeKey].values, { dialog: "connect", busy: null });
    dialog = elements(view()).find(item => item.type === "dialog")!;
    dialog.props.onClick({ target: element, currentTarget: element, clientX: -1, clientY: -1 });
    assert.equal(globals[probeKey].values.dialog, null);
  } finally {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("rate, preview, and publish send only the approved aggregate and open sharing after success", async () => {
  const view = await league({ dialog: null });
  const previousFetch = globalThis.fetch;
  const requests: { url: string; method: string; body: any }[] = [];
  let finishPublish: (response: Response) => void = () => {};
  const receipt = buildPlayerReceipt({ player_id: account.player.id, competition_id: `c_${"2".repeat(32)}`, week_id: weekId, form_score: score.formScore, coverage_ppm: score.coveragePpm, certainty_ppm: score.certaintyPpm });
  const player = { ...account, player: { ...account.player, receipt } };
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    if (String(url) === "/api/assessment") return new Promise<Response>(resolve => { finishPublish = resolve; });
    return Response.json(overview);
  };
  try {
    button(view(), "Rate my week").props.onClick();
    assert.equal(globals[probeKey].values.dialog, "rate");
    byId(view(), "assessment-json").props.onChange({ target: { value: JSON.stringify(score) } });
    button(view(), "Preview my result").props.onClick();
    assert.equal(requests.length, 0);
    button(view(), "Publish my score").props.onClick();
    assert.equal(globals[probeKey].values.dialog, "rate", "A pending write must not look published");
    assert.equal(globals[probeKey].values.busy, "publish");
    assert.deepEqual(requests[0], { url: "/api/assessment", method: "POST", body: score });
    finishPublish(Response.json(player)); await settle();
    assert.equal(globals[probeKey].values.dialog, "share");
    assert.equal(globals[probeKey].values.assessmentPreview, null);
    assert.equal(globals[probeKey].values.assessmentText, "");
    assert.equal(requests.filter(item => item.method !== "GET").length, 1, "Publishing must not also enter a queue");
  } finally { globalThis.fetch = previousFetch; }
});
