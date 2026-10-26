import { keccak256, toHex, type Abi, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { NoxCreditsAbi, NoxGameAbi } from "../src/chain/contracts.js";
import { EventIndexer, EventStore, MAX_BLOCK_RANGE, reconcileCredits } from "../src/chain/indexer.js";
import { ava, ben, CREDITS, cy, FakeChain, GAME, game, gameId, minted, playGame } from "./chain-fakes.js";

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
});
