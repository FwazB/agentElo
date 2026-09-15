import type { EntryDraft, ReadyEntryDraft } from "../../../packages/referee/drafts.ts";
import { parseRefereeJson } from "../../../packages/referee/json.ts";

const encoder = new TextEncoder();
const DAY = 86_400_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

function object(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Check the ${label} in your entry.`);
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== keys.length || keys.some(key => !Object.hasOwn(item, key))) throw new Error(`The ${label} has missing or unexpected fields. Copy the complete entry JSON from your AI.`);
  return item;
}

function text(value: unknown, limit: number, label: string): string {
  if (typeof value !== "string" || !value.trim() || encoder.encode(value).length > limit) throw new Error(`The ${label} must contain text within ${limit.toLocaleString("en-US")} UTF-8 bytes.`);
  return value;
}

function id(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) throw new Error("An accomplishment or evidence ID is invalid. Ask your AI to use short IDs such as a1 and e1.");
  return value;
}

function list(value: unknown, max: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) throw new Error(`Include between 1 and ${max} ${label}.`);
  return value;
}

function utc(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw new Error("Use the exact UTC window supplied in your preparation prompt.");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error("Your entry contains an invalid date.");
  return value;
}

/** Browser-only preview: never imports server code, uploads evidence, or grants consent. */
export function parseEntryPreview(source: string): EntryDraft {
  if (encoder.encode(source).length > 65_536) throw new Error("Keep your entry JSON under 64 KiB. Ask your AI for shorter evidence excerpts.");
  const value = parseRefereeJson(source);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Paste the entry JSON object returned by your AI.");
  const status = (value as Record<string, unknown>).status;
  const item = object(value, status === "insufficient_context" ? ["version", "status", "window", "reason"] : ["version", "status", "window", "summary", "accomplishments", "evidence", "publicSummary"], "entry");
  if (item.version !== "antislop.entry-draft.v1") throw new Error("Use the entry format from the preparation prompt below.");
  const rawWindow = object(item.window, ["startsAt", "endsAt"], "time window");
  const window = { startsAt: utc(rawWindow.startsAt), endsAt: utc(rawWindow.endsAt) };
  const start = Date.parse(window.startsAt), end = Date.parse(window.endsAt);
  if (end - start !== 7 * DAY) throw new Error("Your entry must cover exactly seven days. Use the window from your prompt.");
  if (status === "insufficient_context") {
    const reasons = ["no_authorized_context", "no_dated_evidence", "no_safe_evidence", "no_supported_outcome"];
    if (typeof item.reason !== "string" || !reasons.includes(item.reason)) throw new Error("The insufficient-context result has an unknown reason.");
    return { version: "antislop.entry-draft.v1", status, window, reason: item.reason as Extract<EntryDraft, { status: "insufficient_context" }>["reason"] };
  }
  if (status !== "ready" || item.publicSummary !== null) throw new Error("Your AI should return a ready entry with publicSummary set to null. You choose what to share here.");
  const evidenceIds = new Set<string>();
  const evidence: ReadyEntryDraft["evidence"] = list(item.evidence, 10, "evidence items").map(value => {
    const source = object(value, ["id", "kind", "excerpt", "occurredAt"], "evidence item");
    const evidenceId = id(source.id);
    if (evidenceIds.has(evidenceId)) throw new Error("Each evidence item needs a unique ID.");
    evidenceIds.add(evidenceId);
    if (source.kind !== "artifact" && source.kind !== "check" && source.kind !== "attestation") throw new Error("Evidence kind must be artifact, check, or attestation.");
    let occurredAt: string;
    if (typeof source.occurredAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(source.occurredAt)) {
      const date = Date.parse(`${source.occurredAt}T00:00:00.000Z`);
      if (!Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== source.occurredAt || date >= end || date + DAY <= start) throw new Error("An evidence date falls outside this entry’s seven-day window.");
      occurredAt = source.occurredAt;
    } else {
      occurredAt = utc(source.occurredAt);
      const date = Date.parse(occurredAt);
      if (date < start || date >= end) throw new Error("An evidence timestamp falls outside this entry’s seven-day window.");
    }
    return { id: evidenceId, kind: source.kind, excerpt: text(source.excerpt, 6_000, "evidence excerpt"), occurredAt };
  });
  const accomplishmentIds = new Set<string>();
  const accomplishments: ReadyEntryDraft["accomplishments"] = list(item.accomplishments, 5, "accomplishments").map(value => {
    const source = object(value, ["id", "outcome", "evidenceIds"], "accomplishment");
    const accomplishmentId = id(source.id);
    if (accomplishmentIds.has(accomplishmentId)) throw new Error("Each accomplishment needs a unique ID.");
    accomplishmentIds.add(accomplishmentId);
    const references = list(source.evidenceIds, 10, "evidence references").map(id);
    if (new Set(references).size !== references.length || references.some(reference => !evidenceIds.has(reference))) throw new Error("An accomplishment cites missing or repeated evidence. Check its evidence IDs.");
    return { id: accomplishmentId, outcome: text(source.outcome, 2_000, "accomplishment outcome"), evidenceIds: references };
  });
  return { version: "antislop.entry-draft.v1", status: "ready", window, summary: text(item.summary, 4_000, "summary"), accomplishments, evidence, publicSummary: null };
}

export function approvedPublicSummary(value: string): string {
  return text(value, 2_000, "public summary");
}
