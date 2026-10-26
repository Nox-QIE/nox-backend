import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Hex } from "viem";
import type { AgentRecord, Persona } from "./agents.js";
import type { LedgerNightReveal, LedgerRoleReveal } from "./chain/ledger.js";
import type { Lang } from "./i18n.js";

/** "disputed" games keep their secrets (the evidence) and are never purged automatically. */
export type GameStatus = "running" | "ended" | "finalized" | "cancelled" | "disputed";

/** Everything needed to reveal a game later. Secret until revealed: salts expose roles. */
export interface GameSecret {
  roles: LedgerRoleReveal[];
  nights: LedgerNightReveal[];
}

export interface FinalizePayload extends GameSecret {
  resultHash: Hex;
  winner: number;
}

export interface FinishedGame {
  id: number;
  agentId: number | null;
  players: number;
  hostId: number;
  chainGameId: Hex | null;
  endedAt: number;
}

export interface GameRecord {
  gameId: Hex;
  chatId: number;
  lang: Lang;
  status: GameStatus;
  secret: GameSecret;
  finalize: FinalizePayload | null;
}

export interface Store {
  startedUsers(): number[];
  addStartedUser(userId: number): void;
  saveGame(gameId: Hex, chatId: number, lang: Lang, secret: GameSecret): void;
  updateSecret(gameId: Hex, secret: GameSecret): void;
  markEnded(gameId: Hex, payload: FinalizePayload): void;
  setStatus(gameId: Hex, status: "finalized" | "cancelled" | "disputed"): void;
  /** Group and language of a stored game (for messages after it left memory). */
  gameInfo(gameId: Hex): { chatId: number; lang: Lang; status: GameStatus } | null;
  /** Games whose on-chain record is not settled yet (running or ended, not finalized/cancelled). */
  unsettledGames(): GameRecord[];
  /** Delete secrets of games settled before `beforeMs` (their roles are public on-chain by then). */
  purgeSettledSecrets(beforeMs: number): number;
  /** Right to erasure for off-chain data: forget a player who pressed Start and unlink them as host. */
  forgetUser(userId: number): void;
  addAgent(owner: string, persona: Persona): number;
  getAgent(id: number): AgentRecord | null;
  listAgents(activeOnly?: boolean): AgentRecord[];
  setAgentStatus(id: number, status: AgentRecord["status"]): void;
  setChainAgentId(id: number, chainAgentId: number): void;
  /** Every finished game (agentId null = Nox's own GM): the input for monthly agent revenue settlement. */
  recordFinishedGame(g: { agentId: number | null; players: number; hostId: number; chainGameId: Hex | null }): void;
  finishedGames(fromMs: number, toMs: number): FinishedGame[];
  agentUsage(fromMs: number, toMs: number): { agentId: number; games: number; players: number }[];
}

/** Store encryption key, derived from the wallet secret so there is no extra secret to manage. */
export function storeKey(walletSecretHex: string): Buffer {
  const secret = Buffer.from(walletSecretHex.replace(/^0x/, ""), "hex");
  return Buffer.from(hkdfSync("sha256", secret, "nox-store-v1", "game-secrets", 32));
}

/**
 * SQLite (node:sqlite) store. Player ids are plain; game secrets and finalize payloads are sealed
 * with AES-256-GCM (random 12-byte IV per write, auth tag checked on read).
 */
export class SqliteStore implements Store {
  private readonly db: DatabaseSync;

