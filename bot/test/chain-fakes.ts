import { encodeAbiParameters, encodeEventTopics, keccak256, toHex, type Abi, type Address, type Hex } from "viem";
import { NoxCreditsAbi, NoxGameAbi } from "../src/chain/contracts.js";
import type { IndexerClient, RawLog } from "../src/chain/indexer.js";

/** A fake chain that answers like a node, with logs built from the real ABIs (indexer and API tests). */
export const GAME: Address = "0x00000000000000000000000000000000000000a1";
export const CREDITS: Address = "0x00000000000000000000000000000000000000c2";
export const gameId = keccak256(toHex("game-1"));
export const ava: Address = "0x1111111111111111111111111111111111111111";
export const ben: Address = "0x2222222222222222222222222222222222222222";
export const cy: Address = "0x3333333333333333333333333333333333333333";

type EventAbi = { type: string; name?: string; inputs?: readonly { name: string; type: string; indexed?: boolean }[] };

/** Build a raw log the way a node returns it, from the real ABI. */
export function log(address: Address, abi: Abi, eventName: string, args: Record<string, unknown>, blockNumber: bigint, logIndex = 0): RawLog {
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

export class FakeChain implements IndexerClient {
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

export const game = (name: string, args: Record<string, unknown>, block: bigint, i = 0) => log(GAME, NoxGameAbi as Abi, name, args, block, i);
export const minted = (to: Address, amount: bigint, block: bigint, i = 0) => log(CREDITS, NoxCreditsAbi as Abi, "CreditsMinted", { to, amount, gameId }, block, i);

/** One finished 3-player game: Ava is the werewolf and loses, the village wins. */
export function playGame(chain: FakeChain, at: bigint) {
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
