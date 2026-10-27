import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Hex } from "viem";
import { blobVersion, open as openBlob, seal as sealBlob, type StoreKeyring } from "./store-keys.js";
import { AGENT_TERMS, type AgentRecord, type Persona } from "./agents.js";
import type { Booking, BookingStatus } from "./bookings.js";
import type { ClientTheme } from "./client-themes.js";
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

/** A Host Pass paid in rupiah and recorded on chain by the operator (D9). */
export interface FiatPass {
  receiptHash: Hex;
  holder: Hex;
  passType: number;
  periods: number;
  amount: number;
  currency: "IDR";
  tx: Hex;
  at: number;
}

/** Discussion activity over finished games (F07-D06). Only games whose group messages could be counted carry messages. */
export interface DiscussionStats {
  games: number;
  /** Games where the bot could see group messages (Telegram privacy mode off). */
  countedGames: number;
  discussions: number;
  messages: number;
  /** Discussions with no message at all. */
  quietDiscussions: number;
  nudges: number;
}

/** A finished Scam Shield game: the scenario (key@version), its size, group and outcome. */
export interface ScenarioGame {
  scenario: string;
  players: number;
  chatId: number | null;
  winner: string | null;
  endedAt: number;
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
  upsertUser(userId: number, u: { locale: Lang; address: string | null; country?: string | null }): { isNew: boolean };
  getUser(userId: number): PlayerAccount | null;
  /** The player's own country choice (/negara), which picks the payment rail (F14-D04). */
  setUserCountry(userId: number, country: string): boolean;
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
  /** Daily Night Watch (10.07 #7): one answer per user and UTC day. */
  nightWatchAnswer(userId: number, day: string): { correct: boolean } | null;
  recordNightWatch(userId: number, day: string, correct: boolean): void;
  nightWatchStreak(userId: number, day: string): number;
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
  /** `scenario` (Scam Shield key) and `winner` feed the sponsor report (F10-D04). */
  recordFinishedGame(g: { agentId: number | null; players: number; hostId: number; chainGameId: Hex | null; chatId?: number; scenario?: string | null; winner?: string | null; discussion?: number[] | null; nudges?: number }): void;
  /** Discussion activity (F07-D06): messages per discussion and nudges, counts only. */
  discussionStats(fromMs: number, toMs: number): DiscussionStats;
  /** Finished Scam Shield games in [fromMs, toMs): counts only, for sponsors. */
  scenarioGames(fromMs: number, toMs: number): ScenarioGame[];
  finishedGames(fromMs: number, toMs: number): FinishedGame[];
  finishedGamesOfChat(chatId: number, fromMs: number, toMs: number): FinishedGame[];
  agentUsage(fromMs: number, toMs: number): { agentId: number; games: number; players: number }[];
  /** Gas & transaction ledger (D14): one row per transaction the ledger sent or gave up on. */
  recordTx(tx: TxRecord): void;
  txsOfGame(gameId: Hex): StoredTx[];
  txsBetween(fromMs: number, toMs: number): StoredTx[];
  /** A wallet's audit history (F01-D05): created, gas drips with their reason, forgotten. Addresses only. */
  walletAudit(address: string): WalletAuditEntry[];
  /** Wallets created per UTC day. */
  walletsCreated(fromMs: number, toMs: number): { day: string; wallets: number }[];
  /** Game Night bookings (D10). */
  addBooking(b: Booking): void;
  getBooking(id: string): Booking | null;
  listBookings(): Booking[];
  updateBooking(
    id: string,
    u: {
      status?: BookingStatus;
      paidTx?: string | null;
      note?: string | null;
      chatId?: number | null;
      contact?: string | null;
      receiptHash?: string | null;
      ownerShareIdr?: number | null;
      payoutRef?: string | null;
    },
  ): void;
  /** Group notices already sent for a booking ("24h", "1h", "open"), F04-S06. */
  bookingNotices(id: string): string[];
  addBookingNotice(id: string, notice: string): void;
  /** Rupiah passes (D9, F14-D01): the amount and currency, which are not on chain; one row per receipt. */
  addFiatPass(p: FiatPass): void;
  fiatPassByReceipt(receiptHash: string): FiatPass | null;
  /** Client themes (F04-S05): saving an existing key with new text replaces it and raises its version. */
  saveClientTheme(t: Omit<ClientTheme, "version">): { rowId: number; version: number };
  getClientTheme(key: string): (ClientTheme & { rowId: number }) | null;
  listClientThemes(): (ClientTheme & { rowId: number })[];
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
  /** Two-letter country, for the payment rail only (F14-D04): guessed from the language or set with /negara. */
  country: string | null;
}

