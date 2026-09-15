import type { EloMode } from "../elo-engine/src/constants.ts";
import type { MatchReceipt, PlayerReceipt } from "../elo-engine/src/receipts.ts";

export type { EloMode, MatchReceipt, PlayerReceipt };

export interface PublicPlayer { id: string; username: string | null; receipt: PlayerReceipt | null }
export interface PlayerView {
  player: PublicPlayer;
  matches: MatchReceipt[];
  usernames: Record<string, string>;
}
export interface Me extends PlayerView {
  formLocked: boolean;
  queue: { mode: EloMode; weekId: string }[];
}
export interface Standing {
  id: string;
  username: string | null;
  rank: number | null;
  ratingMilli: number;
  ratedMatches: number;
  formScore: number | null;
  confidencePpm: number | null;
  weekId: string | null;
}
export interface Overview {
  competitionId: string;
  weekId: string;
  mode: EloMode;
  players: Standing[];
  matches: MatchReceipt[];
  usernames: Record<string, string>;
  stats: { players: number; ratedPlayers: number; matches: number; queued: number };
}
export interface QueueResult { status: "queued" | "matched"; match: MatchReceipt | null }
