import type { ReadyEntryDraft } from "../referee/drafts.ts";
import type { WorkEntry } from "../referee/entries.ts";
import type { JudgePacket, JudgeResponse, Outcome } from "../referee/judge.ts";

export interface PublicEntry {
  entryId: string;
  participantId: string;
  username: string | null;
  window: WorkEntry["window"];
  publicSummary: string | null;
  createdAt: string;
  optedIn: boolean;
}

/** Only the authenticated owner receives the private entry snapshot. */
export interface OwnedEntry extends PublicEntry { entry: WorkEntry }

export type DuelState = "pending" | "judging" | "complete" | "failed";
export type DuelReason = "pending" | "judging" | "order_agreement" | "order_disagreement" |
  "referee_abstained" | "referee_failed" | "referee_timed_out";

/** Current public profile aggregates, independent of the immutable referee result. */
export interface DuelPlayerStats {
  /** Saved Form on its original 0–1000 scale; divide by 10 for display out of 100. */
  formScore: number | null;
  /** Current scalar-league Elo, in thousandths; an unrated account starts at 1,200,000. */
  ratingMilli: number;
  ratedMatches: number;
}

export interface DuelView {
  duelId: string;
  seasonId: string;
  state: DuelState;
  a: PublicEntry;
  b: PublicEntry;
  /** Always returned by the live API; optional for older fixtures. Re-read on each request. */
  playerStats?: { a: DuelPlayerStats; b: DuelPlayerStats };
  outcome: Outcome | null;
  reason: DuelReason;
  ratingEligible: false;
  judgeFingerprint: string;
  createdAt: string;
  completedAt: string | null;
  /** True only for a participant viewing an unexpired, never-claimed pending duel. */
  canJudge: boolean;
}

export interface AntiSlopSeason {
  seasonId: string;
  phase: "pilot";
  judgeFingerprint: string;
  ratingEligible: false;
}

export interface AntiSlopLimits {
  duelsPerPlayerPerDay: number;
  duelsGlobalPerDay: number;
  maxInFlightPerPlayer: number;
}

export interface AntiSlopArena {
  serverNow: string;
  season: AntiSlopSeason;
  entries: PublicEntry[];
  duels: DuelView[];
  limits: AntiSlopLimits;
}

export interface AntiSlopMe {
  entries: OwnedEntry[];
  duels: DuelView[];
  quota: { day: string; used: number; remaining: number; inFlight: number };
}

export interface SubmitEntryRequest {
  requestId: string;
  draft: ReadyEntryDraft;
  refereeApproved: true;
  publicSummary: { text: string; approved: true } | null;
  /** Explicitly permits challenges and structured public duel outcomes. */
  optedIn: boolean;
}

export interface CreateDuelRequest { requestId: string; entryId: string; opponentEntryId: string }
export interface ParticipationRequest { optedIn: boolean }

/** Internal server-to-server response. Never return through the browser proxy. */
export interface AntiSlopJudgeClaim {
  duelId: string;
  leaseToken: string;
  leaseExpiresAt: string;
  judgeFingerprint: string;
  pairFingerprint: string;
  packets: { ab: JudgePacket; ba: JudgePacket };
}

export interface SettleDuelRequest { leaseToken: string; responseAB: JudgeResponse; responseBA: JudgeResponse }
export interface FailDuelRequest { leaseToken: string; reason: "referee_failed" | "referee_timed_out" }
