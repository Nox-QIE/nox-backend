import { encodeAbiParameters, encodeEventTopics, keccak256, toHex, type Abi, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { NoxCreditsAbi, NoxGameAbi } from "../src/chain/contracts.js";
import { EventIndexer, EventStore, MAX_BLOCK_RANGE, type IndexerClient, type RawLog } from "../src/chain/indexer.js";

const GAME: Address = "0x00000000000000000000000000000000000000a1";
const CREDITS: Address = "0x00000000000000000000000000000000000000c2";
const gameId = keccak256(toHex("game-1"));
const ava: Address = "0x1111111111111111111111111111111111111111";
const ben: Address = "0x2222222222222222222222222222222222222222";
const cy: Address = "0x3333333333333333333333333333333333333333";

type EventAbi = { type: string; name?: string; inputs?: readonly { name: string; type: string; indexed?: boolean }[] };

/** Build a raw log the way a node returns it, from the real ABI. */
function log(address: Address, abi: Abi, eventName: string, args: Record<string, unknown>, blockNumber: bigint, logIndex = 0): RawLog {
  const ev = (abi as readonly EventAbi[]).find((x) => x.type === "event" && x.name === eventName)!;
  const topics = encodeEventTopics({ abi, eventName, args } as never) as Hex[];
  const data = ev.inputs!.filter((i) => !i.indexed);
  return {
    address,
    blockNumber,
    transactionHash: keccak256(toHex(`${eventName}-${blockNumber}-${logIndex}-${JSON.stringify(args, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`)),
    logIndex,
    topics,
    data: encodeAbiParameters(data as never, data.map((i) => args[i.name]) as never),
  };
}

class FakeChain implements IndexerClient {
  head = 0n;
  logs: RawLog[] = [];
  forks = new Map<bigint, string>();
  calls: { fromBlock: bigint; toBlock: bigint }[] = [];
  hash = (b: bigint): Hex => keccak256(toHex(`block-${b}-${this.forks.get(b) ?? ""}`));
  async getBlockNumber() {
    return this.head;
  }
  async getBlock({ blockNumber }: { blockNumber: bigint }) {
    return { hash: this.hash(blockNumber), timestamp: 1_790_000_000n + blockNumber * 4n };
  }
  async getLogs({ address, fromBlock, toBlock }: { address: Address[]; fromBlock: bigint; toBlock: bigint }) {
    this.calls.push({ fromBlock, toBlock });
    const set = new Set(address.map((a) => a.toLowerCase()));
    return this.logs.filter((l) => set.has(l.address.toLowerCase()) && l.blockNumber! >= fromBlock && l.blockNumber! <= toBlock);
  }
}

const game = (name: string, args: Record<string, unknown>, block: bigint, i = 0) => log(GAME, NoxGameAbi as Abi, name, args, block, i);
const minted = (to: Address, amount: bigint, block: bigint, i = 0) => log(CREDITS, NoxCreditsAbi as Abi, "CreditsMinted", { to, amount, gameId }, block, i);

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

/** One finished 3-player game: Ava is the werewolf and loses, the village wins. */
function playGame(chain: FakeChain, at: bigint) {
  chain.logs.push(
    game("GameCreated", { gameId, configHash: keccak256(toHex("cfg")) }, at),
    game("PlayerJoined", { gameId, player: ava }, at + 1n),
    game("PlayerJoined", { gameId, player: ben }, at + 1n, 1),
    game("PlayerJoined", { gameId, player: cy }, at + 2n),
    game("VoteCast", { gameId, round: 1, voter: ben, target: ava }, at + 3n),
    game("VoteCast", { gameId, round: 1, voter: cy, target: ava }, at + 3n, 1),
    game("RoleRevealed", { gameId, player: ava, role: 2 }, at + 4n, 0),
    game("RoleRevealed", { gameId, player: ben, role: 3 }, at + 4n, 1),
    game("RoleRevealed", { gameId, player: cy, role: 1 }, at + 4n, 2),
    game("GameFinalized", { gameId, resultHash: keccak256(toHex("result")), winner: 1 }, at + 4n, 3),
    minted(ava, 10n, at + 4n, 4),
    minted(ben, 30n, at + 4n, 5),
    minted(cy, 30n, at + 4n, 6),
  );
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
    expect(store.leaderboard()).toEqual([
      { account: ben, credits: 30, games: 1, wins: 1 },
      { account: cy, credits: 30, games: 1, wins: 1 },
      { account: ava, credits: 10, games: 1, wins: 0 },
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

  it("skips logs it cannot decode", async () => {
    const { chain, store, indexer, logs } = setup();
    chain.logs.push({ address: GAME, blockNumber: 150n, transactionHash: keccak256("0x01"), logIndex: 0, topics: [keccak256(toHex("Nope()"))], data: "0x" });
    chain.head = 200n;
    expect((await indexer.syncOnce()).events).toBe(0);
    expect(logs.some((l) => l.event === "index_unknown_log")).toBe(true);
    expect(store.stats().lastBlock).toBe(0);
  });
});
