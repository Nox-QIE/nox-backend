import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { keccak256, toHex, type Abi } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { createApi } from "../src/api.js";
import { NoxCreditsAbi, NoxGameAbi } from "../src/chain/contracts.js";
import { EventIndexer, EventStore } from "../src/chain/indexer.js";
import { ava, ben, CREDITS, cy, FakeChain, GAME, game, gameId, playGame } from "./chain-fakes.js";

let server: Server | undefined;
afterEach(() => server?.close());

async function setup(opts: { ratePerMinute?: number } = {}) {
  const chain = new FakeChain();
  const store = new EventStore(":memory:");
  const indexer = new EventIndexer({
    client: chain,
    store,
    contracts: [
      { name: "NoxGame", address: GAME, abi: NoxGameAbi as Abi },
      { name: "NoxCredits", address: CREDITS, abi: NoxCreditsAbi as Abi },
    ],
    fromBlock: 100n,
    confirmations: 0n,
  });
  playGame(chain, 200n);
  // A second game that was cancelled, and a third still running.
  const g2 = keccak256(toHex("game-2"));
  const g3 = keccak256(toHex("game-3"));
  chain.logs.push(
    game("GameCreated", { gameId: g2, configHash: keccak256(toHex("cfg")) }, 300n),
    game("PlayerJoined", { gameId: g2, player: ava }, 301n),
    game("GameCancelled", { gameId: g2, reason: "chain error" }, 302n),
    game("GameCreated", { gameId: g3, configHash: keccak256(toHex("cfg")) }, 400n),
  );
  chain.head = 500n;
  await indexer.syncOnce();
  // Day of block 200 in the fake chain's clock, at noon.
  const now = (1_790_000_000 + 200 * 4) * 1000 + 6 * 3600 * 1000;
  server = createApi({ store, network: "testnet", chainId: 1983, now: () => now, ...opts });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string, init?: RequestInit) => fetch(base + path, init);
  return { chain, store, indexer, get, g2, g3 };
}

describe("public API", () => {
  it("serves stats, health and the leaderboard", async () => {
    const { get } = await setup();
    const health = await (await get("/v1/health")).json();
    expect(health).toEqual({ ok: true, network: "testnet", chainId: 1983, indexedBlock: 500, reconciliation: null });
    const stats = await (await get("/v1/stats")).json();
    expect(stats).toMatchObject({ players: 3, finishedGames: 1, cancelledGames: 1, credits: 70, indexedBlock: 500 });
    const board = await (await get("/v1/leaderboard?limit=2")).json();
    expect(board.season).toBeNull();
    expect(board.players).toEqual([
      expect.objectContaining({ account: ben, credits: 30, games: 1, wins: 1, rank: 1 }),
      expect.objectContaining({ account: cy, credits: 30, games: 1, wins: 1, rank: 2 }),
    ]);
    expect((await get("/v1/leaderboard?season=2026-9")).status).toBe(400);
    const sept = await (await get("/v1/leaderboard?season=2026-09")).json();
    expect(sept.players.map((p: { account: string }) => p.account)).toEqual([ben, cy, ava]);
    expect((await (await get("/v1/leaderboard?season=2026-10")).json()).players).toEqual([]);
    const p = await (await get(`/v1/players/${ben}`)).json();
    expect(p.stats).toMatchObject({ credits: 30, games: 1, wins: 1, bestStreak: 1, rank: 1 });
  });

  it("lists games newest first with their status, and pages with ?before", async () => {
    const { get, g2, g3 } = await setup();
    const { games } = await (await get("/v1/games")).json();
    expect(games.map((g: { gameId: string; status: string }) => [g.gameId, g.status])).toEqual([
      [g3, "running"],
      [g2, "cancelled"],
      [gameId, "finalized"],
    ]);
    expect(games[1]).toMatchObject({ players: 1, cancelReason: "chain error", winner: null });
    expect(games[2]).toMatchObject({ players: 3, winner: "village" });
    const older = await (await get(`/v1/games?before=${games[1].block}`)).json();
    expect(older.games.map((g: { gameId: string }) => g.gameId)).toEqual([gameId]);
  });

  it("returns one game with its events, and a player's history", async () => {
    const { get, g2 } = await setup();
    const one = await (await get(`/v1/games/${gameId}`)).json();
    expect(one.game).toMatchObject({ gameId, status: "finalized", winner: "village" });
    expect(one.events).toHaveLength(13);

    const p = await (await get(`/v1/players/${ava}`)).json();
    expect(p).toMatchObject({ account: ava, credits: 10, games: 2, finished: 1, wins: 0, signedTxs: 2 });
    expect(p.history).toEqual([
      expect.objectContaining({ gameId: g2, status: "cancelled", role: null, won: null }),
      expect.objectContaining({ gameId, status: "finalized", role: "werewolf", won: false }),
    ]);
    const b = await (await get(`/v1/players/${ben}`)).json();
    expect(b.history[0]).toMatchObject({ role: "seer", won: true });
  });

  it("counts daily signers", async () => {
    const { get } = await setup();
    const { days } = await (await get("/v1/daily?days=7")).json();
    expect(days).toEqual([{ day: "2026-09-21", players: 3 }]);
  });

  it("rejects bad input with clear errors", async () => {
    const { get } = await setup();
    expect((await get("/v1/games/0x1234")).status).toBe(400);
    expect((await get(`/v1/games/0x${"ab".repeat(32)}`)).status).toBe(404);
    expect((await get("/v1/players/nope")).status).toBe(400);
    expect((await get("/v1/leaderboard?limit=5000")).status).toBe(400);
    expect((await get("/v1/stats/extra")).status).toBe(404);
    expect((await get("/admin")).status).toBe(404);
    const post = await get("/v1/stats", { method: "POST" });
    expect(post.status).toBe(405);
    expect((await post.json()).error).toBe("only GET");
  });

  it("answers CORS preflight and sends cache headers; 304 until the index moves", async () => {
    const { get, chain, indexer } = await setup();
    const pre = await get("/v1/stats", { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");

    const first = await get("/v1/stats");
    expect(first.headers.get("cache-control")).toBe("public, max-age=5");
    const etag = first.headers.get("etag")!;
    expect((await get("/v1/stats", { headers: { "if-none-match": etag } })).status).toBe(304);

    chain.logs.push(game("PlayerJoined", { gameId, player: "0x4444444444444444444444444444444444444444" }, 510n));
    chain.head = 520n;
    await indexer.syncOnce();
    const fresh = await get("/v1/stats", { headers: { "if-none-match": etag } });
    expect(fresh.status).toBe(200);
    expect((await fresh.json()).players).toBe(4);
  });

  it("limits requests per client per minute", async () => {
    const { get } = await setup({ ratePerMinute: 3 });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await get("/v1/health")).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
  });
});
