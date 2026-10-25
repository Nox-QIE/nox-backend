import { execSync, spawn, type ChildProcess } from "node:child_process";
import { createPublicClient, createWalletClient, defineChain, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NoxCreditsAbi, NoxCreditsBytecode, NoxGameAbi, NoxGameBytecode } from "../src/chain/contracts.js";
import { ViemLedger } from "../src/chain/viem-ledger.js";
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
});
