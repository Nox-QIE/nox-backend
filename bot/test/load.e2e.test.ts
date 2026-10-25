/**
 * F11-S08 load test: 12 players vote at once and every vote must be on-chain within 30 seconds,
 * on a local chain with QIE-like block times (measured 25 Oct 2026: mainnet 3.6 s, testnet 4.3 s).
 */
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { commitRoles, randomBytes32 } from "@nox/shared/crypto-spec";
import { createPublicClient, createWalletClient, defineChain, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NoxCreditsAbi, NoxCreditsBytecode, NoxGameAbi, NoxGameBytecode } from "../src/chain/contracts.js";
import { ViemLedger } from "../src/chain/viem-ledger.js";
import { PlayerWallets } from "../src/chain/wallets.js";

const hasAnvil = (() => {
  try {
    execSync("anvil --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const BLOCK_SECONDS = 4;
const OPERATOR_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // anvil dev account
const PORT = 9200 + Math.floor(Math.random() * 300);
const RPC = `http://127.0.0.1:${PORT}`;
const chain = defineChain({ id: 31337, name: "Anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pc = createPublicClient({ chain, transport: http(RPC), pollingInterval: 200 });
let anvil: ChildProcess;
let game: Address;

describe.skipIf(!hasAnvil)(`load: 12 players, ${BLOCK_SECONDS}s blocks`, () => {
  beforeAll(async () => {
    anvil = spawn("anvil", ["--port", String(PORT), "--block-time", String(BLOCK_SECONDS), "--silent"], { stdio: "ignore" });
    for (let i = 0; i < 100; i++) {
      try {
        await pc.getChainId();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const op = privateKeyToAccount(OPERATOR_KEY);
    const w = createWalletClient({ account: op, chain, transport: http(RPC) });
    const deploy = async (abi: never, bytecode: Hex, args: unknown[]) =>
      (await pc.waitForTransactionReceipt({ hash: await w.deployContract({ abi, bytecode, args: args as never }) })).contractAddress!;
    const credits = await deploy(NoxCreditsAbi as never, NoxCreditsBytecode, [op.address]);
    game = await deploy(NoxGameAbi as never, NoxGameBytecode, [op.address, op.address, credits]);
  }, 60_000);

  afterAll(() => {
    anvil?.kill();
  });

  it("gets a 12-player game on-chain and lands 12 simultaneous votes within 30 s", async () => {
    const logs: Record<string, unknown>[] = [];
    const wallets = new PlayerWallets(Uint8Array.from({ length: 32 }, (_, i) => 50 + i));
    const ledger = new ViemLedger({
      chain,
      rpcUrl: RPC,
      gameAddress: game,
      operatorKey: OPERATOR_KEY,
      wallets,
      minBalance: 10n ** 15n,
      dripAmount: 10n ** 16n,
      pollingMs: 200,
      log: (l) => logs.push(l),
    });
    const users = Array.from({ length: 12 }, (_, i) => 1000 + i);
    const gameId = randomBytes32();
    const roles = users.map((u, i) => ({ player: wallets.address(u), role: (i < 3 ? "werewolf" : i === 3 ? "seer" : i === 4 ? "doctor" : "villager") as never }));

    let t = Date.now();
    ledger.startGame(gameId, randomBytes32(), users, commitRoles(gameId, roles).root);
    await ledger.idle();
    const startSeconds = (Date.now() - t) / 1000;

    t = Date.now();
    for (const u of users) ledger.castVote(gameId, 1, u, users[0]!);
    await ledger.idle();
    const voteSeconds = (Date.now() - t) / 1000;

    console.log(`12-player start (create + 12 drips + 12 joins + commitRoles): ${startSeconds.toFixed(1)} s; 12 votes: ${voteSeconds.toFixed(1)} s`);
    expect(logs.filter((l) => l.event === "chain_error")).toEqual([]);
    for (const u of users) {
      expect(await pc.readContract({ address: game, abi: NoxGameAbi, functionName: "voteOf", args: [gameId, 1, wallets.address(u)] })).toBe(wallets.address(users[0]!));
    }
    expect(voteSeconds).toBeLessThan(30);
    expect(startSeconds).toBeLessThan(45);
  }, 180_000);
});
