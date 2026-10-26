import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decodeEventLog, type Abi, type Address, type Hex } from "viem";

/**
 * Event indexer (F12-S01, D15). Polls eth_getLogs for every Nox contract in one call per chunk
 * (QIE caps a call at 10,000 blocks), stops `confirmations` blocks behind the head, and keeps a
 * checkpoint with the block hash so a reorg rewinds instead of leaving stale rows. Everything it
 * stores is public chain data and can be rebuilt by deleting the database.
 */
export const MAX_BLOCK_RANGE = 10_000n;

export interface IndexedContract {
  name: string;
  address: Address;
  abi: Abi;
}

export interface RawLog {
  address: Address;
  blockNumber: bigint | null;
  transactionHash: Hex | null;
  logIndex: number | null;
  topics: readonly Hex[];
  data: Hex;
}

/** The slice of a viem PublicClient the indexer needs (tests pass a fake chain). */
export interface IndexerClient {
  getBlockNumber(): Promise<bigint>;
  getBlock(args: { blockNumber: bigint }): Promise<{ hash: Hex | null; timestamp: bigint }>;
  getLogs(args: { address: Address[]; fromBlock: bigint; toBlock: bigint }): Promise<readonly RawLog[]>;
}

export interface IndexedEvent {
  contract: string;
  block: number;
  ts: number;
  txHash: Hex;
  logIndex: number;
  event: string;
  /** Decoded arguments; uint values become decimal strings. */
  args: Record<string, unknown>;
  gameId: Hex | null;
  /** The player or account the event is about (player, voter, credit receiver, buyer, owner). */
  account: Address | null;
}

const ACCOUNT_ARGS = ["player", "voter", "to", "buyer", "owner", "account", "payer"];
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

