import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Hex } from "viem";
import { AGENT_TERMS, type AgentRecord, type Persona } from "./agents.js";
import type { LedgerNightReveal, LedgerRoleReveal } from "./chain/ledger.js";
import type { TxRecord } from "./chain/viem-ledger.js";
import type { NarratorReport } from "./narrator.js";
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
  /**
   * D1 player account (F01-D01): created on the first Start, updated on later ones (idempotent).
   * `address` is the player's derived game wallet; returns whether the account is new.
   */
  upsertUser(userId: number, u: { locale: Lang; address: string | null }): { isNew: boolean };
  getUser(userId: number): PlayerAccount | null;
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
  /** `termsVersion`: the agent terms version the owner accepted (AGENT_TERMS). */
  addAgent(owner: string, persona: Persona, termsVersion: number): number;
  /** An agent backed by its owner's https service; `secret` signs Nox's requests and is stored encrypted. */
  addEndpointAgent(owner: string, persona: Persona, endpoint: string, secret: string, termsVersion: number): number;
  /** Record that the owner accepted agent terms `version`. */
  acceptAgentTerms(id: number, version: number): void;
  agentSecret(id: number): string | null;
  getAgent(id: number): AgentRecord | null;
  /** `activeOnly`: what lobbies may offer, active agents whose owner accepted the current terms. */
  listAgents(activeOnly?: boolean): AgentRecord[];
  setAgentStatus(id: number, status: AgentRecord["status"]): void;
  setChainAgentId(id: number, chainAgentId: number): void;
  /** Every finished game (agentId null = Nox's own GM): the input for monthly agent revenue settlement. */
  /** `chatId` (the Telegram group) feeds the Game Night engagement report; it identifies a group, not a person. */
  recordFinishedGame(g: { agentId: number | null; players: number; hostId: number; chainGameId: Hex | null; chatId?: number }): void;
  finishedGames(fromMs: number, toMs: number): FinishedGame[];
  finishedGamesOfChat(chatId: number, fromMs: number, toMs: number): FinishedGame[];
  agentUsage(fromMs: number, toMs: number): { agentId: number; games: number; players: number }[];
  /** Gas & transaction ledger (D14): one row per transaction the ledger sent or gave up on. */
  recordTx(tx: TxRecord): void;
  txsOfGame(gameId: Hex): StoredTx[];
  txsBetween(fromMs: number, toMs: number): StoredTx[];
  recordOperatorBalance(wei: bigint): void;
  /** AI use per finished game (F09-D05). */
  recordGmGame(g: { gameId: Hex | null; agentId: number | null; players: number; report: NarratorReport }): void;
  gmGames(fromMs: number, toMs: number): GmGameRow[];
  /** Scam Shield practice (F10-D05): daily counts only, never who took it or how they answered. */
  practiceStarted(): void;
  practiceFinished(): void;
  practiceStats(fromDay: string): { day: string; started: number; finished: number }[];
  /** Agent health (F18-S11): one row per finished game narrated by a Marketplace agent. */
  recordAgentGame(agentId: number, report: NarratorReport): void;
  agentGames(agentId: number, limit: number): AgentGame[];
  /** Moderation log (F18-D06): every suspend/activate decision with its reason. */
  addModeration(agentId: number, decision: "suspended" | "activated" | "note", reason: string, by: string): void;
  moderationLog(agentId: number): ModerationEntry[];
  operatorBalances(fromMs: number): { at: number; wei: bigint }[];
}

export interface GmGameRow {
  gameId: Hex | null;
  agentId: number | null;
  players: number;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  persona: number;
  nox: number;
  template: number;
  at: number;
}

export interface AgentGame extends NarratorReport {
  at: number;
}

export interface ModerationEntry {
  agentId: number;
  decision: "suspended" | "activated" | "note";
  reason: string;
  /** "auto" for automatic suspension, otherwise the operator. */
  by: string;
  at: number;
}

export interface PlayerAccount {
  telegramId: number;
  locale: Lang | null;
  address: string | null;
  status: "active";
  startedAt: number;
  lastSeen: number | null;
}

