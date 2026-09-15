import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { buildMatchReceipt, buildPlayerReceipt, validateMatchReceipt, validatePlayerReceipt, validateReceipt, type MatchReceipt, type PlayerReceipt, type Receipt } from "../../packages/elo-engine/src/receipts.ts";
import { LOW_CONFIDENCE_THRESHOLD_PPM, STARTING_RATING_MILLI, type EloMode } from "../../packages/elo-engine/src/constants.ts";
import { parseJsonText } from "../../packages/elo-engine/src/canonical.ts";
import type { Me, Overview, PlayerView, QueueResult, Standing } from "../../packages/public-api/types.ts";
import { lastCompletedWeek } from "../../packages/public-api/week.ts";
export { lastCompletedWeek } from "../../packages/public-api/week.ts";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const opaque = (prefix: string) => `${prefix}_${randomBytes(16).toString("hex")}`;
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const fromJson = (value: unknown): unknown => parseJsonText(String(value));
const RESERVED_USERNAMES = new Set([
  "admin", "administrator", "api", "assets", "auth", "card", "computer_elo", "computerelo", "form", "forms",
  "health", "help", "leaderboard", "login", "logout", "match", "matches", "me", "moderator", "null", "official",
  "player", "players", "profile", "queue", "rankings", "receipt", "receipts", "register", "root", "settings",
  "share", "signup", "staff", "static", "support", "system", "undefined", "user", "username", "users",
]);

export function normalizeUsername(value: unknown): string {
  // Reject non-ASCII before lowercasing so Unicode lookalikes cannot normalize to ASCII names.
  if (typeof value !== "string" || value.length > 64 || /[^\x00-\x7f]/.test(value)) {
    throw new ApiError(400, "Use 3-20 letters, numbers or underscores, starting with a letter.");
  }
  const username = value.trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z][a-z0-9_]{2,19}$/.test(username)) {
    throw new ApiError(400, "Use 3-20 letters, numbers or underscores, starting with a letter.");
  }
  if (RESERVED_USERNAMES.has(username)) throw new ApiError(400, "That username is reserved.");
  return username;
}
function recoveryToken(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new ApiError(400, "A 64-character lowercase hexadecimal recovery key is required.");
  }
  return value;
}

export interface StoreOptions {
  databasePath: string;
  now?: () => Date;
  /** Fault injection for transaction tests; never supplied by the production entrypoint. */
  beforeCommit?: (operation: string) => void;
}

