import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

export const WORK_ENTRY_VERSION = "antislop.entry.v1";
export const MAX_ENTRY_BYTES = 64 * 1024;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const TIMESTAMP_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

export interface WorkEntry {
  version: typeof WORK_ENTRY_VERSION;
  entryId: string;
  participantId: string;
  window: { startsAt: string; endsAt: string };
  summary: string;
  accomplishments: Array<{ id: string; outcome: string; evidenceIds: string[] }>;
  // Kinds describe submitted material; none establishes independent verification.
  evidence: Array<{ id: string; kind: "artifact" | "check" | "attestation"; excerpt: string; occurredAt: string }>;
  refereeConsent: { approved: true; approvedAt: string };
  publicSummary: null | { text: string; approvedAt: string };
}

export type BlindWorkEntry = Pick<WorkEntry, "window" | "summary" | "accomplishments" | "evidence">;
export interface PublicEntrySummary { entryId: string; text: string }

export class EntryValidationError extends Error {
  override readonly name = "EntryValidationError";
}

function invalid(label: string): never {
  // Labels come only from this module, never from submitted keys or values.
  throw new EntryValidationError(`Invalid ${label}.`);
}

function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || isProxy(value) || Array.isArray(value)) invalid(label);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(label);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length) invalid(`${label} fields`);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) invalid(`${label} property`);
    result[key] = descriptor.value;
  }
  return result;
}

function array(value: unknown, minimum: number, maximum: number, label: string): unknown[] {
  if (typeof value !== "object" || value === null || isProxy(value) || !Array.isArray(value)) invalid(label);
  if (Object.getPrototypeOf(value) !== Array.prototype) invalid(label);
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value as number;
  if (length < minimum || length > maximum || Reflect.ownKeys(value).length !== length + 1) invalid(label);
  const result: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) invalid(`${label} item`);
    result.push(descriptor.value);
  }
  return result;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 80 || value.trim() !== value || !ID_PATTERN.test(value)) invalid(label);
  return value;
}

function text(value: unknown, maximumBytes: number, label: string): string {
  if (typeof value !== "string" || value.length > maximumBytes || value.trim().length === 0 || Buffer.byteLength(value, "utf8") > maximumBytes) invalid(label);
  return value;
}

function timestamp(value: unknown, label: string): { iso: string; milliseconds: number } {
  if (typeof value !== "string" || value.length !== 24 || !TIMESTAMP_PATTERN.test(value)) invalid(label);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) invalid(label);
  return { iso: value, milliseconds };
}

function uniqueId(value: unknown, seen: Set<string>, label: string): string {
  const id = identifier(value, label);
  if (seen.has(id)) invalid(`duplicate ${label}`);
  seen.add(id);
  return id;
}

