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
import { EventIndexer, EventStore, reconcileCredits, reconcilePayments, type IndexerClient } from "../src/chain/indexer.js";
import { operatorFrom, registerAgentOnChain } from "../src/chain/operator.js";
import { settleMonth } from "../src/chain/settle.js";
import { gasLimitFor, rpcTransport, ViemLedger, type PlayerReward, type TxRecord } from "../src/chain/viem-ledger.js";
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
    const rewards: PlayerReward[] = [];
    const txs: TxRecord[] = [];
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
      onRewards: (_id, r) => rewards.push(...r),
      onTx: (t) => txs.push(t),
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
    // Credits formula (ADR-005): 10 to play, 20 for the winning village, +5 seer hit, +2 per vote for the wolf.
    expect(await balance(wolf!)).toBe(10n); // voted for itself: wolves get no vote bonus
    expect(await balance(seer!)).toBe(37n); // inspected the wolf + voted it
    expect(await balance(doctor!)).toBe(32n); // protected itself, not the wolf's pick: vote only
    expect(await balance(victim)).toBe(30n); // killed at night, never voted
    for (const u of role("villager").filter((u) => u !== victim)) expect(await balance(u)).toBe(32n);
    // The breakdown read back from RewardGranted (sent to each player by DM).
    expect(rewards.find((r) => r.userId === seer)).toEqual({ userId: seer, base: 30, role: 5, vote: 2, streak: 0, total: 37, streakDays: 1 });
    expect(rewards.find((r) => r.userId === wolf)).toMatchObject({ base: 10, role: 0, vote: 0, total: 10 });
    expect(rewards).toHaveLength(5);

    // Gas & transaction ledger (D14): every step of this game, each with its hash, gas and fee.
    const mine = txs.filter((t) => t.gameId === gameId);
    const count = (step: string) => mine.filter((t) => t.step === step).length;
    expect(count("createGame")).toBe(1);
    expect(count("joinGame")).toBe(5);
    expect(count("commitRoles")).toBe(1);
    expect(count("commitNightAction")).toBe(3);
    expect(count("revealAndFinalize")).toBe(1);
    expect(count("gas drip")).toBe(5);
    for (const t of mine) {
      expect(t).toMatchObject({ status: "success", attempts: 1, error: null });
      expect(t.hash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(t.gasUsed! > 0n && t.feeWei! > 0n).toBe(true);
    }
    expect(mine.filter((t) => t.step === "joinGame").map((t) => t.from).sort()).toEqual(users.map((u) => wallets.address(u)).sort());
    expect(mine.filter((t) => t.step === "gas drip").map((t) => t.to).sort()).toEqual(users.map((u) => wallets.address(u)).sort());

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
    const op = operatorFrom({ network: "local", rpcUrl: RPC, operatorKey: OPERATOR_KEY, dripWei: 0n, minWei: 0n, dailyPerPlayerWei: 0n, dailyBudgetWei: 0n, treasuryAlertWei: 0n, paymentsFromBlock: 0n }, 50);
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

    // A Game Night booked with the agent credits its owner 30% at payment time.
    const NATIVE = "0x0000000000000000000000000000000000000000" as const;
    const chainAgentId = BigInt(store.getAgent(agentId)!.chainAgentId!);
    await publicClient.waitForTransactionReceipt({
      hash: await hostWallet.writeContract({ address: payments, abi: NoxPaymentsAbi, functionName: "payGameNight", args: [("0x" + "b0".repeat(32)) as Hex, chainAgentId, NATIVE, 2n * 10n ** 18n], value: 2n * 10n ** 18n }),
    });

    // Revenue ledger from the events (F18-D05), reconciled with the contract at the indexed block.
    const index = new EventStore(":memory:");
    await new EventIndexer({
      client: publicClient as unknown as IndexerClient,
      store: index,
      contracts: [{ name: "NoxPayments", address: payments, abi: NoxPaymentsAbi as Abi }],
      fromBlock: 0n,
      confirmations: 0n,
    }).syncOnce();
    const ledger = index.paymentLedger();
    expect(ledger.agents).toEqual([{ agentId: Number(chainAgentId), owner, token: NATIVE, gameNights: 6n * 10n ** 17n, pool: 9n * 10n ** 17n, total: 15n * 10n ** 17n }]);
    expect(ledger.treasury).toEqual([{ token: NATIVE, passes: 4n * 10n ** 18n, gameNights: 14n * 10n ** 17n, pool: 9n * 10n ** 17n, withdrawn: 0n, balance: 45n * 10n ** 17n }]);
    const rec = await reconcilePayments(index, {
      ownerBalance: (o, t, blockNumber) => publicClient.readContract({ address: payments, abi: NoxPaymentsAbi, functionName: "ownerBalance", args: [o, t], blockNumber }),
      treasuryBalance: (t, blockNumber) => publicClient.readContract({ address: payments, abi: NoxPaymentsAbi, functionName: "treasuryBalance", args: [t], blockNumber }),
    });
    expect(rec).toMatchObject({ checked: 2, mismatches: [] });
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
    expect(gasLimitFor("createGame", 22088n)).toBe(110_000n); // broken estimate: fallback
    expect(gasLimitFor("createGame", 70_000n)).toBe(140_000n); // twice the estimate: free on QIE while estimate ≤ use
    // Finalize falls back to a size-based limit; the 12-player one covers the 1.65M measured in the contract tests.
    expect(gasLimitFor("revealAndFinalize", 300_000n, ["0x", new Array(5), new Array(3)])).toBe(60_000n + 625_000n + 54_000n);
    expect(gasLimitFor("revealAndFinalize", 400_000n, ["0x", new Array(12), new Array(25)])).toBeGreaterThan(1_650_000n);
    expect(gasLimitFor("revealAndFinalize", 1_000_000n, ["0x", new Array(5), new Array(3)])).toBe(2_000_000n);
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
    const txs: TxRecord[] = [];
    const ledger = new ViemLedger({
      chain,
      gameAddress,
      operatorKey: OPERATOR_KEY,
      onTx: (t) => txs.push(t),
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
    expect(txs.map((t) => [t.step, t.status, t.attempts, t.hash])).toEqual([
      ["createGame", "failed", 3, null],
      ["cancelGame", "failed", 3, null],
    ]);
  }, 60_000);

  /** A running 5-player game straight through the ledger, with its role reveals. */
  async function runningGame(seed: number, users: number[], gameId: Hex, extra: Partial<ConstructorParameters<typeof ViemLedger>[0]> = {}) {
    const logs: Record<string, unknown>[] = [];
    const settled: [Hex, string][] = [];
    const disputes: [Hex, string, string][] = [];
    const wallets = new PlayerWallets(Uint8Array.from({ length: 32 }, (_, i) => seed + i));
    const ledger = new ViemLedger({
      chain,
      rpcUrl: RPC,
      gameAddress,
      operatorKey: OPERATOR_KEY,
      wallets,
      minBalance: 10n ** 15n,
      dripAmount: 10n ** 16n,
      pollingMs: 50,
      retryDelayMs: 10,
      log: (l) => logs.push(l),
      onSettled: (id, outcome) => settled.push([id, outcome]),
      onDisputed: (id, reason, detail) => disputes.push([id, reason, detail]),
      ...extra,
    });
    const { commitRoles } = await import("@nox/shared/crypto-spec");
    const names = ["werewolf", "seer", "doctor", "villager", "villager"] as const;
    const codes = { villager: 1, werewolf: 2, seer: 3, doctor: 4 } as const;
    const c = commitRoles(gameId, users.map((u, i) => ({ player: wallets.address(u), role: names[i]! as never })));
    ledger.startGame(gameId, ("0x" + "00".repeat(32)) as Hex, users, c.root);
    await ledger.idle();
    const reveals = c.players.map((p, i) => ({ userId: users[i]!, role: codes[names[i]!], salt: p.salt as Hex, proof: p.proof as Hex[] }));
    return { ledger, logs, settled, disputes, reveals };
  }

  it("reports its own bad reveal on-chain as Disputed instead of cancelling, without retrying", async () => {
    const gameId = ("0x" + "d1".repeat(32)) as Hex;
    const { ledger, logs, settled, disputes, reveals } = await runningGame(260, [901, 902, 903, 904, 905], gameId);
    // A bug swaps one salt: the reveal no longer matches the committed root.
    const bad = reveals.map((r, i) => (i === 2 ? { ...r, salt: ("0x" + "ee".repeat(32)) as Hex } : r));
    ledger.finalize(gameId, bad, [], ("0x" + "01".repeat(32)) as Hex, 1);
    await ledger.idle();

    expect(await ledger.statusOf(gameId)).toBe(5); // Disputed
    expect(settled).toEqual([[gameId, "disputed"]]);
    expect(disputes).toEqual([[gameId, "reveal_mismatch", "BadReveal"]]);
    expect(logs.filter((l) => l.event === "chain_error")).toEqual([]);
    expect(logs.filter((l) => l.event === "chain_retry" && l.what === "revealAndFinalize")).toEqual([]);
    const events = await publicClient.getContractEvents({ address: gameAddress, abi: NoxGameAbi, eventName: "GameDisputed", args: { gameId } });
    expect(events[0]!.args).toMatchObject({ reason: 1, detail: "BadReveal" });
  }, 60_000);

  it("settles as disputed when anyone claimed the reveal timeout first", async () => {
    const gameId = ("0x" + "d2".repeat(32)) as Hex;
    const { ledger, settled, disputes, logs, reveals } = await runningGame(290, [911, 912, 913, 914, 915], gameId);
    // Anvil's second dev account plays a stranger who flags the silent game after 6 hours.
    const stranger = createWalletClient({ account: privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"), chain, transport: http(RPC) });
    await publicClient.request({ method: "evm_increaseTime" as never, params: [6 * 3600 + 1] as never });
    await publicClient.request({ method: "evm_mine" as never, params: [] as never });
    await publicClient.waitForTransactionReceipt({ hash: await stranger.writeContract({ address: gameAddress, abi: NoxGameAbi, functionName: "claimRevealTimeout", args: [gameId] }) });

    ledger.finalize(gameId, reveals, [], ("0x" + "01".repeat(32)) as Hex, 1);
    await ledger.idle();
    expect(settled).toEqual([[gameId, "disputed"]]);
    expect(disputes).toEqual([[gameId, "reveal_timeout", "claimed on-chain before the reveal"]]);
    expect(logs.filter((l) => l.event === "chain_error")).toEqual([]);
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
    const r = await reconcileCredits(store, (account, blockNumber) =>
      publicClient.readContract({ address: creditsAddress, abi: NoxCreditsAbi, functionName: "balanceOf", args: [account], blockNumber }),
    );
    expect(r.checked).toBeGreaterThanOrEqual(5);
    expect(r.mismatches).toEqual([]);
    expect(r.orphanMints).toBe(0);
    expect(store.stats().finishedGames).toBeGreaterThanOrEqual(1);
    expect((await indexer.syncOnce()).events).toBe(0);
  }, 60_000);
});
