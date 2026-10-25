import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Hex } from "viem";
import type { LedgerNightReveal, LedgerRoleReveal } from "./chain/ledger.js";
import type { Lang } from "./i18n.js";

export type GameStatus = "running" | "ended" | "finalized" | "cancelled";

/** Everything needed to reveal a game later. Secret until revealed: salts expose roles. */
export interface GameSecret {
  roles: LedgerRoleReveal[];
  nights: LedgerNightReveal[];
}

export interface FinalizePayload extends GameSecret {
  resultHash: Hex;
  winner: number;
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
  setStatus(gameId: Hex, status: "finalized" | "cancelled"): void;
  /** Games whose on-chain record is not settled yet (running or ended, not finalized/cancelled). */
  unsettledGames(): GameRecord[];
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

  setStatus(gameId: Hex, status: "finalized" | "cancelled") {
    this.db.prepare("UPDATE games SET status = ?, updated_at = ? WHERE game_id = ?").run(status, Date.now(), gameId);
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
}