export interface StoredTx extends TxRecord {
  at: number;
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
        created_at INTEGER NOT NULL,
        mode TEXT NOT NULL DEFAULT 'persona',
        endpoint TEXT,
        secret BLOB,
        terms_version INTEGER,
        terms_accepted_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS finished_games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id INTEGER,
        players INTEGER NOT NULL,
        host_id INTEGER NOT NULL,
        chain_game_id TEXT,
        ended_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chain_txs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id TEXT,
        step TEXT NOT NULL,
        from_addr TEXT NOT NULL,
        to_addr TEXT NOT NULL,
        hash TEXT,
        status TEXT NOT NULL,
        gas_used TEXT,
        fee_wei TEXT,
        block INTEGER,
        attempts INTEGER NOT NULL,
        error TEXT,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chain_txs_game ON chain_txs (game_id);
      CREATE INDEX IF NOT EXISTS chain_txs_at ON chain_txs (at);
      CREATE TABLE IF NOT EXISTS operator_balances (at INTEGER PRIMARY KEY, wei TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gm_games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id TEXT,
        agent_id INTEGER,
        players INTEGER NOT NULL,
        model TEXT,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cost_usd REAL,
        persona INTEGER NOT NULL,
        nox INTEGER NOT NULL,
        template INTEGER NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS practice_stats (day TEXT PRIMARY KEY, started INTEGER NOT NULL DEFAULT 0, finished INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS agent_games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id INTEGER NOT NULL,
        persona INTEGER NOT NULL,
        nox INTEGER NOT NULL,
        template INTEGER NOT NULL,
        rejected INTEGER NOT NULL,
        demoted INTEGER NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_games_agent ON agent_games (agent_id, id);
      CREATE TABLE IF NOT EXISTS agent_moderation (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id INTEGER NOT NULL,
        decision TEXT NOT NULL,
        reason TEXT NOT NULL,
        by_whom TEXT NOT NULL,
        at INTEGER NOT NULL
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
    // Databases created before endpoint agents (F18-S10) lack these columns.
    const cols = new Set((this.db.prepare("PRAGMA table_info(agents)").all() as { name: string }[]).map((c) => c.name));
    if (!cols.has("mode")) this.db.exec("ALTER TABLE agents ADD COLUMN mode TEXT NOT NULL DEFAULT 'persona'");
    if (!cols.has("endpoint")) this.db.exec("ALTER TABLE agents ADD COLUMN endpoint TEXT");
    if (!cols.has("secret")) this.db.exec("ALTER TABLE agents ADD COLUMN secret BLOB");
    // Agents added before the owner terms (L0-13) have none recorded, so lobbies hide them until accepted.
    if (!cols.has("terms_version")) this.db.exec("ALTER TABLE agents ADD COLUMN terms_version INTEGER");
    if (!cols.has("terms_accepted_at")) this.db.exec("ALTER TABLE agents ADD COLUMN terms_accepted_at INTEGER");
    const userCols = new Set((this.db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name));
    if (!userCols.has("locale")) this.db.exec("ALTER TABLE users ADD COLUMN locale TEXT");
    if (!userCols.has("address")) this.db.exec("ALTER TABLE users ADD COLUMN address TEXT");
    if (!userCols.has("status")) this.db.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
    if (!userCols.has("last_seen")) this.db.exec("ALTER TABLE users ADD COLUMN last_seen INTEGER");
    // One wallet per account: derived wallets are unique by construction, the index makes it a rule.
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_address ON users (address) WHERE address IS NOT NULL");
    const fgCols = new Set((this.db.prepare("PRAGMA table_info(finished_games)").all() as { name: string }[]).map((c) => c.name));
    if (!fgCols.has("chat_id")) this.db.exec("ALTER TABLE finished_games ADD COLUMN chat_id INTEGER");
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

  upsertUser(userId: number, u: { locale: Lang; address: string | null }) {
    const now = Date.now();
    const existed = this.db.prepare("SELECT 1 FROM users WHERE telegram_id = ?").get(userId) !== undefined;
    this.db
      .prepare(
        `INSERT INTO users (telegram_id, started_at, locale, address, last_seen) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (telegram_id) DO UPDATE SET locale = excluded.locale, address = COALESCE(users.address, excluded.address), last_seen = excluded.last_seen`,
      )
      .run(userId, now, u.locale, u.address, now);
    return { isNew: !existed };
  }

  getUser(userId: number): PlayerAccount | null {
    const r = this.db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(userId) as Record<string, string | number | null> | undefined;
    return r
      ? {
          telegramId: Number(r.telegram_id),
          locale: (r.locale as Lang | null) ?? null,
          address: (r.address as string | null) ?? null,
          status: "active",
          startedAt: Number(r.started_at),
          lastSeen: r.last_seen == null ? null : Number(r.last_seen),
        }
      : null;
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

  addAgent(owner: string, persona: Persona, termsVersion: number): number {
    const now = Date.now();
    const r = this.db
      .prepare("INSERT INTO agents (owner, persona, status, created_at, terms_version, terms_accepted_at) VALUES (?, ?, 'active', ?, ?, ?)")
      .run(owner, JSON.stringify(persona), now, termsVersion, now);
    return Number(r.lastInsertRowid);
  }

  addEndpointAgent(owner: string, persona: Persona, endpoint: string, secret: string, termsVersion: number): number {
    const now = Date.now();
    const r = this.db
      .prepare(
        "INSERT INTO agents (owner, persona, status, created_at, mode, endpoint, secret, terms_version, terms_accepted_at) VALUES (?, ?, 'active', ?, 'endpoint', ?, ?, ?, ?)",
      )
      .run(owner, JSON.stringify(persona), now, endpoint, this.seal(secret), termsVersion, now);
    return Number(r.lastInsertRowid);
  }

  acceptAgentTerms(id: number, version: number) {
    this.db.prepare("UPDATE agents SET terms_version = ?, terms_accepted_at = ? WHERE id = ?").run(version, Date.now(), id);
  }

  agentSecret(id: number): string | null {
    const r = this.db.prepare("SELECT secret FROM agents WHERE id = ?").get(id) as { secret: Uint8Array | null } | undefined;
    return r?.secret ? this.open<string>(r.secret) : null;
  }

  private toAgent(r: {
    id: number;
    owner: string;
    persona: string;
    status: AgentRecord["status"];
    chain_agent_id: number | null;
    mode: "persona" | "endpoint";
    endpoint: string | null;
    terms_version: number | null;
  }): AgentRecord {
    return {
      id: r.id,
      owner: r.owner,
      persona: JSON.parse(r.persona) as Persona,
      status: r.status,
      chainAgentId: r.chain_agent_id,
      mode: r.mode,
      endpoint: r.endpoint,
      termsVersion: r.terms_version,
    };
  }

  getAgent(id: number): AgentRecord | null {
    const r = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Parameters<SqliteStore["toAgent"]>[0] | undefined;
    return r ? this.toAgent(r) : null;
  }

  listAgents(activeOnly = false): AgentRecord[] {
    const rows = activeOnly
      ? this.db.prepare("SELECT * FROM agents WHERE status = 'active' AND terms_version >= ? ORDER BY id").all(AGENT_TERMS.version)
      : this.db.prepare("SELECT * FROM agents ORDER BY id").all();
    return (rows as Parameters<SqliteStore["toAgent"]>[0][]).map((r) => this.toAgent(r));
  }

  setAgentStatus(id: number, status: AgentRecord["status"]) {
    this.db.prepare("UPDATE agents SET status = ? WHERE id = ?").run(status, id);
  }

  setChainAgentId(id: number, chainAgentId: number) {
    this.db.prepare("UPDATE agents SET chain_agent_id = ? WHERE id = ?").run(chainAgentId, id);
  }

  recordFinishedGame(g: { agentId: number | null; players: number; hostId: number; chainGameId: Hex | null; chatId?: number }) {
    this.db
      .prepare("INSERT INTO finished_games (agent_id, players, host_id, chain_game_id, ended_at, chat_id) VALUES (?, ?, ?, ?, ?, ?)")
      .run(g.agentId, g.players, g.hostId, g.chainGameId, Date.now(), g.chatId ?? null);
  }

  finishedGamesOfChat(chatId: number, fromMs: number, toMs: number): FinishedGame[] {
    return this.db
      .prepare(
        "SELECT id, agent_id AS agentId, players, host_id AS hostId, chain_game_id AS chainGameId, ended_at AS endedAt FROM finished_games WHERE chat_id = ? AND ended_at >= ? AND ended_at < ? ORDER BY id",
      )
      .all(chatId, fromMs, toMs) as unknown as FinishedGame[];
  }

  finishedGames(fromMs: number, toMs: number): FinishedGame[] {
    return this.db
      .prepare(
        "SELECT id, agent_id AS agentId, players, host_id AS hostId, chain_game_id AS chainGameId, ended_at AS endedAt FROM finished_games WHERE ended_at >= ? AND ended_at < ? ORDER BY id",
      )
      .all(fromMs, toMs) as unknown as FinishedGame[];
  }

  recordTx(tx: TxRecord) {
    this.db
      .prepare(
        "INSERT INTO chain_txs (game_id, step, from_addr, to_addr, hash, status, gas_used, fee_wei, block, attempts, error, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        tx.gameId,
        tx.step,
        tx.from,
        tx.to,
        tx.hash,
        tx.status,
        tx.gasUsed?.toString() ?? null,
        tx.feeWei?.toString() ?? null,
        tx.block === null ? null : Number(tx.block),
        tx.attempts,
        tx.error,
        Date.now(),
      );
  }

  private txs(where: string, ...params: (string | number)[]): StoredTx[] {
    const rows = this.db.prepare(`SELECT * FROM chain_txs WHERE ${where} ORDER BY id`).all(...params) as Record<string, string | number | null>[];
    return rows.map((r) => ({
      gameId: r.game_id as Hex | null,
      step: r.step as string,
      from: r.from_addr as Hex,
      to: r.to_addr as Hex,
      hash: r.hash as Hex | null,
      status: r.status as TxRecord["status"],
      gasUsed: r.gas_used == null ? null : BigInt(r.gas_used),
      feeWei: r.fee_wei == null ? null : BigInt(r.fee_wei),
      block: r.block == null ? null : BigInt(r.block),
      attempts: Number(r.attempts),
      error: r.error as string | null,
      at: Number(r.at),
    }));
  }

  txsOfGame(gameId: Hex) {
    return this.txs("game_id = ?", gameId);
  }

  txsBetween(fromMs: number, toMs: number) {
    return this.txs("at >= ? AND at < ?", fromMs, toMs);
  }

  recordGmGame(g: { gameId: Hex | null; agentId: number | null; players: number; report: NarratorReport }) {
    const r = g.report;
    this.db
      .prepare(
        "INSERT INTO gm_games (game_id, agent_id, players, model, input_tokens, output_tokens, cost_usd, persona, nox, template, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(g.gameId, g.agentId, g.players, r.model ?? null, r.inputTokens ?? 0, r.outputTokens ?? 0, r.costUsd ?? null, r.persona, r.nox, r.template, Date.now());
  }

  gmGames(fromMs: number, toMs: number): GmGameRow[] {
    return (this.db.prepare("SELECT * FROM gm_games WHERE at >= ? AND at < ? ORDER BY id").all(fromMs, toMs) as Record<string, string | number | null>[]).map((r) => ({
      gameId: r.game_id as Hex | null,
      agentId: r.agent_id == null ? null : Number(r.agent_id),
      players: Number(r.players),
      model: (r.model as string | null) ?? null,
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      costUsd: r.cost_usd == null ? null : Number(r.cost_usd),
      persona: Number(r.persona),
      nox: Number(r.nox),
      template: Number(r.template),
      at: Number(r.at),
    }));
  }

  private practiceBump(column: "started" | "finished") {
    const day = new Date().toISOString().slice(0, 10);
    this.db.prepare(`INSERT INTO practice_stats (day, ${column}) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET ${column} = ${column} + 1`).run(day);
  }

  practiceStarted() {
    this.practiceBump("started");
  }

  practiceFinished() {
    this.practiceBump("finished");
  }

  practiceStats(fromDay: string) {
    return this.db.prepare("SELECT day, started, finished FROM practice_stats WHERE day >= ? ORDER BY day").all(fromDay) as { day: string; started: number; finished: number }[];
  }

  recordOperatorBalance(wei: bigint) {
    this.db.prepare("INSERT OR REPLACE INTO operator_balances (at, wei) VALUES (?, ?)").run(Date.now(), wei.toString());
  }

  operatorBalances(fromMs: number) {
    return (this.db.prepare("SELECT at, wei FROM operator_balances WHERE at >= ? ORDER BY at").all(fromMs) as { at: number; wei: string }[]).map((r) => ({
      at: r.at,
      wei: BigInt(r.wei),
    }));
  }

  recordAgentGame(agentId: number, r: NarratorReport) {
    this.db
      .prepare("INSERT INTO agent_games (agent_id, persona, nox, template, rejected, demoted, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(agentId, r.persona, r.nox, r.template, r.rejected, r.demoted ? 1 : 0, Date.now());
  }

  agentGames(agentId: number, limit: number): AgentGame[] {
    return (
      this.db.prepare("SELECT * FROM agent_games WHERE agent_id = ? ORDER BY id DESC LIMIT ?").all(agentId, limit) as Record<string, number>[]
    ).map((r) => ({ persona: r.persona!, nox: r.nox!, template: r.template!, rejected: r.rejected!, demoted: r.demoted === 1, at: r.at! }));
  }

  addModeration(agentId: number, decision: ModerationEntry["decision"], reason: string, by: string) {
    this.db.prepare("INSERT INTO agent_moderation (agent_id, decision, reason, by_whom, at) VALUES (?, ?, ?, ?, ?)").run(agentId, decision, reason, by, Date.now());
  }

  moderationLog(agentId: number): ModerationEntry[] {
    return (this.db.prepare("SELECT * FROM agent_moderation WHERE agent_id = ? ORDER BY id").all(agentId) as Record<string, string | number>[]).map((r) => ({
      agentId: Number(r.agent_id),
      decision: r.decision as ModerationEntry["decision"],
      reason: String(r.reason),
      by: String(r.by_whom),
      at: Number(r.at),
    }));
  }

  agentUsage(fromMs: number, toMs: number) {
    return this.db
      .prepare(
        "SELECT agent_id AS agentId, COUNT(*) AS games, SUM(players) AS players FROM finished_games WHERE agent_id IS NOT NULL AND ended_at >= ? AND ended_at < ? GROUP BY agent_id ORDER BY agent_id",
      )
      .all(fromMs, toMs) as { agentId: number; games: number; players: number }[];
  }
}