/** Validate untrusted data and return a detached, fixed-property-order snapshot. */
export function parseWorkEntry(value: unknown): WorkEntry {
  const item = record(value, ["version", "entryId", "participantId", "window", "summary", "accomplishments", "evidence", "refereeConsent", "publicSummary"], "entry");
  if (item.version !== WORK_ENTRY_VERSION) invalid("entry version");
  const entryId = identifier(item.entryId, "entry id");
  const participantId = identifier(item.participantId, "participant id");
  const window = record(item.window, ["startsAt", "endsAt"], "window");
  const startsAt = timestamp(window.startsAt, "window start");
  const endsAt = timestamp(window.endsAt, "window end");
  if (endsAt.milliseconds - startsAt.milliseconds !== SEVEN_DAYS_MS) invalid("seven-day window");
  const summary = text(item.summary, 4_000, "summary");

  const evidenceIds = new Set<string>();
  const evidence = array(item.evidence, 1, 10, "evidence").map((value): WorkEntry["evidence"][number] => {
    const evidenceItem = record(value, ["id", "kind", "excerpt", "occurredAt"], "evidence");
    const id = uniqueId(evidenceItem.id, evidenceIds, "evidence id");
    const kind = evidenceItem.kind;
    if (kind !== "artifact" && kind !== "check" && kind !== "attestation") invalid("evidence kind");
    const occurredAt = timestamp(evidenceItem.occurredAt, "evidence timestamp");
    if (occurredAt.milliseconds < startsAt.milliseconds || occurredAt.milliseconds >= endsAt.milliseconds) invalid("evidence window");
    return { id, kind, excerpt: text(evidenceItem.excerpt, 6_000, "evidence excerpt"), occurredAt: occurredAt.iso };
  });

  const accomplishmentIds = new Set<string>();
  const accomplishments = array(item.accomplishments, 1, 5, "accomplishments").map((value): WorkEntry["accomplishments"][number] => {
    const accomplishment = record(value, ["id", "outcome", "evidenceIds"], "accomplishment");
    const id = uniqueId(accomplishment.id, accomplishmentIds, "accomplishment id");
    const seen = new Set<string>();
    const references = array(accomplishment.evidenceIds, 1, 10, "accomplishment evidence references").map(value => {
      const evidenceId = uniqueId(value, seen, "evidence reference");
      if (!evidenceIds.has(evidenceId)) invalid("unknown evidence reference");
      return evidenceId;
    });
    return { id, outcome: text(accomplishment.outcome, 2_000, "accomplishment outcome"), evidenceIds: references };
  });

  const consent = record(item.refereeConsent, ["approved", "approvedAt"], "referee consent");
  if (consent.approved !== true) invalid("referee approval");
  const consentAt = timestamp(consent.approvedAt, "referee approval timestamp");
  if (consentAt.milliseconds < endsAt.milliseconds) invalid("referee approval timing");

  let publicSummary: WorkEntry["publicSummary"] = null;
  if (item.publicSummary !== null) {
    const snapshot = record(item.publicSummary, ["text", "approvedAt"], "public summary");
    const approvedAt = timestamp(snapshot.approvedAt, "public approval timestamp");
    if (approvedAt.milliseconds < endsAt.milliseconds) invalid("public approval timing");
    // Preserve exactly the separately approved text; never derive it from private material.
    publicSummary = { text: text(snapshot.text, 2_000, "public summary text"), approvedAt: approvedAt.iso };
  }

  const entry: WorkEntry = {
    version: WORK_ENTRY_VERSION,
    entryId,
    participantId,
    window: { startsAt: startsAt.iso, endsAt: endsAt.iso },
    summary,
    accomplishments,
    evidence,
    refereeConsent: { approved: true, approvedAt: consentAt.iso },
    publicSummary,
  };
  if (Buffer.byteLength(JSON.stringify(entry), "utf8") > MAX_ENTRY_BYTES) invalid("entry size");
  return entry;
}

/** UTF-8 JSON in the parser's fixed key order; submitted array order remains significant. */
export function entryFingerprint(entry: WorkEntry): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(parseWorkEntry(entry)), "utf8").digest("hex")}`;
}

/** Hide metadata; submitted free text can still contain identifying information. */
export function blindEntry(entry: WorkEntry): BlindWorkEntry {
  const parsed = parseWorkEntry(entry);
  const evidenceIds = new Map(parsed.evidence.map((item, index) => [item.id, `e${index + 1}`]));
  return {
    window: parsed.window,
    summary: parsed.summary,
    accomplishments: parsed.accomplishments.map((item, index) => ({
      id: `a${index + 1}`,
      outcome: item.outcome,
      evidenceIds: item.evidenceIds.map(id => evidenceIds.get(id)!),
    })),
    evidence: parsed.evidence.map((item, index) => ({ ...item, id: `e${index + 1}` })),
  };
}

/** No approval means no public entry. This does not publish anything. */
export function publicEntrySummary(entry: WorkEntry): PublicEntrySummary | null {
  const parsed = parseWorkEntry(entry);
  return parsed.publicSummary === null ? null : { entryId: parsed.entryId, text: parsed.publicSummary.text };
}