  constructor(
    path: string,
    private readonly key: Buffer | null = null,
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (telegram_id INTEGER PRIMARY KEY, started_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner TEXT NOT NULL,
        persona TEXT NOT NULL,
        status TEXT NOT NULL,
        chain_agent_id INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS finished_games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id INTEGER,
        players INTEGER NOT NULL,
        host_id INTEGER NOT NULL,
        chain_game_id TEXT,
        ended_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS games (
        game_id TEXT PRIMARY KEY,
        chat_id INTEGER NOT NULL,
        lang TEXT NOT NULL,
        status TEXT NOT NULL,
        secret BLOB NOT NULL,
        finalize BLOB,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  close() {
    this.db.close();
  }

  private seal(value: unknown): Buffer {
    if (!this.key) throw new Error("store has no encryption key (NOX_WALLET_SECRET) for game secrets");
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]);
  }

  private open<T>(blob: Uint8Array): T {
    if (!this.key) throw new Error("store has no encryption key (NOX_WALLET_SECRET) for game secrets");
    const b = Buffer.from(blob);
    const d = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8")) as T;
  }

  startedUsers() {
    return (this.db.prepare("SELECT telegram_id FROM users").all() as { telegram_id: number }[]).map((r) => r.telegram_id);
  }

  addStartedUser(userId: number) {
    this.db.prepare("INSERT OR IGNORE INTO users (telegram_id, started_at) VALUES (?, ?)").run(userId, Date.now());
  }

  saveGame(gameId: Hex, chatId: number, lang: Lang, secret: GameSecret) {
    this.db
      .prepare("INSERT INTO games (game_id, chat_id, lang, status, secret, updated_at) VALUES (?, ?, ?, 'running', ?, ?)")
      .run(gameId, chatId, lang, this.seal(secret), Date.now());
  }

  updateSecret(gameId: Hex, secret: GameSecret) {
    this.db.prepare("UPDATE games SET secret = ?, updated_at = ? WHERE game_id = ?").run(this.seal(secret), Date.now(), gameId);
  }

  markEnded(gameId: Hex, payload: FinalizePayload) {
    this.db
      .prepare("UPDATE games SET status = 'ended', finalize = ?, updated_at = ? WHERE game_id = ?")
      .run(this.seal(payload), Date.now(), gameId);
  }

  setStatus(gameId: Hex, status: "finalized" | "cancelled" | "disputed") {
    this.db.prepare("UPDATE games SET status = ?, updated_at = ? WHERE game_id = ?").run(status, Date.now(), gameId);
  }

  gameInfo(gameId: Hex) {
    const r = this.db.prepare("SELECT chat_id, lang, status FROM games WHERE game_id = ?").get(gameId) as { chat_id: number; lang: Lang; status: GameStatus } | undefined;
    return r ? { chatId: r.chat_id, lang: r.lang, status: r.status } : null;
  }

  purgeSettledSecrets(beforeMs: number): number {
    return Number(this.db.prepare("DELETE FROM games WHERE status IN ('finalized', 'cancelled') AND updated_at < ?").run(beforeMs).changes);
  }

  forgetUser(userId: number) {
    this.db.prepare("DELETE FROM users WHERE telegram_id = ?").run(userId);
    // Settlement only needs to know that one host ran several games, not who: keep a stable stand-in.
    this.db.prepare("UPDATE finished_games SET host_id = -abs(host_id) WHERE host_id = ?").run(userId);
  }

  unsettledGames(): GameRecord[] {
    const rows = this.db
      .prepare("SELECT game_id, chat_id, lang, status, secret, finalize FROM games WHERE status IN ('running', 'ended') ORDER BY updated_at")
      .all() as { game_id: Hex; chat_id: number; lang: Lang; status: GameStatus; secret: Uint8Array; finalize: Uint8Array | null }[];
    return rows.map((r) => ({
      gameId: r.game_id,
      chatId: r.chat_id,
      lang: r.lang,
      status: r.status,
      secret: this.open<GameSecret>(r.secret),
      finalize: r.finalize ? this.open<FinalizePayload>(r.finalize) : null,
    }));
  }

  addAgent(owner: string, persona: Persona): number {
    const r = this.db
      .prepare("INSERT INTO agents (owner, persona, status, created_at) VALUES (?, ?, 'active', ?)")
      .run(owner, JSON.stringify(persona), Date.now());
    return Number(r.lastInsertRowid);
  }

  private toAgent(r: { id: number; owner: string; persona: string; status: AgentRecord["status"]; chain_agent_id: number | null }): AgentRecord {
    return { id: r.id, owner: r.owner, persona: JSON.parse(r.persona) as Persona, status: r.status, chainAgentId: r.chain_agent_id };
  }

  getAgent(id: number): AgentRecord | null {
    const r = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Parameters<SqliteStore["toAgent"]>[0] | undefined;
    return r ? this.toAgent(r) : null;
  }

  listAgents(activeOnly = false): AgentRecord[] {
    const sql = activeOnly ? "SELECT * FROM agents WHERE status = 'active' ORDER BY id" : "SELECT * FROM agents ORDER BY id";
    return (this.db.prepare(sql).all() as Parameters<SqliteStore["toAgent"]>[0][]).map((r) => this.toAgent(r));
  }

  setAgentStatus(id: number, status: AgentRecord["status"]) {
    this.db.prepare("UPDATE agents SET status = ? WHERE id = ?").run(status, id);
  }

  setChainAgentId(id: number, chainAgentId: number) {
    this.db.prepare("UPDATE agents SET chain_agent_id = ? WHERE id = ?").run(chainAgentId, id);
  }

  recordFinishedGame(g: { agentId: number | null; players: number; hostId: number; chainGameId: Hex | null }) {
    this.db
      .prepare("INSERT INTO finished_games (agent_id, players, host_id, chain_game_id, ended_at) VALUES (?, ?, ?, ?, ?)")
      .run(g.agentId, g.players, g.hostId, g.chainGameId, Date.now());
  }

  finishedGames(fromMs: number, toMs: number): FinishedGame[] {
    return this.db
      .prepare(
        "SELECT id, agent_id AS agentId, players, host_id AS hostId, chain_game_id AS chainGameId, ended_at AS endedAt FROM finished_games WHERE ended_at >= ? AND ended_at < ? ORDER BY id",
      )
      .all(fromMs, toMs) as unknown as FinishedGame[];
  }

  agentUsage(fromMs: number, toMs: number) {
    return this.db
      .prepare(
        "SELECT agent_id AS agentId, COUNT(*) AS games, SUM(players) AS players FROM finished_games WHERE agent_id IS NOT NULL AND ended_at >= ? AND ended_at < ? GROUP BY agent_id ORDER BY agent_id",
      )
      .all(fromMs, toMs) as { agentId: number; games: number; players: number }[];
  }
}