export interface StoredTx extends TxRecord {
  at: number;
}

/** One line of a wallet's history: "created", "gas" (a drip) or "forgotten". */
export interface WalletAuditEntry {
  event: string;
  detail: string | null;
  at: number;
}

export { storeKey, storeKeyring, type StoreKeyring } from "./store-keys.js";

/**
 * SQLite (node:sqlite) store. Player ids are plain; game secrets and finalize payloads are sealed
 * with AES-256-GCM (random 12-byte IV per write, auth tag checked on read).
 */
export class SqliteStore implements Store {
  private readonly ring: StoreKeyring | null;
  private readonly db: DatabaseSync;

  constructor(
    path: string,
    /** A Buffer is key version 0 (from the wallet secret); a keyring adds versioned keys (F01-D06). */
    key: Buffer | StoreKeyring | null = null,
  ) {
    this.ring = Buffer.isBuffer(key) ? { current: 0, keys: new Map([[0, key]]) } : key;
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
        at INTEGER NOT NULL,
        reason TEXT,
        value_wei TEXT
      );
      CREATE INDEX IF NOT EXISTS chain_txs_game ON chain_txs (game_id);
      CREATE INDEX IF NOT EXISTS chain_txs_at ON chain_txs (at);
      CREATE TABLE IF NOT EXISTS wallet_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        address TEXT NOT NULL,
        event TEXT NOT NULL,
        detail TEXT,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS wallet_audit_address ON wallet_audit (address);
      CREATE TABLE IF NOT EXISTS bookings (
        id TEXT PRIMARY KEY,
        client TEXT NOT NULL,
        contact TEXT,
        chat_id INTEGER,
        starts_at INTEGER NOT NULL,
        lang TEXT NOT NULL,
        theme TEXT,
        agent_id INTEGER,
        chain_agent_id INTEGER NOT NULL,
        token TEXT NOT NULL,
        price TEXT NOT NULL,
        decimals INTEGER NOT NULL,
        status TEXT NOT NULL,
        paid_tx TEXT,
        note TEXT,
        created_at INTEGER NOT NULL,
        notices TEXT NOT NULL DEFAULT '',
        fiat_currency TEXT,
        fiat_amount INTEGER,
        receipt_hash TEXT,
        owner_share_idr INTEGER,
        payout_ref TEXT
      );
      CREATE TABLE IF NOT EXISTS client_themes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL UNIQUE,
        client TEXT NOT NULL,
        version INTEGER NOT NULL,
        text TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fiat_passes (
        receipt_hash TEXT PRIMARY KEY,
        holder TEXT NOT NULL,
        pass_type INTEGER NOT NULL,
        periods INTEGER NOT NULL,
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL,
        tx TEXT NOT NULL,
        at INTEGER NOT NULL
      );
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
      CREATE TABLE IF NOT EXISTS night_watch (user_id INTEGER NOT NULL, day TEXT NOT NULL, correct INTEGER NOT NULL, PRIMARY KEY (user_id, day));
      CREATE TABLE IF NOT EXISTS practice_stats (day TEXT PRIMARY KEY, started INTEGER NOT NULL DEFAULT 0, finished INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS agent_games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id INTEGER NOT NULL,
        persona INTEGER NOT NULL,
        nox INTEGER NOT NULL,
        template INTEGER NOT NULL,
        rejected INTEGER NOT NULL,
        demoted INTEGER NOT NULL,
        at INTEGER NOT NULL,
        endpoint_calls INTEGER,
        endpoint_errors INTEGER
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
    const txCols = new Set((this.db.prepare("PRAGMA table_info(chain_txs)").all() as { name: string }[]).map((c) => c.name));
    if (!txCols.has("reason")) this.db.exec("ALTER TABLE chain_txs ADD COLUMN reason TEXT");
    if (!txCols.has("value_wei")) this.db.exec("ALTER TABLE chain_txs ADD COLUMN value_wei TEXT");
    if (!userCols.has("status")) this.db.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
    if (!userCols.has("last_seen")) this.db.exec("ALTER TABLE users ADD COLUMN last_seen INTEGER");
    if (!userCols.has("country")) this.db.exec("ALTER TABLE users ADD COLUMN country TEXT");
    // One wallet per account: derived wallets are unique by construction, the index makes it a rule.
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_address ON users (address) WHERE address IS NOT NULL");
    const fgCols = new Set((this.db.prepare("PRAGMA table_info(finished_games)").all() as { name: string }[]).map((c) => c.name));
    if (!fgCols.has("chat_id")) this.db.exec("ALTER TABLE finished_games ADD COLUMN chat_id INTEGER");
    const bkCols = new Set((this.db.prepare("PRAGMA table_info(bookings)").all() as { name: string }[]).map((c) => c.name));
    for (const [c, type] of [
      ["fiat_currency", "TEXT"],
      ["fiat_amount", "INTEGER"],
      ["receipt_hash", "TEXT"],
      ["owner_share_idr", "INTEGER"],
      ["payout_ref", "TEXT"],
    ])
      if (!bkCols.has(c!)) this.db.exec(`ALTER TABLE bookings ADD COLUMN ${c} ${type}`);
    const agCols = new Set((this.db.prepare("PRAGMA table_info(agent_games)").all() as { name: string }[]).map((c) => c.name));
    if (!agCols.has("endpoint_calls")) this.db.exec("ALTER TABLE agent_games ADD COLUMN endpoint_calls INTEGER");
    if (!agCols.has("endpoint_errors")) this.db.exec("ALTER TABLE agent_games ADD COLUMN endpoint_errors INTEGER");
    if (!fgCols.has("scenario")) this.db.exec("ALTER TABLE finished_games ADD COLUMN scenario TEXT");
    if (!fgCols.has("winner")) this.db.exec("ALTER TABLE finished_games ADD COLUMN winner TEXT");
    if (!fgCols.has("discussion")) this.db.exec("ALTER TABLE finished_games ADD COLUMN discussion TEXT");
    if (!fgCols.has("nudges")) this.db.exec("ALTER TABLE finished_games ADD COLUMN nudges INTEGER");
  }