export class EventStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS chain_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contract TEXT NOT NULL,
        block INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        tx_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        event TEXT NOT NULL,
        args TEXT NOT NULL,
        game_id TEXT,
        account TEXT,
        UNIQUE (tx_hash, log_index)
      );
      CREATE INDEX IF NOT EXISTS chain_events_game ON chain_events (game_id);
      CREATE INDEX IF NOT EXISTS chain_events_event ON chain_events (event, account);
      CREATE INDEX IF NOT EXISTS chain_events_block ON chain_events (block);
      CREATE TABLE IF NOT EXISTS chain_checkpoints (key TEXT PRIMARY KEY, block INTEGER NOT NULL, block_hash TEXT);
    `);
  }

  close() {
    this.db.close();
  }

  checkpoint(key: string): { block: bigint; hash: Hex | null } | null {
    const r = this.db.prepare("SELECT block, block_hash FROM chain_checkpoints WHERE key = ?").get(key) as { block: number; block_hash: Hex | null } | undefined;
    return r ? { block: BigInt(r.block), hash: r.block_hash } : null;
  }

  /** Store one chunk and move the checkpoint in a single transaction (a crash never half-applies). */
  apply(key: string, events: IndexedEvent[], block: bigint, hash: Hex | null) {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO chain_events (contract, block, ts, tx_hash, log_index, event, args, game_id, account) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.db.exec("BEGIN");
    try {
      for (const e of events) insert.run(e.contract, e.block, e.ts, e.txHash, e.logIndex, e.event, json(e.args), e.gameId, e.account);
      this.setCheckpoint(key, block, hash);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Forget everything after `block` (reorg). */
  rewind(key: string, block: bigint, hash: Hex | null) {
    this.db.exec("BEGIN");
    this.db.prepare("DELETE FROM chain_events WHERE block > ?").run(block);
    this.setCheckpoint(key, block, hash);
    this.db.exec("COMMIT");
  }

  private setCheckpoint(key: string, block: bigint, hash: Hex | null) {
    this.db
      .prepare("INSERT INTO chain_checkpoints (key, block, block_hash) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET block = excluded.block, block_hash = excluded.block_hash")
      .run(key, block, hash);
  }

  private rows(sql: string, ...params: (string | number | null)[]) {
    return this.db.prepare(sql).all(...params) as Record<string, string | number | null>[];
  }

  eventsOfGame(gameId: Hex): IndexedEvent[] {
    return this.rows("SELECT * FROM chain_events WHERE game_id = ? ORDER BY block, log_index", gameId.toLowerCase()).map((r) => ({
      contract: r.contract as string,
      block: r.block as number,
      ts: r.ts as number,
      txHash: r.tx_hash as Hex,
      logIndex: r.log_index as number,
      event: r.event as string,
      args: JSON.parse(r.args as string) as Record<string, unknown>,
      gameId: r.game_id as Hex | null,
      account: r.account as Address | null,
    }));
  }

  /**
   * Public metrics (F12-D04), all counted from chain events:
   * players = distinct wallets that joined a game; playerTxs = joins, sealed night actions and votes
   * (each one a transaction the player signed); finishedGames = GameFinalized; credits = CreditsMinted.
   */
  stats() {
    const one = (sql: string) => Number(Object.values(this.rows(sql)[0] ?? { n: 0 })[0] ?? 0);
    return {
      players: one("SELECT COUNT(DISTINCT account) FROM chain_events WHERE event = 'PlayerJoined'"),
      playerTxs: one("SELECT COUNT(DISTINCT tx_hash) FROM chain_events WHERE event IN ('PlayerJoined', 'NightActionCommitted', 'VoteCast')"),
      finishedGames: one("SELECT COUNT(*) FROM chain_events WHERE event = 'GameFinalized'"),
      cancelledGames: one("SELECT COUNT(*) FROM chain_events WHERE event = 'GameCancelled'"),
      disputedGames: one("SELECT COUNT(*) FROM chain_events WHERE event = 'GameDisputed'"),
      credits: one("SELECT COALESCE(SUM(CAST(json_extract(args, '$.amount') AS INTEGER)), 0) FROM chain_events WHERE event = 'CreditsMinted'"),
      lastBlock: one("SELECT COALESCE(MAX(block), 0) FROM chain_events"),
    };
  }

  /**
   * Players ranked by credits. A win is a finalized game where the player's revealed role is on the
   * winning team (werewolf = 2 → wolves = 2, every other role → village = 1).
   */
  leaderboard(limit = 50): { account: Address; credits: number; games: number; wins: number }[] {
    return this.rows(
      `WITH credits AS (
         SELECT account, SUM(CAST(json_extract(args, '$.amount') AS INTEGER)) AS credits
         FROM chain_events WHERE event = 'CreditsMinted' GROUP BY account),
       finished AS (
         SELECT game_id, CAST(json_extract(args, '$.winner') AS INTEGER) AS winner FROM chain_events WHERE event = 'GameFinalized'),
       results AS (
         SELECT r.account,
                CASE WHEN (CASE WHEN CAST(json_extract(r.args, '$.role') AS INTEGER) = 2 THEN 2 ELSE 1 END) = f.winner THEN 1 ELSE 0 END AS won
         FROM chain_events r JOIN finished f ON f.game_id = r.game_id WHERE r.event = 'RoleRevealed')
       SELECT c.account, c.credits, COUNT(res.account) AS games, COALESCE(SUM(res.won), 0) AS wins
       FROM credits c LEFT JOIN results res ON res.account = c.account
       GROUP BY c.account ORDER BY c.credits DESC, wins DESC, c.account LIMIT ?`,
      limit,
    ).map((r) => ({ account: r.account as Address, credits: Number(r.credits), games: Number(r.games), wins: Number(r.wins) }));
  }

  /** Credits per account as the index sees them (for reconciliation against NoxCredits.balanceOf). */
  creditsOf(account: Address): bigint {
    const r = this.rows(
      "SELECT COALESCE(SUM(CAST(json_extract(args, '$.amount') AS INTEGER)), 0) AS n FROM chain_events WHERE event = 'CreditsMinted' AND account = ?",
      account.toLowerCase(),
    )[0];
    return BigInt(r?.n ?? 0);
  }

  /** Highest block the index has fully scanned (0 before the first sync). */
  indexedBlock(): number {
    return Number(this.rows("SELECT COALESCE(MAX(block), 0) AS n FROM chain_checkpoints")[0]?.n ?? 0);
  }

  /** Newest games first; `beforeBlock` pages back through older ones. */
  games(limit = 20, beforeBlock?: number): GameSummary[] {
    return this.summaries("c.block < ?", beforeBlock ?? Number.MAX_SAFE_INTEGER, limit);
  }

  game(gameId: Hex): GameSummary | null {
    return this.summaries("c.game_id = ?", gameId.toLowerCase(), 1)[0] ?? null;
  }

  private summaries(where: string, param: string | number, limit: number): GameSummary[] {
    return this.rows(
      `SELECT c.game_id, c.block, c.ts,
              (SELECT COUNT(*) FROM chain_events j WHERE j.game_id = c.game_id AND j.event = 'PlayerJoined') AS players,
              f.ts AS finalized_ts, CAST(json_extract(f.args, '$.winner') AS INTEGER) AS winner,
              x.ts AS cancelled_ts, json_extract(x.args, '$.reason') AS reason,
              d.ts AS disputed_ts, CAST(json_extract(d.args, '$.reason') AS INTEGER) AS dispute_code, json_extract(d.args, '$.detail') AS dispute_detail
       FROM chain_events c
       LEFT JOIN chain_events f ON f.game_id = c.game_id AND f.event = 'GameFinalized'
       LEFT JOIN chain_events x ON x.game_id = c.game_id AND x.event = 'GameCancelled'
       LEFT JOIN chain_events d ON d.game_id = c.game_id AND d.event = 'GameDisputed'
       WHERE c.event = 'GameCreated' AND ${where}
       ORDER BY c.block DESC, c.log_index DESC LIMIT ?`,
      param,
      limit,
    ).map(toGameSummary);
  }

  /** One player's history, all from public events: joins, revealed roles, results, credits, signed txs. */
  player(account: Address) {
    const a = account.toLowerCase();
    const games = this.rows(
      `SELECT j.game_id, j.block, j.ts, CAST(json_extract(r.args, '$.role') AS INTEGER) AS role,
              CAST(json_extract(f.args, '$.winner') AS INTEGER) AS winner,
              (SELECT COUNT(*) FROM chain_events x WHERE x.game_id = j.game_id AND x.event = 'GameCancelled') AS cancelled,
              (SELECT COUNT(*) FROM chain_events d WHERE d.game_id = j.game_id AND d.event = 'GameDisputed') AS disputed
       FROM chain_events j
       LEFT JOIN chain_events r ON r.game_id = j.game_id AND r.event = 'RoleRevealed' AND r.account = j.account
       LEFT JOIN chain_events f ON f.game_id = j.game_id AND f.event = 'GameFinalized'
       WHERE j.event = 'PlayerJoined' AND j.account = ?
       ORDER BY j.block DESC`,
      a,
    ).map((r) => {
      const role = r.role === null ? null : Number(r.role);
      const winner = r.winner === null ? null : Number(r.winner);
      return {
        gameId: r.game_id as Hex,
        block: Number(r.block),
        ts: Number(r.ts),
        role: role === null ? null : ROLE_NAMES[role] ?? null,
        status: winner !== null ? "finalized" : Number(r.cancelled) ? "cancelled" : Number(r.disputed) ? "disputed" : "running",
        won: role !== null && winner !== null ? (role === 2 ? 2 : 1) === winner : null,
      };
    });
    const signed = this.rows(
      "SELECT COUNT(DISTINCT tx_hash) AS n FROM chain_events WHERE account = ? AND event IN ('PlayerJoined', 'NightActionCommitted', 'VoteCast')",
      a,
    )[0];
    return {
      account: a as Address,
      credits: Number(this.creditsOf(account)),
      games: games.length,
      finished: games.filter((g) => g.status === "finalized").length,
      wins: games.filter((g) => g.won).length,
      signedTxs: Number(signed?.n ?? 0),
      history: games,
    };
  }

  /** Distinct player wallets that signed a game transaction, per UTC day, for days since `fromTs`. */
  dailySigners(fromTs: number): { day: string; players: number }[] {
    return this.rows(
      `SELECT date(ts, 'unixepoch') AS day, COUNT(DISTINCT account) AS players FROM chain_events
       WHERE event IN ('PlayerJoined', 'NightActionCommitted', 'VoteCast') AND ts >= ?
       GROUP BY day ORDER BY day`,
      fromTs,
    ).map((r) => ({ day: r.day as string, players: Number(r.players) }));
  }
}

const ROLE_NAMES: Record<number, string> = { 1: "villager", 2: "werewolf", 3: "seer", 4: "doctor" };

export interface GameSummary {
  gameId: Hex;
  block: number;
  ts: number;
  players: number;
  status: "running" | "finalized" | "cancelled" | "disputed";
  /** "village" | "wolves" once finalized. */
  winner: "village" | "wolves" | null;
  endedTs: number | null;
  cancelReason: string | null;
  /** Set when the game ended as Disputed (NoxGame reason 1 = reveal mismatch, 2 = reveal timeout). */
  dispute: { reason: "reveal_mismatch" | "reveal_timeout"; detail: string } | null;
}

function toGameSummary(r: Record<string, string | number | null>): GameSummary {
  const winner = r.winner === null ? null : Number(r.winner) === 2 ? "wolves" : "village";
  const ended = r.finalized_ts ?? r.cancelled_ts ?? r.disputed_ts;
  return {
    gameId: r.game_id as Hex,
    block: Number(r.block),
    ts: Number(r.ts),
    players: Number(r.players),
    status: r.finalized_ts !== null ? "finalized" : r.cancelled_ts !== null ? "cancelled" : r.disputed_ts !== null ? "disputed" : "running",
    winner,
    endedTs: ended === null || ended === undefined ? null : Number(ended),
    cancelReason: (r.reason as string | null) ?? null,
    dispute: r.disputed_ts !== null ? { reason: Number(r.dispute_code) === 2 ? "reveal_timeout" : "reveal_mismatch", detail: (r.dispute_detail as string | null) ?? "" } : null,
  };
}

export interface IndexerOptions {
  client: IndexerClient;
  store: EventStore;
  contracts: IndexedContract[];
  /** First block to scan (the deploy block). */
  fromBlock: bigint;
  /** Blocks to stay behind the head. QIE has fast finality, so a small number is enough. */
  confirmations?: bigint;
  /** Blocks to drop when the checkpoint's block hash changed (reorg). */
  reorgDepth?: bigint;
  /** Blocks per getLogs call, at most MAX_BLOCK_RANGE. */
  chunk?: bigint;
  log?: (entry: Record<string, unknown>) => void;
}

export class EventIndexer {
  private readonly key: string;
  private readonly byAddress: Map<string, IndexedContract>;
  private readonly confirmations: bigint;
  private readonly reorgDepth: bigint;
  private readonly chunk: bigint;

  constructor(private readonly o: IndexerOptions) {
    if (!o.contracts.length) throw new Error("indexer needs at least one contract");
    this.byAddress = new Map(o.contracts.map((c) => [c.address.toLowerCase(), c]));
    // A different contract set gets its own checkpoint, so adding a contract rescans from the start.
    this.key = [...this.byAddress.keys()].sort().join(",");
    this.confirmations = o.confirmations ?? 2n;
    this.reorgDepth = o.reorgDepth ?? 64n;
    this.chunk = o.chunk ?? MAX_BLOCK_RANGE;
    if (this.chunk < 1n || this.chunk > MAX_BLOCK_RANGE) throw new Error(`chunk must be 1..${MAX_BLOCK_RANGE}`);
  }

  /** Index up to the confirmed head. Returns how many events were stored and the new checkpoint. */
  async syncOnce(): Promise<{ events: number; block: bigint }> {
    const { client, store } = this.o;
    const head = await client.getBlockNumber();
    const safe = head - this.confirmations;
    let cp = store.checkpoint(this.key) ?? { block: this.o.fromBlock - 1n, hash: null };

    if (cp.hash && cp.block <= safe) {
      const now = (await client.getBlock({ blockNumber: cp.block })).hash;
      if (now !== cp.hash) {
        const back = cp.block - this.reorgDepth > this.o.fromBlock - 1n ? cp.block - this.reorgDepth : this.o.fromBlock - 1n;
        const hash = back >= this.o.fromBlock ? (await client.getBlock({ blockNumber: back })).hash : null;
        store.rewind(this.key, back, hash);
        this.o.log?.({ event: "index_reorg", at: cp.block.toString(), rewoundTo: back.toString() });
        cp = { block: back, hash };
      }
    }

    let stored = 0;
    const times = new Map<bigint, number>();
    const timeOf = async (b: bigint) => {
      if (!times.has(b)) times.set(b, Number((await client.getBlock({ blockNumber: b })).timestamp));
      return times.get(b)!;
    };
    for (let from = cp.block + 1n; from <= safe; ) {
      const to = from + this.chunk - 1n < safe ? from + this.chunk - 1n : safe;
      const logs = await client.getLogs({ address: [...this.byAddress.values()].map((c) => c.address), fromBlock: from, toBlock: to });
      const events: IndexedEvent[] = [];
      for (const l of logs) {
        const e = this.decode(l);
        if (e) events.push({ ...e, ts: await timeOf(BigInt(e.block)) });
      }
      const hash = (await client.getBlock({ blockNumber: to })).hash;
      store.apply(this.key, events, to, hash);
      stored += events.length;
      if (events.length) this.o.log?.({ event: "index_chunk", from: from.toString(), to: to.toString(), events: events.length });
      cp = { block: to, hash };
      from = to + 1n;
    }
    return { events: stored, block: cp.block };
  }

  private decode(l: RawLog): Omit<IndexedEvent, "ts"> | null {
    const c = this.byAddress.get(l.address.toLowerCase());
    if (!c || l.blockNumber === null || l.transactionHash === null || l.logIndex === null) return null;
    try {
      const d = decodeEventLog({ abi: c.abi, topics: l.topics as [Hex, ...Hex[]], data: l.data, strict: true }) as unknown as { eventName: string; args?: Record<string, unknown> };
      const args = d.args ?? {};
      const gameId = typeof args.gameId === "string" ? (args.gameId.toLowerCase() as Hex) : null;
      const accountArg = ACCOUNT_ARGS.find((k) => typeof args[k] === "string");
      return {
        contract: c.name,
        block: Number(l.blockNumber),
        txHash: l.transactionHash,
        logIndex: l.logIndex,
        event: d.eventName,
        args: JSON.parse(json(args)) as Record<string, unknown>,
        gameId,
        account: accountArg ? ((args[accountArg] as string).toLowerCase() as Address) : null,
      };
    } catch {
      this.o.log?.({ event: "index_unknown_log", contract: c.name, tx: l.transactionHash });
      return null;
    }
  }
}
