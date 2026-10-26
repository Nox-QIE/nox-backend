import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decodeEventLog, type Abi, type Address, type Hex } from "viem";
import type { GameNightPayment } from "../bookings.js";
import type { ReportGame } from "../report.js";

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
      CREATE TABLE IF NOT EXISTS player_stats (
        account TEXT PRIMARY KEY,
        credits INTEGER NOT NULL,
        games INTEGER NOT NULL,
        wins INTEGER NOT NULL,
        streak_days INTEGER NOT NULL,
        best_streak INTEGER NOT NULL,
        last_day TEXT,
        rank INTEGER NOT NULL,
        badges TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS payment_reconciliations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        block INTEGER NOT NULL,
        checked INTEGER NOT NULL,
        mismatches TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS used_logins (nonce TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reconciliations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        block INTEGER NOT NULL,
        checked INTEGER NOT NULL,
        mismatches TEXT NOT NULL,
        orphan_mints INTEGER NOT NULL
      );
    `);
    this.migrate();
  }

  close() {
    this.db.close();
  }

  /** Index files from before badges lack the column; adding it keeps them usable. */
  private migrate() {
    const cols = new Set((this.db.prepare("PRAGMA table_info(player_stats)").all() as { name: string }[]).map((c) => c.name));
    if (!cols.has("badges")) this.db.exec("ALTER TABLE player_stats ADD COLUMN badges TEXT NOT NULL DEFAULT '{}'");
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
   * Each player's finalized games, from public events: the day (UTC), whether they won (their revealed
   * role's team is the recorded winner: werewolf = 2 → wolves = 2, every other role → village = 1)
   * and the credits minted to them in that game.
   */
  private playerGames(fromTs = 0, toTs = Number.MAX_SAFE_INTEGER) {
    return this.rows(
      `SELECT r.account, r.game_id, f.ts,
              CASE WHEN (CASE WHEN CAST(json_extract(r.args, '$.role') AS INTEGER) = 2 THEN 2 ELSE 1 END)
                        = CAST(json_extract(f.args, '$.winner') AS INTEGER) THEN 1 ELSE 0 END AS won,
              COALESCE((SELECT SUM(CAST(json_extract(m.args, '$.amount') AS INTEGER)) FROM chain_events m
                        WHERE m.event = 'CreditsMinted' AND m.game_id = r.game_id AND m.account = r.account), 0) AS credits
       FROM chain_events r JOIN chain_events f ON f.game_id = r.game_id AND f.event = 'GameFinalized'
       WHERE r.event = 'RoleRevealed' AND f.ts >= ? AND f.ts < ?
       ORDER BY f.ts`,
      fromTs,
      toTs,
    ).map((r) => ({ account: r.account as Address, gameId: r.game_id as Hex, ts: Number(r.ts), won: Number(r.won) === 1, credits: Number(r.credits) }));
  }

  /**
   * Rebuild the D7 mirror (player_stats) from the events: credits (all CreditsMinted), finalized games,
   * wins, daily streak and rank. Streaks follow NoxGame (consecutive UTC days with a finalized game);
   * the current streak is 0 once a whole day has passed without one.
   */
  refreshPlayerStats(nowTs = Math.floor(Date.now() / 1000)) {
    const dayOf = (ts: number) => Math.floor(ts / 86_400);
    const today = dayOf(nowTs);
    const stats = new Map<string, { games: number; wins: number; days: Set<number> }>();
    for (const g of this.playerGames()) {
      const p = stats.get(g.account) ?? { games: 0, wins: 0, days: new Set<number>() };
      p.games++;
      if (g.won) p.wins++;
      p.days.add(dayOf(g.ts));
      stats.set(g.account, p);
    }
    const credits = new Map(
      this.rows("SELECT account, SUM(CAST(json_extract(args, '$.amount') AS INTEGER)) AS n FROM chain_events WHERE event = 'CreditsMinted' GROUP BY account").map((r) => [
        r.account as string,
        Number(r.n),
      ]),
    );
    const awarded = this.rows("SELECT DISTINCT account FROM chain_events WHERE event = 'BadgeAwarded'").map((r) => r.account as string);
    const rows = [...new Set([...stats.keys(), ...credits.keys(), ...awarded])].map((account) => {
      const p = stats.get(account) ?? { games: 0, wins: 0, days: new Set<number>() };
      const days = [...p.days].sort((a, b) => a - b);
      let best = 0;
      let run = 0;
      for (let i = 0; i < days.length; i++) {
        run = i > 0 && days[i] === days[i - 1]! + 1 ? run + 1 : 1;
        best = Math.max(best, run);
      }
      const last = days.at(-1);
      const current = last !== undefined && last >= today - 1 ? run : 0;
      return { account, credits: credits.get(account) ?? 0, games: p.games, wins: p.wins, current, best, lastDay: last === undefined ? null : new Date(last * 86_400_000).toISOString().slice(0, 10) };
    });
    rows.sort((a, b) => b.credits - a.credits || b.wins - a.wins || a.account.localeCompare(b.account));
    // Badges (NoxBadges): names from the latest BadgeDefined, counts from BadgeAwarded.
    const names = new Map<string, string>();
    for (const r of this.rows("SELECT args FROM chain_events WHERE event = 'BadgeDefined' ORDER BY block, log_index")) {
      const a = JSON.parse(r.args as string) as { badgeId: string; name: string };
      names.set(a.badgeId.toLowerCase(), a.name);
    }
    const badges = new Map<string, Record<string, number>>();
    for (const r of this.rows("SELECT account, args FROM chain_events WHERE event = 'BadgeAwarded'")) {
      const a = JSON.parse(r.args as string) as { badgeId: string };
      const name = names.get(a.badgeId.toLowerCase()) ?? a.badgeId;
      const mine = badges.get(r.account as string) ?? {};
      mine[name] = (mine[name] ?? 0) + 1;
      badges.set(r.account as string, mine);
    }
    const insert = this.db.prepare(
      "INSERT INTO player_stats (account, credits, games, wins, streak_days, best_streak, last_day, rank, badges) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM player_stats");
      rows.forEach((r, i) => insert.run(r.account, r.credits, r.games, r.wins, r.current, r.best, r.lastDay, i + 1, JSON.stringify(badges.get(r.account) ?? {})));
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return rows.length;
  }

  /** One player's D7 row, or null before their first credits. */
  playerStats(account: Address): PlayerStats | null {
    const r = this.rows("SELECT * FROM player_stats WHERE account = ?", account.toLowerCase())[0];
    return r ? toPlayerStats(r) : null;
  }

  /**
   * Players ranked by credits (ties: more wins first). Without a season it reads the D7 mirror; with a
   * season ("2026-10", a UTC month) it counts only games finalized in that month (F12-S05).
   */
  leaderboard(limit = 50, season?: string): PlayerStats[] {
    if (!season) return this.rows("SELECT * FROM player_stats ORDER BY rank LIMIT ?", limit).map(toPlayerStats);
    const m = /^(\d{4})-(\d{2})$/.exec(season);
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new Error("season must look like 2026-10");
    const from = Date.UTC(Number(m[1]), Number(m[2]) - 1, 1) / 1000;
    const to = Date.UTC(Number(m[1]), Number(m[2]), 1) / 1000;
    const by = new Map<string, PlayerStats>();
    for (const g of this.playerGames(from, to)) {
      const p = by.get(g.account) ?? { account: g.account, credits: 0, games: 0, wins: 0, streakDays: 0, bestStreak: 0, lastDay: null, rank: 0, badges: {} };
      p.credits += g.credits;
      p.games++;
      if (g.won) p.wins++;
      by.set(g.account, p);
    }
    return [...by.values()]
      .sort((a, b) => b.credits - a.credits || b.wins - a.wins || a.account.localeCompare(b.account))
      .slice(0, limit)
      .map((p, i) => ({ ...p, rank: i + 1 }));
  }

  /** Credits minted for a game that never finalized (only NoxGame's finalize should ever mint). */
  orphanMints(): { account: Address; gameId: Hex | null; amount: number; txHash: Hex }[] {
    return this.rows(
      `SELECT m.account, m.game_id, CAST(json_extract(m.args, '$.amount') AS INTEGER) AS amount, m.tx_hash FROM chain_events m
       WHERE m.event = 'CreditsMinted'
         AND NOT EXISTS (SELECT 1 FROM chain_events f WHERE f.event = 'GameFinalized' AND f.game_id = m.game_id)`,
    ).map((r) => ({ account: r.account as Address, gameId: r.game_id as Hex | null, amount: Number(r.amount), txHash: r.tx_hash as Hex }));
  }

  /**
   * Agent revenue and treasury ledger from NoxPayments events (F18-D05). Amounts are summed as bigints:
   * 18-decimal token amounts overflow SQLite's 64-bit integers.
   */
  /**
   * D16 as public on chain (F18-D01): every NoxAgentRegistry agent replayed from its events, joined with
   * its revenue from NoxPayments. Persona text and endpoint secrets stay in the bot store; the chain has
   * the persona's hash. A share set equal to the default at that moment is read as "follows the
   * default", since clearAgentShare emits the same event; a later default change then applies to it.
   */
  agents(): AgentOnChain[] {
    const MODES = ["none", "hosted", "endpoint"] as const;
    const STATUSES = ["none", "active", "suspended", "revoked"] as const;
    let defaultBps = 3000; // NoxAgentRegistry's initial default
    const byId = new Map<number, AgentOnChain>();
    const rows = this.rows("SELECT event, ts, args FROM chain_events WHERE contract = 'NoxAgentRegistry' ORDER BY block, log_index");
    for (const r of rows) {
      const a = JSON.parse(r.args as string) as Record<string, string | number>;
      const id = Number(a.agentId ?? 0);
      const agent = byId.get(id);
      switch (r.event) {
        case "AgentRegistered":
          byId.set(id, {
            agentId: id,
            owner: String(a.owner).toLowerCase() as Address,
            mode: MODES[Number(a.mode)] ?? "none",
            status: "active",
            metadataHash: a.metadataHash as Hex,
            shareBps: defaultBps,
            customShare: false,
            registeredAt: Number(r.ts),
            revenue: [],
          });
          break;
        case "AgentStatusChanged":
          if (agent) agent.status = STATUSES[Number(a.status)] ?? agent.status;
          break;
        case "AgentMetadataUpdated":
          if (agent) agent.metadataHash = a.metadataHash as Hex;
          break;
        case "AgentOwnerChanged":
          if (agent) agent.owner = String(a.owner).toLowerCase() as Address;
          break;
        case "ShareChanged":
          if (id === 0) {
            defaultBps = Number(a.shareBps);
            for (const x of byId.values()) if (!x.customShare) x.shareBps = defaultBps;
          } else if (agent) {
            agent.shareBps = Number(a.shareBps);
            agent.customShare = agent.shareBps !== defaultBps;
          }
          break;
      }
    }
    for (const rev of this.paymentLedger().agents) {
      byId.get(rev.agentId)?.revenue.push({ token: rev.token, gameNights: rev.gameNights, pool: rev.pool, total: rev.total });
    }
    return [...byId.values()].sort((x, y) => x.agentId - y.agentId);
  }

  paymentLedger(): PaymentLedger {
    const rows = this.rows(
      `SELECT event, tx_hash, args FROM chain_events WHERE contract = 'NoxPayments'
         AND event IN ('AgentCredited', 'Withdrawn', 'GameNightPaid', 'AgentPoolAllocated', 'PassPurchased', 'TreasuryWithdrawn')
       ORDER BY block, log_index`,
    ).map((r) => ({ event: r.event as string, tx: r.tx_hash as string, a: JSON.parse(r.args as string) as Record<string, string | number> }));
    const big = (v: unknown) => BigInt(String(v ?? 0));
    const addr = (v: unknown) => String(v).toLowerCase() as Address;
    const poolTxs = new Set(rows.filter((r) => r.event === "AgentPoolAllocated").map((r) => r.tx));
    const owners = new Map<string, OwnerLedger>();
    const agents = new Map<string, AgentRevenue>();
    const treasury = new Map<string, TreasuryLedger>();
    const ownerRow = (owner: Address, token: Address) => {
      const k = `${owner}|${token}`;
      if (!owners.has(k)) owners.set(k, { owner, token, credited: 0n, withdrawn: 0n, owed: 0n });
      return owners.get(k)!;
    };
    const treasuryRow = (token: Address) => {
      if (!treasury.has(token)) treasury.set(token, { token, passes: 0n, gameNights: 0n, pool: 0n, withdrawn: 0n, balance: 0n });
      return treasury.get(token)!;
    };
    for (const { event, tx, a } of rows) {
      if (event === "AgentCredited") {
        const owner = addr(a.owner);
        const token = addr(a.token);
        const amount = big(a.amount);
        ownerRow(owner, token).credited += amount;
        const k = `${a.agentId}|${owner}|${token}`;
        const ag = agents.get(k) ?? { agentId: Number(a.agentId), owner, token, gameNights: 0n, pool: 0n, total: 0n };
        if (poolTxs.has(tx)) ag.pool += amount;
        else ag.gameNights += amount;
        ag.total += amount;
        agents.set(k, ag);
      } else if (event === "Withdrawn") ownerRow(addr(a.account), addr(a.token)).withdrawn += big(a.amount);
      else if (event === "PassPurchased") treasuryRow(addr(a.token)).passes += big(a.amount);
      else if (event === "GameNightPaid") treasuryRow(addr(a.token)).gameNights += big(a.amount) - big(a.ownerShare);
      else if (event === "AgentPoolAllocated") treasuryRow(addr(a.token)).pool += big(a.total);
      else if (event === "TreasuryWithdrawn") treasuryRow(addr(a.token)).withdrawn += big(a.amount);
    }
    for (const o of owners.values()) o.owed = o.credited - o.withdrawn;
    for (const t of treasury.values()) t.balance = t.passes + t.gameNights - t.pool - t.withdrawn;
    return { owners: [...owners.values()], agents: [...agents.values()].sort((x, y) => x.agentId - y.agentId), treasury: [...treasury.values()] };
  }

  recordPaymentReconciliation(r: PaymentReconciliation) {
    this.db.prepare("INSERT INTO payment_reconciliations (at, block, checked, mismatches) VALUES (?, ?, ?, ?)").run(r.at, r.block, r.checked, json(r.mismatches));
  }

  lastPaymentReconciliation(): PaymentReconciliation | null {
    const r = this.rows("SELECT * FROM payment_reconciliations ORDER BY id DESC LIMIT 1")[0];
    return r ? { at: Number(r.at), block: Number(r.block), checked: Number(r.checked), mismatches: JSON.parse(r.mismatches as string) as PaymentReconciliation["mismatches"] } : null;
  }

  recordReconciliation(r: Reconciliation) {
    this.db
      .prepare("INSERT INTO reconciliations (at, block, checked, mismatches, orphan_mints) VALUES (?, ?, ?, ?, ?)")
      .run(r.at, r.block, r.checked, json(r.mismatches), r.orphanMints);
  }

  lastReconciliation(): Reconciliation | null {
    const r = this.rows("SELECT * FROM reconciliations ORDER BY id DESC LIMIT 1")[0];
    return r
      ? { at: Number(r.at), block: Number(r.block), checked: Number(r.checked), mismatches: JSON.parse(r.mismatches as string) as Reconciliation["mismatches"], orphanMints: Number(r.orphan_mints) }
      : null;
  }

  /** Credits per account as the index sees them (for reconciliation against NoxCredits.balanceOf). */
  creditsOf(account: Address): bigint {
    const r = this.rows(
      "SELECT COALESCE(SUM(CAST(json_extract(args, '$.amount') AS INTEGER)), 0) AS n FROM chain_events WHERE event = 'CreditsMinted' AND account = ?",
      account.toLowerCase(),
    )[0];
    return BigInt(r?.n ?? 0);
  }

  /** Events emitted by one transaction (for reconciling the bot's tx ledger with the chain). */
  eventsOfTx(hash: Hex): string[] {
    return this.rows("SELECT event FROM chain_events WHERE tx_hash = ? ORDER BY log_index", hash.toLowerCase()).map((r) => r.event as string);
  }

  /** Highest block the index has fully scanned (0 before the first sync). */
  /** Spend a web login token's nonce (NOX-APP-14): true the first time, false ever after. */
  useLoginNonce(nonce: string, expires: number, nowS: number): boolean {
    this.db.prepare("DELETE FROM used_logins WHERE expires <= ?").run(nowS);
    return Number(this.db.prepare("INSERT OR IGNORE INTO used_logins (nonce, expires) VALUES (?, ?)").run(nonce, expires).changes) > 0;
  }

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

  /** Players (wallets), timing and size of one indexed game, for reports. */
  gameDetail(gameId: Hex): { players: Address[]; createdTs: number; endedTs: number | null; status: GameSummary["status"]; rounds: number; credits: number } | null {
    const g = this.game(gameId);
    if (!g) return null;
    const id = gameId.toLowerCase();
    const players = this.rows("SELECT DISTINCT account FROM chain_events WHERE game_id = ? AND event = 'PlayerJoined'", id).map((r) => r.account as Address);
    const rounds = Number(this.rows("SELECT COUNT(*) AS n FROM chain_events WHERE game_id = ? AND event = 'RoundRecorded'", id)[0]?.n ?? 0);
    const credits = Number(
      this.rows("SELECT COALESCE(SUM(CAST(json_extract(args, '$.amount') AS INTEGER)), 0) AS n FROM chain_events WHERE game_id = ? AND event = 'CreditsMinted'", id)[0]?.n ?? 0,
    );
    return { players, createdTs: g.ts, endedTs: g.endedTs, status: g.status, rounds, credits };
  }

  /**
   * Every game finalized in [fromTs, toTs), in the shape the engagement report counts, so the public
   * engagement numbers and a client's Game Night report share one definition (F12-D04).
   */
  finalizedGames(fromTs: number, toTs: number): ReportGame[] {
    return this.rows("SELECT game_id FROM chain_events WHERE event = 'GameFinalized' AND ts >= ? AND ts < ? ORDER BY ts, block, log_index", fromTs, toTs).flatMap((r) => {
      const d = this.gameDetail(r.game_id as Hex);
      return d && d.endedTs !== null ? [{ gameId: r.game_id as Hex, players: d.players, createdTs: d.createdTs, endedTs: d.endedTs, rounds: d.rounds, credits: d.credits }] : [];
    });
  }

  /** One player's history, all from public events: joins, revealed roles, results, credits, signed txs. */
  player(account: Address) {
    const a = account.toLowerCase();
    const games = this.rows(
      `SELECT j.game_id, j.block, j.ts, CAST(json_extract(r.args, '$.role') AS INTEGER) AS role,
              CAST(json_extract(f.args, '$.winner') AS INTEGER) AS winner,
              (SELECT COUNT(*) FROM chain_events x WHERE x.game_id = j.game_id AND x.event = 'GameCancelled') AS cancelled,
              (SELECT COUNT(*) FROM chain_events d WHERE d.game_id = j.game_id AND d.event = 'GameDisputed') AS disputed,
              g.args AS reward,
              (SELECT SUM(CAST(json_extract(b.args, '$.amount') AS INTEGER)) FROM chain_events b
                WHERE b.game_id = j.game_id AND b.event = 'ScamShieldBonus' AND b.account = j.account) AS bonus
       FROM chain_events j
       LEFT JOIN chain_events r ON r.game_id = j.game_id AND r.event = 'RoleRevealed' AND r.account = j.account
       LEFT JOIN chain_events f ON f.game_id = j.game_id AND f.event = 'GameFinalized'
       LEFT JOIN chain_events g ON g.game_id = j.game_id AND g.event = 'RewardGranted' AND g.account = j.account
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
        /** Credits breakdown from RewardGranted (ADR-005); null for games before the formula or not finalized. */
        reward: r.reward ? rewardOf(JSON.parse(r.reward as string) as Record<string, unknown>, Number(r.bonus ?? 0)) : null,
      };
    });
    const signed = this.rows(
      "SELECT COUNT(DISTINCT tx_hash) AS n FROM chain_events WHERE account = ? AND event IN ('PlayerJoined', 'NightActionCommitted', 'VoteCast')",
      a,
    )[0];
    return {
      account: a as Address,
      stats: this.playerStats(account),
      credits: Number(this.creditsOf(account)),
      games: games.length,
      finished: games.filter((g) => g.status === "finalized").length,
      wins: games.filter((g) => g.won).length,
      signedTxs: Number(signed?.n ?? 0),
      history: games,
    };
  }

  /** The on-chain payment of a booked Game Night (GameNightPaid), or null before it is paid (F04-S04). */
  gameNightPayment(bookingId: Hex): GameNightPayment | null {
    const r = this.rows("SELECT tx_hash, block, ts, args FROM chain_events WHERE event = 'GameNightPaid' AND lower(json_extract(args, '$.bookingId')) = ?", bookingId.toLowerCase())[0];
    if (!r) return null;
    const a = JSON.parse(r.args as string) as Record<string, string>;
    return {
      payer: a.payer as Address,
      agentId: Number(a.agentId),
      token: a.token as Address,
      amount: BigInt(a.amount!),
      ownerShare: BigInt(a.ownerShare!),
      tx: r.tx_hash as Hex,
      block: Number(r.block),
      ts: Number(r.ts),
    };
  }

  /**
   * D9 pass purchases (F14-D01), all from public events: bought on chain (PassPurchased; the payer from
   * PassPaidBy in the same transaction when someone paid for another wallet) or paid in rupiah and
   * recorded by the operator (FiatPassRecorded, with the hash of its receipt). `expiresAt` is the
   * holder's expiry right after that purchase; passes stack, so the latest row is the one in force.
   */
  passPurchases(holder?: Address, nowTs = Math.floor(Date.now() / 1000)): PassPurchase[] {
    const rows = holder
      ? this.rows("SELECT * FROM chain_events WHERE event IN ('PassPurchased', 'FiatPassRecorded') AND account = ? ORDER BY block, log_index", holder.toLowerCase())
      : this.rows("SELECT * FROM chain_events WHERE event IN ('PassPurchased', 'FiatPassRecorded') ORDER BY block, log_index");
    return rows.map((r) => {
      const a = JSON.parse(r.args as string) as Record<string, string>;
      const onchain = r.event === "PassPurchased";
      const paidBy = onchain
        ? (this.rows("SELECT args FROM chain_events WHERE event = 'PassPaidBy' AND tx_hash = ?", r.tx_hash as string)[0]?.args as string | undefined)
        : undefined;
      const expiresAt = Number(a.expiresAt);
      return {
        id: `${r.tx_hash as string}:${Number(r.log_index)}`,
        holder: (r.account as string).toLowerCase() as Address,
        payer: onchain ? ((paidBy ? (JSON.parse(paidBy) as { payer: string }).payer : (r.account as string)).toLowerCase() as Address) : null,
        passType: Number(a.passType),
        periods: Number(a.periods),
        rail: onchain ? "onchain" : "rupiah",
        token: onchain ? (a.token as Address) : null,
        amount: onchain ? BigInt(a.amount!) : null,
        receiptHash: onchain ? null : (a.receiptHash as Hex),
        expiresAt,
        status: expiresAt > nowTs ? "active" : "expired",
        block: Number(r.block),
        ts: Number(r.ts),
      };
    });
  }

  /** The receipt hash recorded for a rupiah-paid Game Night (FiatGameNightRecorded), or null. */
  fiatGameNightRecord(bookingId: Hex): { agentId: number; receiptHash: Hex; tx: Hex; block: number } | null {
    const r = this.rows("SELECT tx_hash, block, args FROM chain_events WHERE event = 'FiatGameNightRecorded' AND lower(json_extract(args, '$.bookingId')) = ?", bookingId.toLowerCase())[0];
    if (!r) return null;
    const a = JSON.parse(r.args as string) as Record<string, string>;
    return { agentId: Number(a.agentId), receiptHash: a.receiptHash as Hex, tx: r.tx_hash as Hex, block: Number(r.block) };
  }

  /** How many times a badge (by its name, e.g. SCAM_SPOTTER) was awarded on chain in [fromTs, toTs). */
  badgesAwarded(badgeId: Hex, fromTs: number, toTs: number): number {
    return Number(
      this.rows("SELECT COUNT(*) AS n FROM chain_events WHERE event = 'BadgeAwarded' AND lower(json_extract(args, '$.badgeId')) = ? AND ts >= ? AND ts < ?", badgeId.toLowerCase(), fromTs, toTs)[0]?.n ?? 0,
    );
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

/** One row of D9 (F14-D01). Rupiah amounts are not on chain; the bot store keeps them (`fiat_passes`). */
export interface PassPurchase {
  id: string;
  holder: Address;
  /** Who paid on chain (the holder, or another wallet via buyPassFor); null for rupiah. */
  payer: Address | null;
  passType: number;
  periods: number;
  rail: "onchain" | "rupiah";
  token: Address | null;
  amount: bigint | null;
  receiptHash: Hex | null;
  expiresAt: number;
  status: "active" | "expired";
  block: number;
  ts: number;
}

const ROLE_NAMES: Record<number, string> = { 1: "villager", 2: "werewolf", 3: "seer", 4: "doctor" };

/** D7: a player's mirror of on-chain credits and their stats. */
export interface PlayerStats {
  account: Address;
  credits: number;
  games: number;
  wins: number;
  /** Consecutive UTC days with a finalized game, up to today or yesterday; 0 once broken. */
  streakDays: number;
  bestStreak: number;
  lastDay: string | null;
  rank: number;
  /** Badge name → times awarded (NoxBadges). */
  badges: Record<string, number>;
}

const toPlayerStats = (r: Record<string, string | number | null>): PlayerStats => ({
  account: r.account as Address,
  credits: Number(r.credits),
  games: Number(r.games),
  wins: Number(r.wins),
  streakDays: Number(r.streak_days),
  bestStreak: Number(r.best_streak),
  lastDay: (r.last_day as string | null) ?? null,
  rank: Number(r.rank),
  badges: JSON.parse((r.badges as string | null) ?? "{}") as Record<string, number>,
});

export interface OwnerLedger {
  owner: Address;
  token: Address;
  credited: bigint;
  withdrawn: bigint;
  /** credited - withdrawn: must equal NoxPayments.ownerBalance(owner, token). */
  owed: bigint;
}

export interface AgentRevenue {
  agentId: number;
  owner: Address;
  token: Address;
  /** Credited at payment time from Game Nights that used the agent. */
  gameNights: bigint;
  /** Credited by monthly pool allocations from pass revenue. */
  pool: bigint;
  total: bigint;
}

export interface TreasuryLedger {
  token: Address;
  passes: bigint;
  /** Game Night payments minus the agent owners' shares. */
  gameNights: bigint;
  pool: bigint;
  withdrawn: bigint;
  /** Must equal NoxPayments.treasuryBalance(token). */
  balance: bigint;
}

/** One Marketplace agent as the chain knows it (D16, F18-D01). */
export interface AgentOnChain {
  agentId: number;
  owner: Address;
  mode: "none" | "hosted" | "endpoint";
  status: "none" | "active" | "suspended" | "revoked";
  /** keccak256 of the persona's canonical JSON (hosted) or of the endpoint's metadata. */
  metadataHash: Hex;
  /** The owner's share of revenue, in basis points, and whether it was set for this agent. */
  shareBps: number;
  customShare: boolean;
  registeredAt: number;
  /** Credited revenue per token, in its smallest unit: Game Night shares and monthly pool. */
  revenue: { token: Address; gameNights: bigint; pool: bigint; total: bigint }[];
}

export interface PaymentLedger {
  owners: OwnerLedger[];
  agents: AgentRevenue[];
  treasury: TreasuryLedger[];
}

export interface PaymentReconciliation {
  at: number;
  block: number;
  checked: number;
  mismatches: { kind: "owner" | "treasury"; owner?: Address; token: Address; indexed: string; onChain: string }[];
}

/**
 * Compare the indexed agent-owner balances and treasury balances with NoxPayments at the indexed
 * block (F18-D05). Owners are paid by pulling their balance, so a difference means the index or the
 * settlement records are wrong before anyone is paid from them.
 */
export async function reconcilePayments(
  store: EventStore,
  read: { ownerBalance: (owner: Address, token: Address, block: bigint) => Promise<bigint>; treasuryBalance: (token: Address, block: bigint) => Promise<bigint> },
): Promise<PaymentReconciliation> {
  const block = store.indexedBlock();
  const ledger = store.paymentLedger();
  const mismatches: PaymentReconciliation["mismatches"] = [];
  for (const o of ledger.owners) {
    const onChain = await read.ownerBalance(o.owner, o.token, BigInt(block));
    if (onChain !== o.owed) mismatches.push({ kind: "owner", owner: o.owner, token: o.token, indexed: o.owed.toString(), onChain: onChain.toString() });
  }
  for (const t of ledger.treasury) {
    const onChain = await read.treasuryBalance(t.token, BigInt(block));
    if (onChain !== t.balance) mismatches.push({ kind: "treasury", token: t.token, indexed: t.balance.toString(), onChain: onChain.toString() });
  }
  const r: PaymentReconciliation = { at: Date.now(), block, checked: ledger.owners.length + ledger.treasury.length, mismatches };
  store.recordPaymentReconciliation(r);
  return r;
}

export interface Reconciliation {
  at: number;
  /** Block the balances were read at (the indexed block, so recent mints cannot cause false alarms). */
  block: number;
  checked: number;
  mismatches: { account: Address; indexed: string; onChain: string }[];
  orphanMints: number;
}

/**
 * Compare every indexed credits balance with NoxCredits.balanceOf at the indexed block (F08-D03).
 * Credits cannot move, so any difference means the index missed or misread an event; a mint for a
 * game that never finalized means something other than NoxGame's finalize minted.
 */
export async function reconcileCredits(store: EventStore, balanceAt: (account: Address, block: bigint) => Promise<bigint>, concurrency = 8): Promise<Reconciliation> {
  const block = store.indexedBlock();
  const players = store.leaderboard(1_000_000);
  const mismatches: Reconciliation["mismatches"] = [];
  for (let i = 0; i < players.length; i += concurrency) {
    await Promise.all(
      players.slice(i, i + concurrency).map(async (p) => {
        const onChain = await balanceAt(p.account, BigInt(block));
        if (onChain !== BigInt(p.credits)) mismatches.push({ account: p.account, indexed: String(p.credits), onChain: onChain.toString() });
      }),
    );
  }
  const r: Reconciliation = { at: Date.now(), block, checked: players.length, mismatches, orphanMints: store.orphanMints().length };
  store.recordReconciliation(r);
  return r;
}

/** RewardGranted's breakdown, plus the Scam Shield bonus minted next to it (F10-S05). */
const rewardOf = (a: Record<string, unknown>, scamShield = 0) => {
  const n = (k: string) => Number(a[k] ?? 0);
  const part = { base: n("base"), role: n("roleBonus"), vote: n("voteBonus"), streak: n("streakBonus"), scamShield };
  return { version: n("version"), ...part, total: part.base + part.role + part.vote + part.streak + scamShield };
};

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
    if (stored) store.refreshPlayerStats();
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