  close() {
    this.db.close();
  }

  private seal(value: unknown): Buffer {
    if (!this.ring) throw new Error("store has no encryption key (NOX_WALLET_SECRET / NOX_STORE_KEYS) for game secrets");
    return sealBlob(this.ring, value);
  }

  private open<T>(blob: Uint8Array): T {
    if (!this.ring) throw new Error("store has no encryption key (NOX_WALLET_SECRET / NOX_STORE_KEYS) for game secrets");
    return openBlob<T>(this.ring, blob);
  }

  /** Every sealed blob, as [table, column, row id, blob]. */
  private sealedBlobs(): [string, string, string | number, Uint8Array][] {
    const out: [string, string, string | number, Uint8Array][] = [];
    for (const [table, key, cols] of [["games", "game_id", ["secret", "finalize"]], ["agents", "id", ["secret"]]] as const) {
      for (const col of cols) {
        for (const r of this.db.prepare(`SELECT ${key} AS k, ${col} AS b FROM ${table} WHERE ${col} IS NOT NULL`).all() as { k: string | number; b: Uint8Array }[]) out.push([table, col, r.k, r.b]);
      }
    }
    return out;
  }

  /** How many sealed blobs use each key version (key_version audit, F01-D06). */
  keyVersions(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const [, , , b] of this.sealedBlobs()) counts[blobVersion(b)] = (counts[blobVersion(b)] ?? 0) + 1;
    return counts;
  }

  /** Re-seal every blob not on the current key version; all or nothing. Returns how many changed. */
  reseal(): number {
    if (!this.ring) throw new Error("store has no encryption key");
    const todo = this.sealedBlobs().filter(([, , , b]) => blobVersion(b) !== this.ring!.current);
    this.db.exec("BEGIN");
    try {
      for (const [table, col, k, b] of todo) {
        this.db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${table === "games" ? "game_id" : "id"} = ?`).run(this.seal(this.open(b)), k);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return todo.length;
  }

  startedUsers() {
    return (this.db.prepare("SELECT telegram_id FROM users").all() as { telegram_id: number }[]).map((r) => r.telegram_id);
  }

  upsertUser(userId: number, u: { locale: Lang; address: string | null; country?: string | null }) {
    const now = Date.now();
    const before = this.db.prepare("SELECT address FROM users WHERE telegram_id = ?").get(userId) as { address: string | null } | undefined;
    const existed = before !== undefined;
    // Audit (F01-D05): the wallet is created when the account first gets its address. The row holds the
    // public address only: no Telegram id, and no key material (wallets are derived, ADR-002).
    if (u.address && !before?.address) this.audit(u.address, "created", "start");
    this.db
      .prepare(
        // A guessed country never overwrites one already there (the player's own choice included).
        `INSERT INTO users (telegram_id, started_at, locale, address, last_seen, country) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (telegram_id) DO UPDATE SET locale = excluded.locale, address = COALESCE(users.address, excluded.address), last_seen = excluded.last_seen,
           country = COALESCE(users.country, excluded.country)`,
      )
      .run(userId, now, u.locale, u.address, now, u.country ?? null);
    return { isNew: !existed };
  }

  setUserCountry(userId: number, country: string) {
    return Number(this.db.prepare("UPDATE users SET country = ? WHERE telegram_id = ?").run(country, userId).changes) > 0;
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
          country: (r.country as string | null) ?? null,
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

  private audit(address: string, event: string, detail: string | null) {
    this.db.prepare("INSERT INTO wallet_audit (address, event, detail, at) VALUES (?, ?, ?, ?)").run(address.toLowerCase(), event, detail, Date.now());
  }

  walletAudit(address: string): WalletAuditEntry[] {
    const a = address.toLowerCase();
    const own = (this.db.prepare("SELECT event, detail, at FROM wallet_audit WHERE address = ?").all(a) as { event: string; detail: string | null; at: number }[]).map(
      (r) => ({ event: r.event, detail: r.detail, at: Number(r.at) }),
    );
    // Gas drips live in the tx ledger (D14); show them in the same history.
    const drips = this.txs("step = 'gas drip' AND lower(to_addr) = ?", a).map((t) => ({
      event: "gas",
      detail: `${t.reason ?? "drip"} ${t.valueWei ?? "?"} wei, ${t.status}${t.hash ? ` ${t.hash}` : ""}`,
      at: t.at,
    }));
    // Within one millisecond keep the life-cycle order: created, then gas, then forgotten.
    const order = (e: string) => ["created", "gas", "forgotten"].indexOf(e);
    return [...own, ...drips].sort((x, y) => x.at - y.at || order(x.event) - order(y.event));
  }

  walletsCreated(fromMs: number, toMs: number): { day: string; wallets: number }[] {
    return (
      this.db
        .prepare("SELECT date(at / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM wallet_audit WHERE event = 'created' AND at >= ? AND at < ? GROUP BY day ORDER BY day")
        .all(fromMs, toMs) as { day: string; n: number }[]
    ).map((r) => ({ day: r.day, wallets: Number(r.n) }));
  }

  addBooking(b: Booking) {
    this.db
      .prepare(
        "INSERT INTO bookings (id, client, contact, chat_id, starts_at, lang, theme, agent_id, chain_agent_id, token, price, decimals, status, paid_tx, note, created_at, fiat_currency, fiat_amount, receipt_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        b.id,
        b.client,
        b.contact,
        b.chatId,
        b.startsAt,
        b.lang,
        b.theme,
        b.agentId,
        b.chainAgentId,
        b.token,
        b.price.toString(),
        b.decimals,
        b.status,
        b.paidTx,
        b.note,
        b.createdAt,
        b.fiat?.currency ?? null,
        b.fiat?.amount ?? null,
        b.receiptHash,
      );
  }

  private toBooking(r: Record<string, string | number | null>): Booking {
    return {
      id: r.id as Hex,
      client: r.client as string,
      contact: (r.contact as string | null) ?? null,
      chatId: r.chat_id == null ? null : Number(r.chat_id),
      startsAt: Number(r.starts_at),
      lang: r.lang as Lang,
      theme: (r.theme as string | null) ?? null,
      agentId: r.agent_id == null ? null : Number(r.agent_id),
      chainAgentId: Number(r.chain_agent_id),
      token: r.token as Hex,
      price: BigInt(r.price as string),
      decimals: Number(r.decimals),
      fiat: r.fiat_currency ? { currency: r.fiat_currency as "IDR", amount: Number(r.fiat_amount) } : null,
      receiptHash: (r.receipt_hash as Hex | null) ?? null,
      ownerShareIdr: r.owner_share_idr == null ? null : Number(r.owner_share_idr),
      payoutRef: (r.payout_ref as string | null) ?? null,
      status: r.status as BookingStatus,
      paidTx: (r.paid_tx as Hex | null) ?? null,
      note: (r.note as string | null) ?? null,
      createdAt: Number(r.created_at),
    };
  }

  getBooking(id: string): Booking | null {
    const r = this.db.prepare("SELECT * FROM bookings WHERE lower(id) = ?").get(id.toLowerCase()) as Record<string, string | number | null> | undefined;
    return r ? this.toBooking(r) : null;
  }

  listBookings(): Booking[] {
    return (this.db.prepare("SELECT * FROM bookings ORDER BY starts_at, id").all() as Record<string, string | number | null>[]).map((r) => this.toBooking(r));
  }

  updateBooking(
    id: string,
    u: {
      status?: BookingStatus;
      paidTx?: string | null;
      note?: string | null;
      chatId?: number | null;
      contact?: string | null;
      receiptHash?: string | null;
      ownerShareIdr?: number | null;
      payoutRef?: string | null;
    },
  ) {
    const cols: Record<string, keyof typeof u> = {
      status: "status",
      paid_tx: "paidTx",
      note: "note",
      chat_id: "chatId",
      contact: "contact",
      receipt_hash: "receiptHash",
      owner_share_idr: "ownerShareIdr",
      payout_ref: "payoutRef",
    };
    const set = Object.entries(cols).filter(([, k]) => u[k] !== undefined);
    if (!set.length) return;
    this.db
      .prepare(`UPDATE bookings SET ${set.map(([c]) => `${c} = ?`).join(", ")} WHERE lower(id) = ?`)
      .run(...set.map(([, k]) => u[k] as string | number | null), id.toLowerCase());
  }

  bookingNotices(id: string): string[] {
    const r = this.db.prepare("SELECT notices FROM bookings WHERE lower(id) = ?").get(id.toLowerCase()) as { notices: string } | undefined;
    return r?.notices ? r.notices.split(",") : [];
  }

  addBookingNotice(id: string, notice: string) {
    const all = [...new Set([...this.bookingNotices(id), notice])].join(",");
    this.db.prepare("UPDATE bookings SET notices = ? WHERE lower(id) = ?").run(all, id.toLowerCase());
  }

  addFiatPass(p: FiatPass) {
    this.db
      .prepare("INSERT INTO fiat_passes (receipt_hash, holder, pass_type, periods, amount, currency, tx, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(p.receiptHash.toLowerCase(), p.holder.toLowerCase(), p.passType, p.periods, p.amount, p.currency, p.tx, p.at);
  }

  fiatPassByReceipt(receiptHash: string): FiatPass | null {
    const r = this.db.prepare("SELECT * FROM fiat_passes WHERE receipt_hash = ?").get(receiptHash.toLowerCase()) as Record<string, string | number> | undefined;
    return r
      ? { receiptHash: r.receipt_hash as Hex, holder: r.holder as Hex, passType: Number(r.pass_type), periods: Number(r.periods), amount: Number(r.amount), currency: r.currency as "IDR", tx: r.tx as Hex, at: Number(r.at) }
      : null;
  }

  saveClientTheme(t: Omit<ClientTheme, "version">) {
    const old = this.getClientTheme(t.key);
    // Saving the same text again changes nothing, so it keeps its version.
    if (old && old.client === t.client && JSON.stringify(old.text) === JSON.stringify(t.text)) return { rowId: old.rowId, version: old.version };
    const version = old ? old.version + 1 : 1;
    if (old) this.db.prepare("UPDATE client_themes SET client = ?, version = ?, text = ?, updated_at = ? WHERE id = ?").run(t.client, version, JSON.stringify(t.text), Date.now(), old.rowId);
    else this.db.prepare("INSERT INTO client_themes (key, client, version, text, updated_at) VALUES (?, ?, ?, ?, ?)").run(t.key, t.client, version, JSON.stringify(t.text), Date.now());
    return { rowId: old?.rowId ?? this.getClientTheme(t.key)!.rowId, version };
  }

  private toClientTheme(r: Record<string, string | number>): ClientTheme & { rowId: number } {
    return { rowId: Number(r.id), key: r.key as string, client: r.client as string, version: Number(r.version), text: JSON.parse(r.text as string) as ClientTheme["text"] };
  }

  getClientTheme(key: string) {
    const r = this.db.prepare("SELECT * FROM client_themes WHERE key = ?").get(key) as Record<string, string | number> | undefined;
    return r ? this.toClientTheme(r) : null;
  }

  listClientThemes() {
    return (this.db.prepare("SELECT * FROM client_themes ORDER BY key").all() as Record<string, string | number>[]).map((r) => this.toClientTheme(r));
  }

  nightWatchAnswer(userId: number, day: string) {
    const r = this.db.prepare("SELECT correct FROM night_watch WHERE user_id = ? AND day = ?").get(userId, day) as { correct: number } | undefined;
    return r ? { correct: r.correct === 1 } : null;
  }

  recordNightWatch(userId: number, day: string, correct: boolean) {
    this.db.prepare("INSERT OR IGNORE INTO night_watch (user_id, day, correct) VALUES (?, ?, ?)").run(userId, day, correct ? 1 : 0);
  }

  nightWatchStreak(userId: number, day: string) {
    let streak = 0;
    for (let d = new Date(`${day}T00:00:00Z`); ; d = new Date(d.getTime() - 86_400_000)) {
      const r = this.nightWatchAnswer(userId, d.toISOString().slice(0, 10));
      if (!r?.correct) return streak;
      streak++;
    }
  }

  forgetUser(userId: number) {
    const u = this.db.prepare("SELECT address FROM users WHERE telegram_id = ?").get(userId) as { address: string | null } | undefined;
    // The wallet and its history stay on chain; the audit keeps that the account behind it was deleted.
    if (u?.address) this.audit(u.address, "forgotten", "account deleted with /forget");
    this.db.prepare("DELETE FROM users WHERE telegram_id = ?").run(userId);
    this.db.prepare("DELETE FROM night_watch WHERE user_id = ?").run(userId);
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

  recordFinishedGame(g: {
    agentId: number | null;
    players: number;
    hostId: number;
    chainGameId: Hex | null;
    chatId?: number;
    scenario?: string | null;
    winner?: string | null;
    discussion?: number[] | null;
    nudges?: number;
  }) {
    this.db
      .prepare("INSERT INTO finished_games (agent_id, players, host_id, chain_game_id, ended_at, chat_id, scenario, winner, discussion, nudges) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(g.agentId, g.players, g.hostId, g.chainGameId, Date.now(), g.chatId ?? null, g.scenario ?? null, g.winner ?? null, g.discussion ? JSON.stringify(g.discussion) : null, g.nudges ?? null);
  }

  discussionStats(fromMs: number, toMs: number): DiscussionStats {
    const rows = this.db.prepare("SELECT discussion, nudges FROM finished_games WHERE ended_at >= ? AND ended_at < ?").all(fromMs, toMs) as { discussion: string | null; nudges: number | null }[];
    const counted = rows.filter((r) => r.discussion !== null).map((r) => JSON.parse(r.discussion!) as number[]);
    const discussions = counted.reduce((n, d) => n + d.length, 0);
    const messages = counted.reduce((n, d) => n + d.reduce((a, b) => a + b, 0), 0);
    return {
      games: rows.length,
      countedGames: counted.length,
      discussions,
      messages,
      quietDiscussions: counted.reduce((n, d) => n + d.filter((m) => m === 0).length, 0),
      nudges: rows.reduce((n, r) => n + (r.nudges ?? 0), 0),
    };
  }

  scenarioGames(fromMs: number, toMs: number): ScenarioGame[] {
    return (
      this.db
        .prepare("SELECT scenario, players, chat_id, winner, ended_at FROM finished_games WHERE scenario IS NOT NULL AND ended_at >= ? AND ended_at < ? ORDER BY id")
        .all(fromMs, toMs) as { scenario: string; players: number; chat_id: number | null; winner: string | null; ended_at: number }[]
    ).map((r) => ({ scenario: r.scenario, players: Number(r.players), chatId: r.chat_id == null ? null : Number(r.chat_id), winner: r.winner, endedAt: Number(r.ended_at) }));
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
        "INSERT INTO chain_txs (game_id, step, from_addr, to_addr, hash, status, gas_used, fee_wei, block, attempts, error, at, reason, value_wei) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
        tx.reason ?? null,
        tx.valueWei?.toString() ?? null,
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
      reason: (r.reason as string | null) ?? null,
      valueWei: r.value_wei == null ? null : BigInt(r.value_wei),
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
      .prepare("INSERT INTO agent_games (agent_id, persona, nox, template, rejected, demoted, at, endpoint_calls, endpoint_errors) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(agentId, r.persona, r.nox, r.template, r.rejected, r.demoted ? 1 : 0, Date.now(), r.endpointCalls ?? null, r.endpointErrors ?? null);
  }

  agentGames(agentId: number, limit: number): AgentGame[] {
    return (
      this.db.prepare("SELECT * FROM agent_games WHERE agent_id = ? ORDER BY id DESC LIMIT ?").all(agentId, limit) as Record<string, number>[]
    ).map((r) => ({
      persona: r.persona!,
      nox: r.nox!,
      template: r.template!,
      rejected: r.rejected!,
      demoted: r.demoted === 1,
      at: r.at!,
      ...(r.endpoint_calls != null ? { endpointCalls: r.endpoint_calls, endpointErrors: r.endpoint_errors ?? 0 } : {}),
    }));
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
