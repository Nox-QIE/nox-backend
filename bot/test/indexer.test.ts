import { keccak256, toHex, type Abi, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { NoxAgentRegistryAbi, NoxCreditsAbi, NoxGameAbi, NoxPaymentsAbi } from "../src/chain/contracts.js";
import { EventIndexer, EventStore, MAX_BLOCK_RANGE, reconcileCredits, reconcilePayments } from "../src/chain/indexer.js";
import { ava, ben, CREDITS, cy, FakeChain, GAME, game, gameId, minted, pay, PAYMENTS, playGame, reg, REGISTRY } from "./chain-fakes.js";

function setup(fromBlock = 100n) {
  const chain = new FakeChain();
  const store = new EventStore(":memory:");
  const logs: Record<string, unknown>[] = [];
  const indexer = new EventIndexer({
    client: chain,
    store,
    contracts: [
      { name: "NoxGame", address: GAME, abi: NoxGameAbi as Abi },
      { name: "NoxCredits", address: CREDITS, abi: NoxCreditsAbi as Abi },
    ],
    fromBlock,
    confirmations: 2n,
    log: (l) => logs.push(l),
  });
  return { chain, store, indexer, logs };
}

describe("event indexer", () => {
  it("scans in chunks of at most 10,000 blocks and stays behind the head", async () => {
    const { chain, store, indexer } = setup(100n);
    playGame(chain, 24_000n);
    chain.head = 24_005n;
    const r = await indexer.syncOnce();
    expect(r.block).toBe(24_003n); // head - 2 confirmations
    expect(chain.calls.every((c) => c.toBlock - c.fromBlock + 1n <= MAX_BLOCK_RANGE)).toBe(true);
    expect(chain.calls[0]!.fromBlock).toBe(100n);
    expect(chain.calls.length).toBe(3);
    // The reveal at 24,004 is not confirmed yet.
    expect(store.stats()).toMatchObject({ players: 3, playerTxs: 5, finishedGames: 0, credits: 0 });

    chain.head = 24_006n;
    expect((await indexer.syncOnce()).events).toBe(7);
    expect(store.stats()).toMatchObject({ players: 3, finishedGames: 1, credits: 70 });
  });

  it("is idempotent and resumes from its checkpoint", async () => {
    const { chain, store, indexer } = setup();
    playGame(chain, 200n);
    chain.head = 300n;
    expect((await indexer.syncOnce()).events).toBe(13);
    chain.calls = [];
    expect((await indexer.syncOnce()).events).toBe(0);
    expect(chain.calls).toEqual([]);
    // Writing the same events again (e.g. after a crash between chunks) adds nothing: unique (tx_hash, log_index).
    store.apply("other", store.eventsOfGame(gameId), 0n, null);
    expect(store.eventsOfGame(gameId)).toHaveLength(13);
  });

  it("ranks players by credits and counts wins from revealed roles", async () => {
    const { chain, store, indexer } = setup();
    playGame(chain, 200n);
    chain.head = 300n;
    await indexer.syncOnce();
    expect(store.leaderboard().map(({ account, credits, games, wins, rank }) => ({ account, credits, games, wins, rank }))).toEqual([
      { account: ben, credits: 30, games: 1, wins: 1, rank: 1 },
      { account: cy, credits: 30, games: 1, wins: 1, rank: 2 },
      { account: ava, credits: 10, games: 1, wins: 0, rank: 3 },
    ]);
    expect(store.creditsOf(ben)).toBe(30n);
    const events = store.eventsOfGame(gameId).map((e) => e.event);
    expect(events[0]).toBe("GameCreated");
    expect(events).toContain("CreditsMinted");
    expect(store.eventsOfGame(gameId).find((e) => e.event === "VoteCast")!.args).toEqual({ gameId, round: 1, voter: ben, target: ava });
  });

  it("rewinds after a reorg instead of keeping stale events", async () => {
    const { chain, store, indexer, logs } = setup();
    chain.logs.push(game("PlayerJoined", { gameId, player: ava }, 250n));
    chain.head = 300n;
    await indexer.syncOnce();
    expect(store.stats().players).toBe(1);

    // Blocks 240..298 are replaced: Ava's join disappears, Ben's appears.
    for (let b = 240n; b <= 300n; b++) chain.forks.set(b, "fork");
    chain.logs = [game("PlayerJoined", { gameId, player: ben }, 260n)];
    await indexer.syncOnce();
    expect(logs.some((l) => l.event === "index_reorg")).toBe(true);
    expect(store.leaderboard()).toEqual([]);
    expect(store.eventsOfGame(gameId).map((e) => e.account)).toEqual([ben]);
  });

  it("shows a disputed game as disputed, with its reason", async () => {
    const { chain, store, indexer } = setup();
    chain.logs.push(
      game("GameCreated", { gameId, configHash: keccak256(toHex("cfg")) }, 150n),
      game("PlayerJoined", { gameId, player: ava }, 151n),
      game("GameDisputed", { gameId, reason: 2, detail: "no reveal before the deadline" }, 160n),
    );
    chain.head = 200n;
    await indexer.syncOnce();
    expect(store.game(gameId)).toMatchObject({ status: "disputed", endedTs: expect.any(Number), dispute: { reason: "reveal_timeout", detail: "no reveal before the deadline" } });
    expect(store.player(ava).history[0]).toMatchObject({ status: "disputed", won: null });
    expect(store.stats().disputedGames).toBe(1);
  });

  it("adds the credits breakdown from RewardGranted to a player's history", async () => {
    const { chain, store, indexer } = setup();
    playGame(chain, 200n);
    chain.logs.push(game("RewardGranted", { gameId, player: ben, version: 1, base: 30, roleBonus: 5, voteBonus: 2, streakBonus: 0 }, 204n, 9));
    chain.head = 300n;
    await indexer.syncOnce();
    expect(store.player(ben).history[0]!.reward).toEqual({ version: 1, base: 30, role: 5, vote: 2, streak: 0, total: 37 });
    expect(store.player(cy).history[0]!.reward).toBeNull();
  });

  it("skips logs it cannot decode", async () => {
    const { chain, store, indexer, logs } = setup();
    chain.logs.push({ address: GAME, blockNumber: 150n, transactionHash: keccak256("0x01"), logIndex: 0, topics: [keccak256(toHex("Nope()"))], data: "0x" });
    chain.head = 200n;
    expect((await indexer.syncOnce()).events).toBe(0);
    expect(logs.some((l) => l.event === "index_unknown_log")).toBe(true);
    expect(store.stats().lastBlock).toBe(0);
  });

  describe("D7 mirror and reconciliation", () => {
    const DAY = 21_600n; // the fake chain's blocks are 4 s apart
    const dayTs = (block: bigint) => 1_790_000_000 + Number(block) * 4;
    /** One finished game for gameId `id` at `at`: Ava wolf (loses), Ben seer (wins). */
    const gameAt = (chain: FakeChain, id: Hex, at: bigint) =>
      chain.logs.push(
        game("GameCreated", { gameId: id, configHash: keccak256(toHex("cfg")) }, at),
        game("PlayerJoined", { gameId: id, player: ava }, at),
        game("PlayerJoined", { gameId: id, player: ben }, at, 1),
        game("RoleRevealed", { gameId: id, player: ava, role: 2 }, at + 1n, 0),
        game("RoleRevealed", { gameId: id, player: ben, role: 3 }, at + 1n, 1),
        game("GameFinalized", { gameId: id, resultHash: keccak256(toHex("r")), winner: 1 }, at + 1n, 2),
        minted(ava, 10n, at + 1n, 3, id),
        minted(ben, 30n, at + 1n, 4, id),
      );

    it("keeps credits, games, wins, streaks and ranks per player", async () => {
      const { chain, store, indexer } = setup(100n);
      const ids = [1, 2, 3, 4].map((i) => keccak256(toHex(`g${i}`)));
      // Days 1, 2, 3 in a row, then day 6.
      gameAt(chain, ids[0]!, DAY * 1n);
      gameAt(chain, ids[1]!, DAY * 2n);
      gameAt(chain, ids[2]!, DAY * 3n);
      gameAt(chain, ids[3]!, DAY * 6n);
      chain.head = DAY * 7n;
      await indexer.syncOnce();
      store.refreshPlayerStats(dayTs(DAY * 6n + 10n)); // same day as the last game
      expect(store.playerStats(ben)).toMatchObject({ credits: 120, games: 4, wins: 4, streakDays: 1, bestStreak: 3, rank: 1 });
      expect(store.playerStats(ava)).toMatchObject({ credits: 40, games: 4, wins: 0, rank: 2 });
      store.refreshPlayerStats(dayTs(DAY * 9n)); // two days later: the current streak is broken
      expect(store.playerStats(ben)).toMatchObject({ streakDays: 0, bestStreak: 3 });
    });

    it("flags credits minted for a game that never finalized", async () => {
      const { chain, store, indexer } = setup();
      playGame(chain, 200n);
      chain.logs.push(minted(cy, 999n, 250n, 0, keccak256(toHex("no-such-game"))));
      chain.head = 300n;
      await indexer.syncOnce();
      expect(store.orphanMints()).toEqual([expect.objectContaining({ account: cy, amount: 999 })]);
    });

    it("compares every indexed balance with balanceOf at the indexed block", async () => {
      const { chain, store, indexer } = setup();
      playGame(chain, 200n);
      chain.head = 300n;
      await indexer.syncOnce();
      const asked: bigint[] = [];
      const ok = await reconcileCredits(store, async (a, block) => {
        asked.push(block);
        return BigInt(store.playerStats(a)!.credits);
      });
      expect(ok).toMatchObject({ checked: 3, mismatches: [], orphanMints: 0, block: 298 });
      expect(new Set(asked)).toEqual(new Set([298n]));
      const bad = await reconcileCredits(store, async (a) => (a === cy ? 31n : BigInt(store.playerStats(a)!.credits)));
      expect(bad.mismatches).toEqual([{ account: cy, indexed: "30", onChain: "31" }]);
      expect(store.lastReconciliation()).toMatchObject({ checked: 3, mismatches: [{ account: cy }] });
    });
  });

  it("keeps the agent revenue and treasury ledger, and reconciles it with NoxPayments (F18-D05)", async () => {
    const chain = new FakeChain();
    const store = new EventStore(":memory:");
    const indexer = new EventIndexer({ client: chain, store, contracts: [{ name: "NoxPayments", address: PAYMENTS, abi: NoxPaymentsAbi as Abi }], fromBlock: 100n, confirmations: 0n });
    const QIE = "0x0000000000000000000000000000000000000000";
    const e18 = 10n ** 18n;
    chain.logs.push(
      pay("PassPurchased", { buyer: ava, passType: 1, periods: 2, token: QIE, amount: 2n * e18, expiresAt: 1n }, 110n),
      // Game Night with agent 7: 1 QIE, 30% to its owner Ben.
      pay("AgentCredited", { agentId: 7n, owner: ben, token: QIE, amount: 3n * 10n ** 17n }, 120n, 0),
      pay("GameNightPaid", { bookingId: keccak256(toHex("b1")), payer: cy, agentId: 7n, token: QIE, amount: e18, ownerShare: 3n * 10n ** 17n }, 120n, 1),
      // Monthly pool: 0.5 QIE to agent 7.
      pay("AgentCredited", { agentId: 7n, owner: ben, token: QIE, amount: 5n * 10n ** 17n }, 130n, 0),
      pay("AgentPoolAllocated", { period: 202610, token: QIE, total: 5n * 10n ** 17n, usageRoot: keccak256(toHex("u")) }, 130n, 1),
      pay("Withdrawn", { account: ben, token: QIE, amount: 3n * 10n ** 17n }, 140n),
    );
    // Events of one transaction share its hash, as on a real chain (the fake gives each log its own).
    for (const b of [120n, 130n]) {
      const same = chain.logs.filter((x) => x.blockNumber === b);
      for (const x of same) x.transactionHash = same[0]!.transactionHash;
    }
    chain.head = 200n;
    await indexer.syncOnce();
    const l = store.paymentLedger();
    expect(l.agents).toEqual([{ agentId: 7, owner: ben, token: QIE, gameNights: 3n * 10n ** 17n, pool: 5n * 10n ** 17n, total: 8n * 10n ** 17n }]);
    expect(l.owners).toEqual([{ owner: ben, token: QIE, credited: 8n * 10n ** 17n, withdrawn: 3n * 10n ** 17n, owed: 5n * 10n ** 17n }]);
    expect(l.treasury).toEqual([{ token: QIE, passes: 2n * e18, gameNights: 7n * 10n ** 17n, pool: 5n * 10n ** 17n, withdrawn: 0n, balance: 22n * 10n ** 17n }]);

    const good = await reconcilePayments(store, { ownerBalance: async () => 5n * 10n ** 17n, treasuryBalance: async () => 22n * 10n ** 17n });
    expect(good).toMatchObject({ checked: 2, mismatches: [], block: 200 });
    const bad = await reconcilePayments(store, { ownerBalance: async () => 8n * 10n ** 17n, treasuryBalance: async () => 22n * 10n ** 17n });
    expect(bad.mismatches).toEqual([{ kind: "owner", owner: ben, token: QIE, indexed: "500000000000000000", onChain: "800000000000000000" }]);
    expect(store.lastPaymentReconciliation()!.mismatches).toHaveLength(1);
  });

  it("keeps the D9 pass ledger: on-chain purchases with their payer, rupiah ones with their receipt (F14-D01)", async () => {
    const chain = new FakeChain();
    const store = new EventStore(":memory:");
    const indexer = new EventIndexer({ client: chain, store, contracts: [{ name: "NoxPayments", address: PAYMENTS, abi: NoxPaymentsAbi as Abi }], fromBlock: 100n, confirmations: 0n });
    const QIE = "0x0000000000000000000000000000000000000000";
    const receipt = keccak256(toHex("receipt"));
    chain.logs.push(
      pay("PassPurchased", { buyer: ava, passType: 1, periods: 1, token: QIE, amount: 10n ** 18n, expiresAt: 1_000n }, 110n, 0),
      pay("PassPaidBy", { payer: cy, holder: ava, passType: 1 }, 110n, 1),
      pay("PassPurchased", { buyer: ben, passType: 1, periods: 2, token: QIE, amount: 2n * 10n ** 18n, expiresAt: 9_000_000_000n }, 120n),
      pay("FiatPassRecorded", { buyer: ben, passType: 1, periods: 1, receiptHash: receipt, expiresAt: 9_100_000_000n }, 130n),
    );
    const same = chain.logs.filter((x) => x.blockNumber === 110n);
    for (const x of same) x.transactionHash = same[0]!.transactionHash;
    chain.head = 200n;
    await indexer.syncOnce();
    const all = store.passPurchases(undefined, 2_000);
    expect(all.map((p) => [p.holder, p.payer, p.rail, p.status])).toEqual([
      [ava.toLowerCase(), cy.toLowerCase(), "onchain", "expired"],
      [ben.toLowerCase(), ben.toLowerCase(), "onchain", "active"],
      [ben.toLowerCase(), null, "rupiah", "active"],
    ]);
    expect(store.passPurchases(ben, 2_000)[1]).toMatchObject({ periods: 1, receiptHash: receipt, amount: null, token: null, expiresAt: 9_100_000_000 });
    expect(store.passPurchases(ava, 2_000)[0]).toMatchObject({ amount: 10n ** 18n, periods: 1 });
  });

  it("mirrors D16 from NoxAgentRegistry: owner, mode, status, persona hash, share and revenue (F18-D01)", async () => {
    const chain = new FakeChain();
    const store = new EventStore(":memory:");
    const indexer = new EventIndexer({
      client: chain,
      store,
      contracts: [
        { name: "NoxAgentRegistry", address: REGISTRY, abi: NoxAgentRegistryAbi as Abi },
        { name: "NoxPayments", address: PAYMENTS, abi: NoxPaymentsAbi as Abi },
      ],
      fromBlock: 100n,
      confirmations: 0n,
    });
    const h1 = keccak256(toHex("persona-1"));
    const h2 = keccak256(toHex("persona-2"));
    chain.logs.push(
      reg("AgentRegistered", { agentId: 1n, owner: ben, mode: 1, metadataHash: h1 }, 110n),
      reg("AgentRegistered", { agentId: 2n, owner: cy, mode: 2, metadataHash: h1 }, 111n),
      reg("ShareChanged", { agentId: 2n, shareBps: 5000 }, 112n), // custom share
      reg("ShareChanged", { agentId: 0n, shareBps: 2500 }, 113n), // new default: agent 1 follows it
      reg("AgentStatusChanged", { agentId: 2n, status: 2 }, 114n),
      reg("AgentOwnerChanged", { agentId: 1n, owner: ava }, 115n),
      reg("AgentMetadataUpdated", { agentId: 2n, metadataHash: h2 }, 116n),
      pay("AgentCredited", { agentId: 1n, owner: ava, token: "0x0000000000000000000000000000000000000000", amount: 25n * 10n ** 16n }, 117n),
    );
    chain.head = 200n;
    await indexer.syncOnce();
    const [a1, a2] = store.agents();
    expect(a1).toMatchObject({ agentId: 1, owner: ava.toLowerCase(), mode: "hosted", status: "active", metadataHash: h1, shareBps: 2500, customShare: false });
    expect(a2).toMatchObject({ agentId: 2, owner: cy.toLowerCase(), mode: "endpoint", status: "suspended", metadataHash: h2, shareBps: 5000, customShare: true });
    expect(a1!.revenue).toEqual([expect.objectContaining({ token: "0x0000000000000000000000000000000000000000", total: 25n * 10n ** 16n })]);
    expect(a2!.revenue).toEqual([]);
  });
});
