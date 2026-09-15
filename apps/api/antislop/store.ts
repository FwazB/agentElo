import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { isProxy } from "node:util/types";

import { parseJsonText } from "../../../packages/elo-engine/src/canonical.ts";
import { STARTING_RATING_MILLI } from "../../../packages/elo-engine/src/constants.ts";
import { validatePlayerReceipt } from "../../../packages/elo-engine/src/receipts.ts";
import { parseEntryDraft } from "../../../packages/referee/drafts.ts";
import { entryFingerprint, parseWorkEntry, WORK_ENTRY_VERSION, type WorkEntry } from "../../../packages/referee/entries.ts";
import { adjudicatePair, buildJudgePacket, judgeFingerprint, parseJudgeConfig, type JudgeConfig, type Outcome } from "../../../packages/referee/judge.ts";
import { LIVE_JUDGE_CONFIG } from "../../../packages/referee/live-config.ts";
import type { AntiSlopArena, AntiSlopJudgeClaim, AntiSlopLimits, AntiSlopMe, DuelPlayerStats, DuelReason, DuelState, DuelView, OwnedEntry, PublicEntry } from "../../../packages/public-api/antislop.ts";
import { ApiError } from "../store.ts";

const DAY = 86_400_000;
const PENDING_MS = 120_000;
const LEASE_MS = 90_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const ENTRY_ID = /^ae_[0-9a-f]{32}$/;
const DUEL_ID = /^ad_[0-9a-f]{32}$/;
const TOKEN = /^[0-9a-f]{64}$/;
const LIMITS: AntiSlopLimits = { duelsPerPlayerPerDay: 10, duelsGlobalPerDay: 100, maxInFlightPerPlayer: 1 };
const opaque = (prefix: string): string => `${prefix}_${randomBytes(16).toString("hex")}`;
const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const hash = (value: unknown): string => `sha256:${digest(JSON.stringify(value))}`;
const iso = (value: number): string => new Date(value).toISOString();
type Row = Record<string, unknown>;

function invalid(message = "Invalid AntiSlop request fields."): never { throw new ApiError(400, message); }

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || isProxy(value) || Array.isArray(value)) invalid();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  if (Reflect.ownKeys(value).length !== keys.length) invalid();
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) invalid();
    result[key] = descriptor.value;
  }
  return result;
}

function identifier(value: unknown, pattern = ID): string {
  if (typeof value !== "string" || value.length > 80 || value.trim() !== value || !pattern.test(value)) invalid("Invalid AntiSlop identifier.");
  return value;
}

function bool(value: unknown): boolean { if (typeof value !== "boolean") invalid(); return value; }

/** Ignore submitted IDs, item ordering, window refreshes, and approval metadata. */
function substantiveFingerprint(entry: WorkEntry): string {
  const normalize = (value: string): string => value.normalize("NFC").trim().replace(/\s+/gu, " ");
  const evidenceById = new Map(entry.evidence.map(item => [item.id, hash({
    kind: item.kind, excerpt: normalize(item.excerpt), occurredAt: item.occurredAt,
  })]));
  const evidence = [...new Set(evidenceById.values())].sort();
  const accomplishments = [...new Set(entry.accomplishments.map(item => JSON.stringify({
    outcome: normalize(item.outcome), evidence: [...new Set(item.evidenceIds.map(id => evidenceById.get(id)!))].sort(),
  })))].sort();
  return hash({ summary: normalize(entry.summary), accomplishments, evidence });
}

export interface AntislopStoreOptions {
  databasePath: string;
  judgeConfig?: JudgeConfig;
  now?: () => Date;
  /** Transaction fault injection for tests only. */
  beforeCommit?: (operation: string) => void;
}