export function createStore(options: StoreOptions) {
  const db = new DatabaseSync(options.databasePath);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, receipt TEXT,
      import_fingerprint TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS receipts (fingerprint TEXT PRIMARY KEY, receipt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS imports (
      id INTEGER PRIMARY KEY, player_id TEXT NOT NULL REFERENCES players(id), week_id TEXT NOT NULL,
      source_fingerprint TEXT NOT NULL REFERENCES receipts(fingerprint),
      result_fingerprint TEXT NOT NULL REFERENCES receipts(fingerprint)
    );
    CREATE TABLE IF NOT EXISTS matches (
      id TEXT PRIMARY KEY, week_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('scalar','binary')),
      receipt TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS participation (
      player_id TEXT NOT NULL REFERENCES players(id), week_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('scalar','binary')), match_id TEXT NOT NULL REFERENCES matches(id),
      PRIMARY KEY(player_id, week_id, mode)
    );
    CREATE TABLE IF NOT EXISTS form_locks (
      player_id TEXT NOT NULL REFERENCES players(id), week_id TEXT NOT NULL,
      PRIMARY KEY(player_id, week_id)
    );
    CREATE TABLE IF NOT EXISTS queue (
      id INTEGER PRIMARY KEY, player_id TEXT NOT NULL REFERENCES players(id), week_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('scalar','binary')), band TEXT NOT NULL CHECK(band IN ('rated','exhibition')),
      UNIQUE(player_id, week_id, mode)
    );
    CREATE INDEX IF NOT EXISTS queue_waiting ON queue(week_id, mode, band, id);
    CREATE INDEX IF NOT EXISTS participation_matches ON participation(match_id);
    CREATE INDEX IF NOT EXISTS imports_player_week ON imports(player_id, week_id);
  `);
  // Additive migration: existing account tokens, receipts, locks and ratings remain untouched.
  db.exec("BEGIN IMMEDIATE");
  let competitionId: string;
  try {
    if (!db.prepare("PRAGMA table_info(players)").all().some(column => column.name === "username")) {
      db.exec("ALTER TABLE players ADD COLUMN username TEXT COLLATE NOCASE");
    }
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS players_username ON players(username COLLATE NOCASE)");
    const metadata = db.prepare("SELECT value FROM metadata WHERE key = 'competition_id'").get();
    if (!metadata) {
      const tables = ["players", "receipts", "imports", "matches", "participation", "form_locks", "queue"];
      if (tables.some(table => db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())) {
        throw new Error("Missing database competition metadata.");
      }
      db.prepare("INSERT INTO metadata(key,value) VALUES ('competition_id', ?)").run(opaque("c"));
    }
    competitionId = String(db.prepare("SELECT value FROM metadata WHERE key = 'competition_id'").get()!.value);
    if (!/^c_[0-9a-f]{32}$/.test(competitionId)) throw new Error("Invalid database competition metadata.");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); db.close(); throw error; }
  const now = options.now ?? (() => new Date());
  const week = () => lastCompletedWeek(now());

  function transaction<T>(operation: string, fn: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      options.beforeCommit?.(operation);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  function archive(receipt: Receipt) {
    const result = db.prepare("INSERT OR IGNORE INTO receipts(fingerprint,receipt) VALUES (?,?)").run(receipt.fingerprint, JSON.stringify(receipt));
    if (result.changes === 0) {
      storedReceipt(db.prepare("SELECT receipt FROM receipts WHERE fingerprint=?").get(receipt.fingerprint)!.receipt, receipt.fingerprint);
    }
  }
  function storedReceipt(value: unknown, fingerprint: string): Receipt {
    const receipt = validateReceipt(fromJson(value));
    if (receipt.fingerprint !== fingerprint) throw new Error("Receipt archive integrity failure");
    return receipt;
  }
  function storedPlayer(value: unknown, id: string): PlayerReceipt | null {
    if (value === null) return null;
    const receipt = validatePlayerReceipt(fromJson(value));
    if (receipt.player_id !== id || receipt.competition_id !== competitionId) throw new Error("Player receipt integrity failure");
    return receipt;
  }
  function storedMatch(row: Record<string, unknown>): MatchReceipt {
    const receipt = validateMatchReceipt(fromJson(row.receipt));
    if (receipt.match_id !== row.id || receipt.mode !== row.mode ||
        receipt.players.a.week_id !== row.week_id || receipt.players.b.week_id !== row.week_id ||
        receipt.competition_ids.some(id => id !== competitionId)) throw new Error("Match receipt integrity failure");
    return receipt;
  }
  function storedParticipation(row: Record<string, unknown>, playerId: string, weekId: unknown, mode: unknown): MatchReceipt {
    const receipt = storedMatch(row);
    if (receipt.mode !== mode || receipt.players.a.week_id !== weekId ||
        ![receipt.players.a.player_id, receipt.players.b.player_id].includes(playerId)) {
      throw new Error("Match participation integrity failure");
    }
    return receipt;
  }
  function current(id: string): PlayerReceipt | null {
    const row = db.prepare("SELECT receipt FROM players WHERE id = ?").get(id);
    if (!row) throw new ApiError(404, "Player not found.");
    return storedPlayer(row.receipt, id);
  }
  function playerView(id: string): PlayerView {
    const receipt = current(id);
    const username = db.prepare("SELECT username FROM players WHERE id=?").get(id)!.username as string | null;
    const matches = db.prepare(`SELECT m.id,m.week_id,m.mode,m.receipt,p.week_id AS participation_week_id,p.mode AS participation_mode
      FROM matches m JOIN participation p ON p.match_id=m.id
      WHERE p.player_id=? ORDER BY m.created_at DESC,m.rowid DESC LIMIT 50`).all(id)
      .map(row => storedParticipation(row, id, row.participation_week_id, row.participation_mode));
    return { player: { id, username, receipt }, matches, usernames: usernamesFor([id], matches) };
  }
  function usernamesFor(ids: string[], matches: MatchReceipt[]): Record<string, string> {
    const participants = [...new Set([...ids, ...matches.flatMap(match => [match.players.a.player_id, match.players.b.player_id])])];
    if (participants.length === 0) return {};
    const placeholders = participants.map(() => "?").join(",");
    const rows = db.prepare(`SELECT id,username FROM players WHERE username IS NOT NULL AND id IN (${placeholders})`).all(...participants);
    return Object.fromEntries(rows.map(row => [String(row.id), String(row.username)]));
  }
  function usernameAvailable(username: string): void {
    if (db.prepare("SELECT 1 FROM players WHERE username=? COLLATE NOCASE").get(username)) {
      throw new ApiError(409, "That username is already taken.");
    }
  }
  function me(id: string): Me {
    const weekId = week();
    const queued = db.prepare("SELECT mode,week_id FROM queue WHERE player_id=? AND week_id=? ORDER BY mode").all(id, weekId);
    const formLocked = !!db.prepare("SELECT 1 FROM form_locks WHERE player_id=? AND week_id=?").get(id, weekId);
    return { ...playerView(id), formLocked, queue: queued.map(row => ({ mode: row.mode as EloMode, weekId: String(row.week_id) })) };
  }
  function existingMatch(id: string, weekId: string, mode: EloMode): MatchReceipt | null {
    const row = db.prepare(`SELECT m.id,m.week_id,m.mode,m.receipt FROM participation p JOIN matches m ON m.id=p.match_id
      WHERE p.player_id=? AND p.week_id=? AND p.mode=?`).get(id, weekId, mode);
    return row ? storedParticipation(row, id, weekId, mode) : null;
  }
  function savePlayer(receipt: PlayerReceipt) {
    archive(receipt);
    db.prepare("UPDATE players SET receipt=? WHERE id=?").run(JSON.stringify(receipt), receipt.player_id);
  }
  function importForm(id: string, value: unknown): Me {
    let source: PlayerReceipt;
    try { source = validatePlayerReceipt(value); }
    catch { throw new ApiError(400, "Invalid public player receipt. Use a valid aggregate-only receipt."); }
    if (source.form.confidence.coverage_ppm === 0 || source.form.confidence.certainty_ppm === 0) {
      throw new ApiError(422, "Not enough evidence for a score. Ask your AI for the missing evidence before publishing.");
    }
    return transaction("importForm", () => {
      if (source.week_id !== week()) throw new ApiError(409, "Use a receipt for the last completed UTC ISO week.");
      const prior = current(id);
      const row = db.prepare("SELECT import_fingerprint FROM players WHERE id=?").get(id)!;
      if (row.import_fingerprint === source.fingerprint) return me(id);
      // Equivalent aggregates never append lineage, even with different client IDs or fingerprints.
      if (prior?.week_id === source.week_id && prior.form.score === source.form.score &&
          prior.form.confidence.coverage_ppm === source.form.confidence.coverage_ppm &&
          prior.form.confidence.certainty_ppm === source.form.confidence.certainty_ppm) return me(id);
      if (db.prepare("SELECT 1 FROM form_locks WHERE player_id=? AND week_id=?").get(id, source.week_id)) {
        throw new ApiError(409, "This week's Form is locked after entering the queue.");
      }
      const imports = db.prepare("SELECT COUNT(*) AS total FROM imports WHERE player_id=? AND week_id=?").get(id, source.week_id)!;
      if (Number(imports.total) >= 5) throw new ApiError(429, "This week's five Form updates are used. Try again next week.");
      const normalized = buildPlayerReceipt({
        player_id: id, competition_id: competitionId, week_id: source.week_id,
        form_score: source.form.score, coverage_ppm: source.form.confidence.coverage_ppm,
        certainty_ppm: source.form.confidence.certainty_ppm, prior_receipt: prior,
      });
      archive(source);
      savePlayer(normalized);
      db.prepare("INSERT INTO imports(player_id,week_id,source_fingerprint,result_fingerprint) VALUES (?,?,?,?)")
        .run(id, source.week_id, source.fingerprint, normalized.fingerprint);
      db.prepare("UPDATE players SET import_fingerprint=? WHERE id=?").run(source.fingerprint, id);
      return me(id);
    });
  }

  return {
    competitionId,
    close: () => db.close(),
    currentWeek: week,
    createPlayer(value: unknown, tokenValue: unknown): { token: string } & Me {
      const username = normalizeUsername(value);
      const token = recoveryToken(tokenValue);
      const tokenHash = hashToken(token);
      return transaction("createPlayer", () => {
        const existing = db.prepare("SELECT id,username FROM players WHERE token_hash=?").get(tokenHash);
        if (existing) {
          if (existing.username === username) return { token, ...me(String(existing.id)) };
          throw new ApiError(409, "That recovery key is already in use.");
        }
        usernameAvailable(username);
        const id = opaque("p");
        db.prepare("INSERT INTO players(id,token_hash,username,created_at) VALUES (?,?,?,?)").run(id, tokenHash, username, now().getTime());
        return { token, ...me(id) };
      });
    },
    authenticate(token: string): string {
      if (!/^[0-9a-f]{64}$/.test(token)) throw new ApiError(401, "Invalid account token.");
      const row = db.prepare("SELECT id FROM players WHERE token_hash=?").get(hashToken(token));
      if (!row) throw new ApiError(401, "Invalid account token.");
      return String(row.id);
    },
    rotateToken(id: string, replacement: unknown): { token: string } & Me {
      const token = recoveryToken(replacement);
      const tokenHash = hashToken(token);
      return transaction("rotateToken", () => {
        current(id);
        const existing = db.prepare("SELECT id FROM players WHERE token_hash=?").get(tokenHash);
        if (existing && existing.id !== id) throw new ApiError(409, "That recovery key is already in use.");
        db.prepare("UPDATE players SET token_hash=? WHERE id=?").run(tokenHash, id);
        return { token, ...me(id) };
      });
    },
    me,
    playerView,
    userView(value: unknown): PlayerView {
      const username = normalizeUsername(value);
      const row = db.prepare("SELECT id FROM players WHERE username=? COLLATE NOCASE").get(username);
      if (!row) throw new ApiError(404, "Player not found.");
      return playerView(String(row.id));
    },
    claimUsername(id: string, value: unknown): Me {
      const username = normalizeUsername(value);
      return transaction("claimUsername", () => {
        const row = db.prepare("SELECT username FROM players WHERE id=?").get(id);
        if (!row) throw new ApiError(404, "Player not found.");
        if (row.username === username) return me(id);
        if (row.username !== null) throw new ApiError(409, "Your username is already set and cannot be changed.");
        usernameAvailable(username);
        db.prepare("UPDATE players SET username=? WHERE id=? AND username IS NULL").run(username, id);
        return me(id);
      });
    },
    importForm,
    assessment(id: string, value: { weekId: unknown; formScore: unknown; coveragePpm: unknown; certaintyPpm: unknown }): Me {
      if (typeof value.weekId !== "string" || typeof value.formScore !== "number" ||
          typeof value.coveragePpm !== "number" || typeof value.certaintyPpm !== "number") {
        throw new ApiError(400, "Invalid assessment. Use a UTC ISO week and whole-number scores and confidence.");
      }
      let source: PlayerReceipt;
      try {
        source = buildPlayerReceipt({ player_id: id, competition_id: competitionId, week_id: value.weekId,
          form_score: value.formScore, coverage_ppm: value.coveragePpm, certainty_ppm: value.certaintyPpm });
      } catch { throw new ApiError(400, "Invalid assessment. Use a UTC ISO week and whole-number scores and confidence."); }
      return importForm(id, source);
    },
    joinQueue(id: string, mode: EloMode): QueueResult {
      return transaction("joinQueue", () => {
        const weekId = week();
        const previous = existingMatch(id, weekId, mode);
        if (previous) return { status: "matched", match: previous };
        const player = current(id);
        if (!player || player.week_id !== weekId) throw new ApiError(409, "Import this week's Form before entering the queue.");
        const band = player.form.confidence.effective_ppm < LOW_CONFIDENCE_THRESHOLD_PPM ? "exhibition" : "rated";
        db.prepare("INSERT OR IGNORE INTO form_locks(player_id,week_id) VALUES (?,?)").run(id, weekId);
        db.prepare("INSERT OR IGNORE INTO queue(player_id,week_id,mode,band) VALUES (?,?,?,?)").run(id, weekId, mode, band);
        const opponent = db.prepare(`SELECT player_id FROM queue WHERE week_id=? AND mode=? AND band=?
          AND player_id<>? ORDER BY id LIMIT 1`).get(weekId, mode, band, id);
        if (!opponent) return { status: "queued", match: null };
        const opponentId = String(opponent.player_id);
        const opponentReceipt = current(opponentId);
        if (!opponentReceipt) throw new Error("Queue integrity failure");
        const [match, a, b] = buildMatchReceipt({ receipt_a: opponentReceipt, receipt_b: player, mode, match_id: opaque("m") });
        archive(opponentReceipt);
        archive(player);
        archive(match);
        db.prepare("INSERT INTO matches(id,week_id,mode,receipt,created_at) VALUES (?,?,?,?,?)")
          .run(match.match_id, weekId, mode, JSON.stringify(match), now().getTime());
        for (const playerId of [opponentId, id]) {
          db.prepare("INSERT INTO participation(player_id,week_id,mode,match_id) VALUES (?,?,?,?)").run(playerId, weekId, mode, match.match_id);
          db.prepare("DELETE FROM queue WHERE player_id=? AND week_id=? AND mode=?").run(playerId, weekId, mode);
        }
        if (a) savePlayer(a);
        if (b) savePlayer(b);
        return { status: "matched", match };
      });
    },
    cancelQueue(id: string, mode: EloMode): Me {
      return transaction("cancelQueue", () => {
        current(id);
        db.prepare("DELETE FROM queue WHERE player_id=? AND week_id=? AND mode=?").run(id, week(), mode);
        return me(id);
      });
    },
    receipt(fingerprint: string): Receipt {
      const row = db.prepare("SELECT receipt FROM receipts WHERE fingerprint=?").get(fingerprint);
      if (!row) throw new ApiError(404, "Receipt not found.");
      return storedReceipt(row.receipt, fingerprint);
    },
    match(id: string): MatchReceipt {
      const row = db.prepare("SELECT id,week_id,mode,receipt FROM matches WHERE id=?").get(id);
      if (!row) throw new ApiError(404, "Match not found.");
      return storedMatch(row);
    },
    overview(mode: EloMode): Overview {
      // The mode is selected from two literals, never interpolated from an unvalidated request.
      if (mode !== "scalar" && mode !== "binary") throw new ApiError(400, "Invalid mode.");
      const rating = `COALESCE(json_extract(receipt,'$.elo.${mode}.rating_milli'),${STARTING_RATING_MILLI})`;
      const count = `COALESCE(json_extract(receipt,'$.elo.${mode}.rated_matches'),0)`;
      const rows = db.prepare(`SELECT id,username,receipt FROM players ORDER BY (${count}>0) DESC, ${rating} DESC, ${count} DESC,id LIMIT 100`).all();
      const players: Standing[] = rows.map((row, index) => {
        const receipt = storedPlayer(row.receipt, String(row.id));
        const state = receipt?.elo[mode];
        return { id: String(row.id), username: row.username as string | null, rank: state && state.rated_matches > 0 ? index + 1 : null,
          ratingMilli: state?.rating_milli ?? STARTING_RATING_MILLI, ratedMatches: state?.rated_matches ?? 0,
          formScore: receipt?.form.score ?? null, confidencePpm: receipt?.form.confidence.effective_ppm ?? null,
          weekId: receipt?.week_id ?? null };
      });
      const counts = db.prepare(`SELECT COUNT(*) AS players, SUM(CASE WHEN ${count}>0 THEN 1 ELSE 0 END) AS rated FROM players`).get()!;
      const matches = db.prepare("SELECT id,week_id,mode,receipt FROM matches WHERE mode=? ORDER BY created_at DESC,rowid DESC LIMIT 50").all(mode).map(storedMatch);
      const matchCount = db.prepare("SELECT COUNT(*) AS total FROM matches WHERE mode=?").get(mode)!;
      const queueCount = db.prepare("SELECT COUNT(*) AS total FROM queue WHERE mode=? AND week_id=?").get(mode, week())!;
      return { competitionId, weekId: week(), mode, players, matches, usernames: usernamesFor(players.map(player => player.id), matches),
        stats: { players: Number(counts.players), ratedPlayers: Number(counts.rated ?? 0), matches: Number(matchCount.total), queued: Number(queueCount.total) } };
    },
  };
}

export type Store = ReturnType<typeof createStore>;
