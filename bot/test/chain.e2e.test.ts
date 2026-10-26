import { execSync, spawn, type ChildProcess } from "node:child_process";
import { createPublicClient, createWalletClient, custom, defineChain, http, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  NoxAgentRegistryAbi,
  NoxAgentRegistryBytecode,
  NoxCreditsAbi,
  NoxCreditsBytecode,
  NoxGameAbi,
  NoxGameBytecode,
  NoxPaymentsAbi,
  NoxPaymentsBytecode,
} from "../src/chain/contracts.js";
import { EventIndexer, EventStore, type IndexerClient } from "../src/chain/indexer.js";
import { operatorFrom, registerAgentOnChain } from "../src/chain/operator.js";
import { settleMonth } from "../src/chain/settle.js";
import { gasLimitFor, rpcTransport, ViemLedger } from "../src/chain/viem-ledger.js";
import { PlayerWallets } from "../src/chain/wallets.js";
import { TemplateNarrator } from "../src/narrator.js";
import type { GameLedger } from "../src/chain/ledger.js";
import { recoverGames } from "../src/recovery.js";
import { Registry } from "../src/registry.js";
import { SqliteStore, storeKey } from "../src/store.js";
import { FakeMessenger, FakeScheduler } from "./fakes.js";

const hasAnvil = (() => {
  try {
    execSync("anvil --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// Anvil's first well-known dev account. Local test chain only.
const OPERATOR_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const PORT = 8600 + Math.floor(Math.random() * 300);
const RPC = `http://127.0.0.1:${PORT}`;
const chain = defineChain({ id: 31337, name: "Anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });

let anvil: ChildProcess;
let gameAddress: Address;
let creditsAddress: Address;
const publicClient = createPublicClient({ chain, transport: http(RPC), pollingInterval: 50 });

describe.skipIf(!hasAnvil)("on-chain game (anvil + real contracts)", () => {
  beforeAll(async () => {
    anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
    for (let i = 0; i < 100; i++) {
      try {
        await publicClient.getChainId();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const operator = privateKeyToAccount(OPERATOR_KEY);
    const wallet = createWalletClient({ account: operator, chain, transport: http(RPC) });
    const deploy = async (abi: never, bytecode: Hex, args: unknown[]) => {
      const hash = await wallet.deployContract({ abi, bytecode, args: args as never });
      return (await publicClient.waitForTransactionReceipt({ hash })).contractAddress!;
    };
    creditsAddress = await deploy(NoxCreditsAbi as never, NoxCreditsBytecode, [operator.address]);
    gameAddress = await deploy(NoxGameAbi as never, NoxGameBytecode, [operator.address, operator.address, creditsAddress]);
    const minter = await publicClient.readContract({ address: creditsAddress, abi: NoxCreditsAbi, functionName: "MINTER_ROLE" });
    const hash = await wallet.writeContract({ address: creditsAddress, abi: NoxCreditsAbi, functionName: "grantRole", args: [minter, gameAddress] });
    await publicClient.waitForTransactionReceipt({ hash });
  }, 30_000);

  afterAll(() => {
    anvil?.kill();
  });

  it("fails over to the next RPC when the first one is down", async () => {
    const twoRpcs = defineChain({ ...chain, rpcUrls: { default: { http: ["http://127.0.0.1:1", RPC] } } });
    const client = createPublicClient({ chain: twoRpcs, transport: rpcTransport(twoRpcs) });
    expect(await client.getChainId()).toBe(31337);
  });

  it("records a full game: roles committed, actions and votes from player wallets, reveal verified, credits minted", async () => {
    const logs: Record<string, unknown>[] = [];
    const wallets = new PlayerWallets(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
    const ledger = new ViemLedger({
      chain,
      rpcUrl: RPC,
      gameAddress,
      operatorKey: OPERATOR_KEY,
      wallets,
      minBalance: 10n ** 15n,
      dripAmount: 10n ** 16n,
      pollingMs: 50,
      log: (l) => logs.push(l),
    });
    const messenger = new FakeMessenger();
    const scheduler = new FakeScheduler();
    const registry = new Registry({
      messenger,
      scheduler,
      timings: { lobbyMs: 1000, nightMs: 1000, discussionMs: 1000, voteMs: 1000 },
      randomInt: () => 0,
      botUsername: "nox_test_bot",
      narratorFor: (lang) => new TemplateNarrator(lang),
      ledger,
      webUrl: "https://nox.example/",
    });
    const users = [11, 22, 33, 44, 55];
    for (const u of users) registry.startedUsers.add(u);
    await registry.create(-1, 11, "Ava", "en");
    const room = registry.roomOfChat(-1)!;
    for (const u of users.slice(1)) await registry.join(room.id, u, `P${u}`);
    await room.start(11);

    expect(room.gameId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(messenger.dms(11)[0]!.html).toContain("<code>0x");

    const role = (r: string) => users.filter((u) => room.roleOf(u) === r);
    const [wolf] = role("werewolf");
    const [seer] = role("seer");
    const [doctor] = role("doctor");
    const victim = role("villager")[0]!;
    await room.nightAction(wolf!, 1, String(victim));
    await room.nightAction(seer!, 1, String(wolf));
    await room.nightAction(doctor!, 1, String(doctor));
    await scheduler.advance(1000); // discussion → vote
    for (const u of users.filter((u) => room.isAlive(u))) await room.vote(u, 1, String(wolf));
    expect(room.status).toBe("ended");
    expect(messenger.group().at(-1)).toContain(`https://nox.example/game/?id=${room.gameId}`);

    await ledger.idle();
    expect(logs.filter((l) => l.event === "chain_error")).toEqual([]);

    const gameId = room.gameId!;
    const game = await publicClient.readContract({ address: gameAddress, abi: NoxGameAbi, functionName: "games", args: [gameId] });
    expect(game[0]).toBe(3); // Status.Finalized
    expect(game[3]).toBe(1); // winner = village

    const balance = (u: number) =>
      publicClient.readContract({ address: creditsAddress, abi: NoxCreditsAbi, functionName: "balanceOf", args: [wallets.address(u)] });
    expect(await balance(wolf!)).toBe(10n);
    for (const u of users.filter((u) => u !== wolf)) expect(await balance(u)).toBe(30n);

    // Every player sent their own transactions (join + votes/commits), funded by the gas drip.
    for (const u of users) expect(await publicClient.getTransactionCount({ address: wallets.address(u) })).toBeGreaterThan(0);
    expect(logs.filter((l) => l.event === "gas_drip")).toHaveLength(5);

    const revealed = await publicClient.readContract({ address: gameAddress, abi: NoxGameAbi, functionName: "revealedRoleOf", args: [gameId, wallets.address(wolf!)] });
    expect(revealed).toBe(2); // werewolf
  }, 60_000);

  it("after a restart: cancels a game that was still running and finalizes one that had ended", async () => {
    const logs: Record<string, unknown>[] = [];
    const wallets = new PlayerWallets(Uint8Array.from({ length: 32 }, (_, i) => 100 + i));
    const store = new SqliteStore(":memory:", storeKey("ab".repeat(32)));
    const newLedger = () =>
      new ViemLedger({
        chain,
        rpcUrl: RPC,
        gameAddress,
        operatorKey: OPERATOR_KEY,
        wallets,
        minBalance: 10n ** 15n,
        dripAmount: 10n ** 16n,
        pollingMs: 50,
        log: (l) => logs.push(l),
        onSettled: (id, outcome) => store.setStatus(id, outcome),
      });

    // "Old process": its finalize never reaches the chain (as if the server died right after the game).
    const old = newLedger();
    const dropFinalize: GameLedger = Object.assign(Object.create(old), { finalize() {} });
    const play = async (chatId: number, users: number[], finish: boolean) => {
      const messenger = new FakeMessenger();
      const scheduler = new FakeScheduler();
      const registry = new Registry({
        messenger,
        scheduler,
        timings: { lobbyMs: 1000, nightMs: 1000, discussionMs: 1000, voteMs: 1000 },
        randomInt: () => 0,
        botUsername: "nox_test_bot",
        narratorFor: (lang) => new TemplateNarrator(lang),
        ledger: dropFinalize,
        store,
      });
      for (const u of users) registry.markStarted(u);
      await registry.create(chatId, users[0]!, "Host", "en");
      const room = registry.roomOfChat(chatId)!;
      for (const u of users.slice(1)) await registry.join(room.id, u, `P${u}`);
      await room.start(users[0]!);
      if (finish) {
        const wolf = users.find((u) => room.roleOf(u) === "werewolf")!;
        await scheduler.advance(1000); // night passes with no actions
        await scheduler.advance(1000); // discussion → vote
        for (const u of users) await room.vote(u, 1, String(wolf));
        expect(room.status).toBe("ended");
      }
      return room.gameId!;
    };
    const runningId = await play(-10, [201, 202, 203, 204, 205], false);
    const endedId = await play(-20, [301, 302, 303, 304, 305], true);
    await old.idle();
    expect(await old.statusOf(runningId)).toBe(2);
    expect(await old.statusOf(endedId)).toBe(2);
    expect(store.unsettledGames().map((g) => g.status).sort()).toEqual(["ended", "running"]);

    // "New process": fresh ledger, same store.
    const fresh = newLedger();
    const messenger = new FakeMessenger();
    await recoverGames(store, fresh, messenger, (l) => logs.push(l));
    await fresh.idle();

    expect(await fresh.statusOf(runningId)).toBe(4); // Cancelled
    expect(await fresh.statusOf(endedId)).toBe(3); // Finalized
    expect(messenger.group()).toEqual([expect.stringContaining("restarted")]);
    expect(store.unsettledGames()).toEqual([]);
    expect(logs.filter((l) => l.event === "chain_error")).toEqual([]);
  }, 90_000);

  it("refuses gas drips beyond the daily budget and cancels that game cleanly", async () => {
    const logs: Record<string, unknown>[] = [];
    const wallets = new PlayerWallets(Uint8Array.from({ length: 32 }, (_, i) => 200 + i));
    const ledger = new ViemLedger({
      chain,
      rpcUrl: RPC,
      gameAddress,
      operatorKey: OPERATOR_KEY,
      wallets,
      minBalance: 10n ** 15n,
      dripAmount: 10n ** 16n,
      dripDailyBudget: 3n * 10n ** 16n, // enough for 3 of the 5 players
      pollingMs: 50,
      log: (l) => logs.push(l),
    });
    const messenger = new FakeMessenger();
    const registry = new Registry({
      messenger,
      scheduler: new FakeScheduler(),
      timings: { lobbyMs: 1000, nightMs: 1000, discussionMs: 1000, voteMs: 1000 },
      randomInt: () => 0,
      botUsername: "nox_test_bot",
      narratorFor: (lang) => new TemplateNarrator(lang),
      ledger,
    });
    const users = [401, 402, 403, 404, 405];
    users.forEach((u) => registry.markStarted(u));
    await registry.create(-40, 401, "Host", "en");
    const room = registry.roomOfChat(-40)!;
    for (const u of users.slice(1)) await registry.join(room.id, u, `P${u}`);
    await room.start(401);
    await ledger.idle();

    expect(logs.filter((l) => l.event === "gas_drip")).toHaveLength(3);
    expect(logs.some((l) => l.event === "chain_error" && String(l.error).includes("daily gas budget"))).toBe(true);
    expect(await ledger.statusOf(room.gameId!)).toBe(4); // cancelled, not left running
    expect(room.status).toBe("running"); // the Telegram game itself goes on
  }, 60_000);

  it("settles the agent pool: registered agent, pass revenue, valid games, allocation, owner withdrawal", async () => {
    const operator = privateKeyToAccount(OPERATOR_KEY);
    const wallet = createWalletClient({ account: operator, chain, transport: http(RPC) });
    const deploy = async (abi: never, bytecode: Hex, args: unknown[]) =>
      (await publicClient.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi, bytecode, args: args as never }) })).contractAddress!;
    const registry = await deploy(NoxAgentRegistryAbi as never, NoxAgentRegistryBytecode, [operator.address, operator.address]);
    const payments = await deploy(NoxPaymentsAbi as never, NoxPaymentsBytecode, [operator.address, operator.address, registry]);
    await publicClient.waitForTransactionReceipt({
      hash: await wallet.writeContract({ address: payments, abi: NoxPaymentsAbi, functionName: "configurePass", args: [1, "0x0000000000000000000000000000000000000000", 10n ** 18n, 30n * 86400n] }),
    });

    // A host buys 4 periods of Host Pass with QIE (anvil dev account #1).
    const host = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const hostWallet = createWalletClient({ account: host, chain, transport: http(RPC) });
    await publicClient.waitForTransactionReceipt({
      hash: await hostWallet.writeContract({ address: payments, abi: NoxPaymentsAbi, functionName: "buyPass", args: [1, 4, "0x0000000000000000000000000000000000000000"], value: 4n * 10n ** 18n }),
    });

    const store = new SqliteStore(":memory:");
    const owner = "0x00000000000000000000000000000000000a9e01" as const;
    const agentId = store.addAgent(owner, { name: "Noir", tagline: "", style: "x".repeat(50), examples: [], langs: ["en"] });
    const op = operatorFrom({ network: "local", rpcUrl: RPC, operatorKey: OPERATOR_KEY, dripWei: 0n, minWei: 0n, dailyPerPlayerWei: 0n, dailyBudgetWei: 0n, paymentsFromBlock: 0n }, 50);
    store.setChainAgentId(agentId, await registerAgentOnChain(op, registry, owner, store.getAgent(agentId)!.persona));
    for (const a of [agentId, agentId, agentId, null]) store.recordFinishedGame({ agentId: a, players: 6, hostId: 1, chainGameId: null });

    const month = new Date().toISOString().slice(0, 7);
    const r = await settleMonth(store, op, { registry, payments }, month, "0x0000000000000000000000000000000000000000", true);
    expect(r.revenue).toBe(4n * 10n ** 18n);
    expect(r.payouts).toEqual([{ agentId, validGames: 3, amount: 9n * 10n ** 17n }]); // 4 QIE x 30% x 3/4
    expect(r.tx).toMatch(/^0x/);
    const owed = await publicClient.readContract({ address: payments, abi: NoxPaymentsAbi, functionName: "ownerBalance", args: [owner, "0x0000000000000000000000000000000000000000"] });
    expect(owed).toBe(9n * 10n ** 17n);
    // Settling the same month again is refused by the contract.
    await expect(settleMonth(store, op, { registry, payments }, month, "0x0000000000000000000000000000000000000000", true)).rejects.toThrow();
  }, 60_000);

  it("does not trust a node that underestimates gas (QIE testnet answered 22088 for createGame)", async () => {
    // A transport that forwards everything to anvil but answers eth_estimateGas with the intrinsic
    // gas only, like a node that does not have the contract yet.
    const base = http(RPC)({ chain });
    const lying = custom({
      async request({ method, params }) {
        if (method === "eth_estimateGas") return "0x5648"; // 22088
        return base.request({ method, params } as never);
      },
    });
    const logs: Record<string, unknown>[] = [];
    const wallets = new PlayerWallets(Uint8Array.from({ length: 32 }, (_, i) => 150 + i));
    const ledger = new ViemLedger({
      chain,
      gameAddress,
      operatorKey: OPERATOR_KEY,
      wallets,
      minBalance: 10n ** 15n,
      dripAmount: 10n ** 16n,
      pollingMs: 50,
      transport: lying,
      log: (l) => logs.push(l),
    });
    const users = [601, 602, 603, 604, 605];
    const gameId = ("0x" + "77".repeat(32)) as Hex;
    const { commitRoles } = await import("@nox/shared/crypto-spec");
    const roles = users.map((u, i) => ({ player: wallets.address(u), role: (i === 0 ? "werewolf" : i === 1 ? "seer" : i === 2 ? "doctor" : "villager") as never }));
    ledger.startGame(gameId, ("0x" + "00".repeat(32)) as Hex, users, commitRoles(gameId, roles).root);
    await ledger.idle();
    expect(logs.filter((l) => l.event === "chain_error")).toEqual([]);
    expect(await ledger.statusOf(gameId)).toBe(2); // Running: create, 5 joins and commitRoles all landed
    expect(gasLimitFor("createGame", 22088n)).toBe(110_000n);
    expect(gasLimitFor("revealAndFinalize", 1_500_000n)).toBe(1_875_000n);
  }, 60_000);

  it("retries through a flaky node without creating twice or dripping twice", async () => {
    // Forwards to anvil, but the 1st raw transaction never reaches the chain and the 2nd and 3rd
    // reach it while their responses get lost (like an RPC that times out after broadcasting).
    const base = http(RPC)({ chain });
    let sends = 0;
    const flaky = custom(
      {
        async request({ method, params }) {
          if (method !== "eth_sendRawTransaction") return base.request({ method, params } as never);
          sends++;
          if (sends === 1) throw new Error("fetch failed (dropped before broadcast)");
          const result = await base.request({ method, params } as never);
          if (sends === 2 || sends === 3) throw new Error("fetch failed (response lost)");
          return result;
        },
      },
      { retryCount: 0 },
    );
    const logs: Record<string, unknown>[] = [];
    const wallets = new PlayerWallets(Uint8Array.from({ length: 32 }, (_, i) => 200 + i));
    const dripAmount = 10n ** 16n;
    const ledger = new ViemLedger({
      chain,
      gameAddress,
      operatorKey: OPERATOR_KEY,
      wallets,
      minBalance: 10n ** 15n,
      dripAmount,
      pollingMs: 50,
      retryDelayMs: 10,
      transport: flaky,
      log: (l) => logs.push(l),
    });
    const users = [701, 702, 703, 704, 705];
    const gameId = ("0x" + "88".repeat(32)) as Hex;
    const { commitRoles } = await import("@nox/shared/crypto-spec");
    const roles = users.map((u, i) => ({ player: wallets.address(u), role: (i === 0 ? "werewolf" : i === 1 ? "seer" : i === 2 ? "doctor" : "villager") as never }));
    ledger.startGame(gameId, ("0x" + "00".repeat(32)) as Hex, users, commitRoles(gameId, roles).root);
    await ledger.idle();

    expect(logs.filter((l) => l.event === "chain_error")).toEqual([]);
    expect(logs.filter((l) => l.event === "chain_retry").length).toBeGreaterThanOrEqual(3);
    // createGame's second copy landed; the third try saw AlreadyExists and took it as done.
    expect(logs).toContainEqual({ event: "chain_retry_done", what: "createGame", attempt: 3 });
    // The drip whose response was lost was not sent again: nobody holds two drips.
    expect(logs).toContainEqual({ event: "chain_retry_done", what: "gas drip", attempt: 2 });
    for (const u of users) expect(await publicClient.getBalance({ address: wallets.address(u) })).toBeLessThan(dripAmount);
    expect(await ledger.statusOf(gameId)).toBe(2); // Running: create, 5 joins and commitRoles all landed
  }, 60_000);

  it("gives up after three tries and cancels the game", async () => {
    const base = http(RPC)({ chain });
    const down = custom(
      {
        async request({ method, params }) {
          if (method === "eth_sendRawTransaction") throw new Error("fetch failed (node down)");
          return base.request({ method, params } as never);
        },
      },
      { retryCount: 0 },
    );
    const logs: Record<string, unknown>[] = [];
    const ledger = new ViemLedger({
      chain,
      gameAddress,
      operatorKey: OPERATOR_KEY,
      wallets: new PlayerWallets(Uint8Array.from({ length: 32 }, (_, i) => 230 + i)),
      minBalance: 10n ** 15n,
      dripAmount: 10n ** 16n,
      pollingMs: 50,
      retryDelayMs: 10,
      transport: down,
      log: (l) => logs.push(l),
    });
    ledger.startGame(("0x" + "99".repeat(32)) as Hex, ("0x" + "00".repeat(32)) as Hex, [801, 802, 803, 804, 805], ("0x" + "11".repeat(32)) as Hex);
    await ledger.idle();
    expect(logs.filter((l) => l.event === "chain_retry" && l.what === "createGame")).toHaveLength(2);
    expect(logs.filter((l) => l.event === "chain_error").map((l) => l.step)).toEqual(["start", "cancel"]);
  }, 60_000);

  it("indexes every game event and its credits match NoxCredits.balanceOf for each player", async () => {
    const store = new EventStore(":memory:");
    const indexer = new EventIndexer({
      client: publicClient as unknown as IndexerClient,
      store,
      contracts: [
        { name: "NoxGame", address: gameAddress, abi: NoxGameAbi as Abi },
        { name: "NoxCredits", address: creditsAddress, abi: NoxCreditsAbi as Abi },
      ],
      fromBlock: 0n,
      confirmations: 0n,
      chunk: 7n, // small chunks so the run crosses many chunk borders
    });
    await indexer.syncOnce();
    const board = store.leaderboard(1000);
    expect(board.length).toBeGreaterThanOrEqual(5);
    for (const row of board) {
      const onChain = await publicClient.readContract({ address: creditsAddress, abi: NoxCreditsAbi, functionName: "balanceOf", args: [row.account] });
      expect(BigInt(row.credits)).toBe(onChain);
    }
    expect(store.stats().finishedGames).toBeGreaterThanOrEqual(1);
    expect((await indexer.syncOnce()).events).toBe(0);
  }, 60_000);
});