/** Additive storage; the legacy account store must initialize this database first. */
export function createAntislopStore(options: AntislopStoreOptions) {
  const config = parseJudgeConfig(options.judgeConfig ?? LIVE_JUDGE_CONFIG);
  const judgeHash = judgeFingerprint(config);
  const db = new DatabaseSync(options.databasePath);
  const now = options.now ?? (() => new Date());
  const time = (): number => {
    const value = now().getTime();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid AntiSlop clock.");
    return value;
  };
  function transaction<T>(operation: string, fn: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); options.beforeCommit?.(operation); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='players'").get()) throw new Error("Initialize the account store before AntiSlop.");
    transaction("initializeAntislop", () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS antislop_seasons (
          id TEXT PRIMARY KEY, judge_fingerprint TEXT NOT NULL, config_json TEXT NOT NULL, created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS antislop_entries (
          id TEXT PRIMARY KEY, player_id TEXT NOT NULL REFERENCES players(id), snapshot_json TEXT NOT NULL,
          fingerprint TEXT NOT NULL UNIQUE, content_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
          UNIQUE(player_id,content_hash)
        );
        CREATE TABLE IF NOT EXISTS antislop_entry_participation (
          entry_id TEXT PRIMARY KEY REFERENCES antislop_entries(id), opted_in INTEGER NOT NULL CHECK(opted_in IN (0,1)),
          approved_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS antislop_duels (
          id TEXT PRIMARY KEY, season_id TEXT NOT NULL REFERENCES antislop_seasons(id),
          a_entry TEXT NOT NULL REFERENCES antislop_entries(id), b_entry TEXT NOT NULL REFERENCES antislop_entries(id),
          a_player TEXT NOT NULL REFERENCES players(id), b_player TEXT NOT NULL REFERENCES players(id),
          pair_key TEXT NOT NULL, judge_fingerprint TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('pending','judging','complete','failed')),
          outcome TEXT CHECK(outcome IN ('a_wins','b_wins','draw','unrated')), reason TEXT NOT NULL,
          created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, completed_at INTEGER,
          lease_hash TEXT, claimant_id TEXT REFERENCES players(id), settlement_hash TEXT,
          CHECK(a_player<>b_player), CHECK(a_entry<>b_entry), UNIQUE(season_id,pair_key)
        );
        CREATE TABLE IF NOT EXISTS antislop_judge_runs (
          duel_id TEXT NOT NULL REFERENCES antislop_duels(id), display_order TEXT NOT NULL CHECK(display_order IN ('ab','ba')),
          judge_fingerprint TEXT NOT NULL, pair_fingerprint TEXT NOT NULL, verdict_json TEXT NOT NULL,
          PRIMARY KEY(duel_id,display_order)
        );
        CREATE TABLE IF NOT EXISTS antislop_requests (
          player_id TEXT NOT NULL REFERENCES players(id), operation TEXT NOT NULL, request_id TEXT NOT NULL,
          request_hash TEXT NOT NULL, resource_id TEXT NOT NULL, created_at INTEGER NOT NULL,
          PRIMARY KEY(player_id,operation,request_id)
        );
        CREATE INDEX IF NOT EXISTS antislop_entries_player ON antislop_entries(player_id,created_at);
        CREATE INDEX IF NOT EXISTS antislop_duels_a ON antislop_duels(a_player,created_at);
        CREATE INDEX IF NOT EXISTS antislop_duels_b ON antislop_duels(b_player,created_at);
        CREATE INDEX IF NOT EXISTS antislop_duels_day ON antislop_duels(created_at);
        CREATE INDEX IF NOT EXISTS antislop_duels_expiry ON antislop_duels(state,expires_at);
        CREATE INDEX IF NOT EXISTS antislop_requests_day ON antislop_requests(player_id,created_at);
      `);
      const existing = db.prepare("SELECT judge_fingerprint,config_json FROM antislop_seasons WHERE id=?").get(config.seasonId);
      if (existing && (existing.judge_fingerprint !== judgeHash || existing.config_json !== JSON.stringify(config))) throw new Error("AntiSlop season configuration changed; use a new season.");
      if (!existing) db.prepare("INSERT INTO antislop_seasons VALUES (?,?,?,?)").run(config.seasonId, judgeHash, JSON.stringify(config), time());
    });
  } catch (error) { db.close(); throw error; }

  function player(id: string): Row {
    const row = db.prepare("SELECT id,username FROM players WHERE id=?").get(id);
    if (!row) throw new ApiError(404, "Player not found.");
    return row;
  }
  function entryRow(id: string): Row {
    const row = db.prepare(`SELECT e.*,p.opted_in,p.approved_at FROM antislop_entries e
      JOIN antislop_entry_participation p ON p.entry_id=e.id WHERE e.id=?`).get(id);
    if (!row) throw new ApiError(404, "Entry not found.");
    return row;
  }
  function snapshot(row: Row): WorkEntry {
    const entry = parseWorkEntry(JSON.parse(String(row.snapshot_json)) as unknown);
    if (entry.entryId !== row.id || entry.participantId !== row.player_id || entryFingerprint(entry) !== row.fingerprint || substantiveFingerprint(entry) !== row.content_hash) throw new Error("AntiSlop entry integrity failure.");
    return entry;
  }
  function publicEntry(row: Row): PublicEntry {
    const entry = snapshot(row);
    return {
      entryId: entry.entryId, participantId: entry.participantId, username: player(entry.participantId).username as string | null,
      window: entry.window, publicSummary: entry.publicSummary?.text ?? null, createdAt: iso(Number(row.created_at)), optedIn: row.opted_in === 1,
    };
  }
  function ownedEntry(row: Row, id: string): OwnedEntry {
    if (row.player_id !== id) throw new ApiError(404, "Entry not found.");
    return { ...publicEntry(row), entry: snapshot(row) };
  }
  const timeoutHash = hash({ failure: "referee_timed_out" });
  function expire(at = time()): void {
    db.prepare(`UPDATE antislop_duels SET state='failed',outcome='unrated',reason='referee_timed_out',completed_at=?,settlement_hash=?
      WHERE state IN ('pending','judging') AND expires_at<=?`).run(at, timeoutHash, at);
  }
  function duelRow(id: string): Row {
    const row = db.prepare("SELECT * FROM antislop_duels WHERE id=?").get(id);
    if (!row) throw new ApiError(404, "Duel not found.");
    return row;
  }
  function isParticipant(row: Row, id: string | undefined): boolean { return id !== undefined && (row.a_player === id || row.b_player === id); }
  function requireParticipant(row: Row, id: string): void {
    player(id);
    if (!isParticipant(row, id)) throw new ApiError(403, "Only a duel participant can request judging.");
  }
  function currentPlayerStats(id: string): DuelPlayerStats {
    const row = db.prepare(`SELECT receipt,(SELECT value FROM metadata WHERE key='competition_id') AS competition_id
      FROM players WHERE id=?`).get(id);
    if (!row) throw new ApiError(404, "Player not found.");
    const receipt = row.receipt === null ? null : validatePlayerReceipt(parseJsonText(String(row.receipt)));
    if (receipt && (receipt.player_id !== id || receipt.competition_id !== row.competition_id)) throw new Error("Player receipt integrity failure");
    // Match the public scalar standings: latest saved Form and current Elo, including the 1200 seed.
    return {
      formScore: receipt?.form.score ?? null,
      ratingMilli: receipt?.elo.scalar.rating_milli ?? STARTING_RATING_MILLI,
      ratedMatches: receipt?.elo.scalar.rated_matches ?? 0,
    };
  }
  function view(row: Row, viewer?: string): DuelView {
    return {
      duelId: String(row.id), seasonId: String(row.season_id), state: row.state as DuelState,
      a: publicEntry(entryRow(String(row.a_entry))), b: publicEntry(entryRow(String(row.b_entry))),
      playerStats: { a: currentPlayerStats(String(row.a_player)), b: currentPlayerStats(String(row.b_player)) },
      outcome: row.outcome as Outcome | null, reason: row.reason as DuelReason, ratingEligible: false,
      judgeFingerprint: String(row.judge_fingerprint), createdAt: iso(Number(row.created_at)),
      completedAt: row.completed_at === null ? null : iso(Number(row.completed_at)),
      canJudge: row.state === "pending" && Number(row.expires_at) > time() && row.lease_hash === null && isParticipant(row, viewer),
    };
  }
  function dayBounds(at: number): { day: string; start: number; end: number } {
    const day = iso(at).slice(0, 10); const start = Date.parse(`${day}T00:00:00.000Z`);
    return { day, start, end: start + DAY };
  }
  function quota(id: string, at = time()): AntiSlopMe["quota"] {
    const { day, start, end } = dayBounds(at);
    const used = Number(db.prepare("SELECT COUNT(*) AS n FROM antislop_duels WHERE (a_player=? OR b_player=?) AND created_at>=? AND created_at<?").get(id, id, start, end)!.n);
    const inFlight = Number(db.prepare("SELECT COUNT(*) AS n FROM antislop_duels WHERE (a_player=? OR b_player=?) AND state IN ('pending','judging') AND expires_at>?").get(id, id, at)!.n);
    return { day, used, remaining: Math.max(0, LIMITS.duelsPerPlayerPerDay - used), inFlight };
  }
  function priorRequest(id: string, operation: string, requestId: string, requestHash: string): string | null {
    const row = db.prepare("SELECT request_hash,resource_id FROM antislop_requests WHERE player_id=? AND operation=? AND request_id=?").get(id, operation, requestId);
    if (!row) return null;
    if (row.request_hash !== requestHash) throw new ApiError(409, "That request ID was already used for different content.");
    return String(row.resource_id);
  }
  function saveRequest(id: string, operation: string, requestId: string, requestHash: string, resource: string, at: number): void {
    const { start, end } = dayBounds(at);
    const count = Number(db.prepare("SELECT COUNT(*) AS n FROM antislop_requests WHERE player_id=? AND created_at>=? AND created_at<?").get(id, start, end)!.n);
    if (count >= 60) throw new ApiError(429, "Today's AntiSlop request limit has been reached.");
    db.prepare("INSERT INTO antislop_requests VALUES (?,?,?,?,?,?)").run(id, operation, requestId, requestHash, resource, at);
  }
  function fresh(row: Row, at: number): void {
    const end = Date.parse(snapshot(row).window.endsAt);
    if (end > at || at - end > DAY || Number(row.created_at) > at || at - Number(row.created_at) > DAY) throw new ApiError(409, "Use an entry from the last 24 hours with a current seven-day window.");
  }
  function validLease(row: Row, id: string, leaseToken: unknown): void {
    requireParticipant(row, id);
    if (typeof leaseToken !== "string" || leaseToken.length !== 64 || !TOKEN.test(leaseToken)) invalid("Invalid judging lease.");
    if (row.claimant_id !== id || typeof row.lease_hash !== "string" || !timingSafeEqual(Buffer.from(digest(leaseToken), "hex"), Buffer.from(row.lease_hash, "hex"))) throw new ApiError(409, "The judging lease does not match this duel.");
  }

  return {
    close: (): void => db.close(),
    arena(viewer?: string): AntiSlopArena {
      const at = time(); expire(at);
      const entries = db.prepare(`SELECT e.*,p.opted_in,p.approved_at FROM antislop_entries e JOIN antislop_entry_participation p ON p.entry_id=e.id
        WHERE p.opted_in=1 AND e.created_at>=? ORDER BY e.created_at DESC,e.id LIMIT 50`).all(at - DAY)
        .filter(row => { const end = Date.parse(snapshot(row).window.endsAt); return end <= at && at - end <= DAY; }).map(publicEntry);
      const duels = db.prepare("SELECT * FROM antislop_duels WHERE season_id=? ORDER BY created_at DESC,id DESC LIMIT 50").all(config.seasonId).map(row => view(row, viewer));
      return { serverNow: iso(at), season: { seasonId: config.seasonId, phase: "pilot", judgeFingerprint: judgeHash, ratingEligible: false }, entries, duels, limits: { ...LIMITS } };
    },
    me(id: string): AntiSlopMe {
      player(id); expire();
      const entries = db.prepare(`SELECT e.*,p.opted_in,p.approved_at FROM antislop_entries e JOIN antislop_entry_participation p ON p.entry_id=e.id
        WHERE e.player_id=? ORDER BY e.created_at DESC,e.id LIMIT 20`).all(id).map(row => ownedEntry(row, id));
      const duels = db.prepare("SELECT * FROM antislop_duels WHERE a_player=? OR b_player=? ORDER BY created_at DESC,id DESC LIMIT 50").all(id, id).map(row => view(row, id));
      return { entries, duels, quota: quota(id) };
    },
    entry(value: unknown, viewer?: string): PublicEntry {
      const row = entryRow(identifier(value, ENTRY_ID));
      // Saved private entries have no public presence, even for their owner on this route.
      // Prior public challenge consent remains attached to the immutable snapshot.
      if (row.approved_at === null) throw new ApiError(404, "Entry not found.");
      return publicEntry(row);
    },
    duel(value: unknown, viewer?: string): DuelView { expire(); return view(duelRow(identifier(value, DUEL_ID)), viewer); },
    submitEntry(id: string, value: unknown): { created: boolean; entry: OwnedEntry } {
      const input = object(value, ["requestId", "draft", "refereeApproved", "publicSummary", "optedIn"]);
      const requestId = identifier(input.requestId);
      if (input.refereeApproved !== true) invalid("Approve private referee processing before uploading an entry.");
      const optedIn = bool(input.optedIn);
      let draft;
      try { draft = parseEntryDraft(input.draft); } catch { invalid("Invalid entry draft. Use the supplied seven-day entry format."); }
      if (draft.status !== "ready") invalid("An entry needs authorized evidence before it can be submitted.");
      let publicSummary: { text: string; approved: true } | null = null;
      if (input.publicSummary !== null) {
        const summary = object(input.publicSummary, ["text", "approved"]);
        if (summary.approved !== true || typeof summary.text !== "string") invalid("Approve the exact public summary before sharing it.");
        publicSummary = { text: summary.text, approved: true };
      }
      const requestHash = hash({ draft, refereeApproved: true, publicSummary, optedIn });
      return transaction("submitAntislopEntry", () => {
        player(id);
        const prior = priorRequest(id, "entry", requestId, requestHash);
        if (prior) return { created: false, entry: ownedEntry(entryRow(prior), id) };
        const at = time(); const end = Date.parse(draft.window.endsAt);
        if (end > at || at - end > DAY) throw new ApiError(409, "The seven-day window must end within the last 24 hours.");
        let entry: WorkEntry;
        try {
          entry = parseWorkEntry({ version: WORK_ENTRY_VERSION, entryId: opaque("ae"), participantId: id,
            window: draft.window, summary: draft.summary, accomplishments: draft.accomplishments, evidence: draft.evidence,
            refereeConsent: { approved: true, approvedAt: iso(at) },
            publicSummary: publicSummary === null ? null : { text: publicSummary.text, approvedAt: iso(at) } });
        } catch { invalid("Invalid entry or public summary. Check the supplied format and size limits."); }
        const contentHash = substantiveFingerprint(entry);
        if (db.prepare("SELECT 1 FROM antislop_entries WHERE player_id=? AND content_hash=?").get(id, contentHash)) throw new ApiError(409, "This work already has an immutable entry. Use the existing entry; changing sharing text does not create a new entry.");
        const { start, end: dayEnd } = dayBounds(at);
        if (Number(db.prepare("SELECT COUNT(*) AS n FROM antislop_entries WHERE player_id=? AND created_at>=? AND created_at<?").get(id, start, dayEnd)!.n) >= 10) throw new ApiError(429, "Today's ten entry submissions are used.");
        db.prepare("INSERT INTO antislop_entries VALUES (?,?,?,?,?,?)").run(entry.entryId, id, JSON.stringify(entry), entryFingerprint(entry), contentHash, at);
        db.prepare("INSERT INTO antislop_entry_participation VALUES (?,?,?)").run(entry.entryId, optedIn ? 1 : 0, optedIn ? at : null);
        saveRequest(id, "entry", requestId, requestHash, entry.entryId, at);
        return { created: true, entry: ownedEntry(entryRow(entry.entryId), id) };
      });
    },
    participation(id: string, entryId: unknown, value: unknown): PublicEntry {
      const entryIdValue = identifier(entryId, ENTRY_ID); const input = object(value, ["optedIn"]); const optedIn = bool(input.optedIn);
      return transaction("antislopParticipation", () => {
        player(id); const row = entryRow(entryIdValue); if (row.player_id !== id) throw new ApiError(404, "Entry not found.");
        const at = time(); if (optedIn) fresh(row, at);
        db.prepare("UPDATE antislop_entry_participation SET opted_in=?,approved_at=CASE WHEN ?=1 THEN ? ELSE approved_at END WHERE entry_id=?").run(optedIn ? 1 : 0, optedIn ? 1 : 0, at, entryIdValue);
        return publicEntry(entryRow(entryIdValue));
      });
    },
    createDuel(id: string, value: unknown): { created: boolean; duel: DuelView } {
      const input = object(value, ["requestId", "entryId", "opponentEntryId"]);
      const requestId = identifier(input.requestId), aId = identifier(input.entryId, ENTRY_ID), bId = identifier(input.opponentEntryId, ENTRY_ID);
      const requestHash = hash({ entryId: aId, opponentEntryId: bId }); expire();
      return transaction("createAntislopDuel", () => {
        player(id);
        const prior = priorRequest(id, "duel", requestId, requestHash);
        if (prior) return { created: false, duel: view(duelRow(prior), id) };
        const a = entryRow(aId), b = entryRow(bId);
        if (a.player_id !== id) throw new ApiError(403, "Use your own entry to challenge another player.");
        if (a.player_id === b.player_id) throw new ApiError(409, "Choose another player's entry.");
        const pairKey = hash([JSON.stringify([a.player_id, a.content_hash]), JSON.stringify([b.player_id, b.content_hash])].sort());
        const existing = db.prepare("SELECT * FROM antislop_duels WHERE season_id=? AND pair_key=?").get(config.seasonId, pairKey);
        const at = time();
        if (existing) {
          saveRequest(id, "duel", requestId, requestHash, String(existing.id), at);
          return { created: false, duel: view(existing, id) };
        }
        if (a.opted_in !== 1 || b.opted_in !== 1) throw new ApiError(409, "Both entries must be opted in to public challenges.");
        fresh(a, at); fresh(b, at);
        for (const participant of [id, String(b.player_id)]) {
          const current = quota(participant, at);
          if (current.remaining === 0) throw new ApiError(429, "One participant has used today's ten duels.");
          if (current.inFlight >= LIMITS.maxInFlightPerPlayer) throw new ApiError(409, "One participant already has a duel in progress.");
        }
        const { start, end } = dayBounds(at);
        if (Number(db.prepare("SELECT COUNT(*) AS n FROM antislop_duels WHERE created_at>=? AND created_at<?").get(start, end)!.n) >= LIMITS.duelsGlobalPerDay) throw new ApiError(429, "Today's shared referee capacity has been reached.");
        const duelId = opaque("ad");
        db.prepare(`INSERT INTO antislop_duels(id,season_id,a_entry,b_entry,a_player,b_player,pair_key,judge_fingerprint,state,reason,created_at,expires_at)
          VALUES (?,?,?,?,?,?,?,?,'pending','pending',?,?)`).run(duelId, config.seasonId, aId, bId, id, String(b.player_id), pairKey, judgeHash, at, at + PENDING_MS);
        saveRequest(id, "duel", requestId, requestHash, duelId, at);
        return { created: true, duel: view(duelRow(duelId), id) };
      });
    },
    claim(id: string, duelId: unknown): AntiSlopJudgeClaim {
      const duelIdValue = identifier(duelId, DUEL_ID); expire();
      return transaction("claimAntislopDuel", () => {
        const row = duelRow(duelIdValue); requireParticipant(row, id);
        if (row.state !== "pending" || row.lease_hash !== null) throw new ApiError(409, "This duel has already been claimed or finished. Refresh its result.");
        if (row.season_id !== config.seasonId || row.judge_fingerprint !== judgeHash) throw new ApiError(409, "This duel belongs to another referee season.");
        const a = snapshot(entryRow(String(row.a_entry))), b = snapshot(entryRow(String(row.b_entry)));
        const packets = { ab: buildJudgePacket(a, b, config, "ab"), ba: buildJudgePacket(a, b, config, "ba") };
        const leaseToken = randomBytes(32).toString("hex"), expiresAt = time() + LEASE_MS;
        db.prepare("UPDATE antislop_duels SET state='judging',reason='judging',lease_hash=?,claimant_id=?,expires_at=? WHERE id=? AND state='pending'").run(digest(leaseToken), id, expiresAt, duelIdValue);
        return { duelId: duelIdValue, leaseToken, leaseExpiresAt: iso(expiresAt), judgeFingerprint: judgeHash, pairFingerprint: packets.ab.pairFingerprint, packets };
      });
    },
    settle(id: string, duelId: unknown, value: unknown): DuelView {
      const duelIdValue = identifier(duelId, DUEL_ID), input = object(value, ["leaseToken", "responseAB", "responseBA"]); expire();
      return transaction("settleAntislopDuel", () => {
        const row = duelRow(duelIdValue); validLease(row, id, input.leaseToken);
        if (row.judge_fingerprint !== judgeHash || row.season_id !== config.seasonId) throw new ApiError(409, "The referee configuration no longer matches this duel.");
        let result;
        try { result = adjudicatePair(snapshot(entryRow(String(row.a_entry))), snapshot(entryRow(String(row.b_entry))), config, input.responseAB, input.responseBA); }
        catch { invalid("The referee response did not match the frozen entries, configuration, or required format."); }
        const resultHash = hash(result);
        if (row.state === "complete" && row.settlement_hash === resultHash) return view(row, id);
        if (row.state !== "judging" || Number(row.expires_at) <= time()) throw new ApiError(409, "This judging lease has finished or expired.");
        const reason: DuelReason = result.resolution === "order_disagreement" ? "order_disagreement" : result.outcome === "unrated" ? "referee_abstained" : "order_agreement";
        for (const order of ["ab", "ba"] as const) db.prepare("INSERT INTO antislop_judge_runs VALUES (?,?,?,?,?)").run(duelIdValue, order, result.judgeFingerprint, result.pairFingerprint, JSON.stringify(result.privateVerdicts[order]));
        db.prepare("UPDATE antislop_duels SET state='complete',outcome=?,reason=?,completed_at=?,settlement_hash=? WHERE id=? AND state='judging'").run(result.outcome, reason, time(), resultHash, duelIdValue);
        return view(duelRow(duelIdValue), id);
      });
    },
    fail(id: string, duelId: unknown, value: unknown): DuelView {
      const duelIdValue = identifier(duelId, DUEL_ID), input = object(value, ["leaseToken", "reason"]);
      if (input.reason !== "referee_failed" && input.reason !== "referee_timed_out") invalid();
      const reason = input.reason;
      const failureHash = hash({ failure: reason }); expire();
      return transaction("failAntislopDuel", () => {
        const row = duelRow(duelIdValue); validLease(row, id, input.leaseToken);
        if (row.state === "failed" && row.settlement_hash === failureHash) return view(row, id);
        if (row.state !== "judging" || Number(row.expires_at) <= time()) throw new ApiError(409, "This judging lease has finished or expired.");
        db.prepare("UPDATE antislop_duels SET state='failed',outcome='unrated',reason=?,completed_at=?,settlement_hash=? WHERE id=? AND state='judging'").run(reason, time(), failureHash, duelIdValue);
        return view(duelRow(duelIdValue), id);
      });
    },
  };
}

export type AntislopStore = ReturnType<typeof createAntislopStore>;
