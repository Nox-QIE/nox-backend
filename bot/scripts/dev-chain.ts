/**
 * Local chain for development: starts anvil, deploys NoxCredits + NoxGame, plays two demo games
 * through the real GameRoom + ViemLedger, prints the env for nox-frontend, and keeps anvil running.
 *   node --import tsx bot/scripts/dev-chain.ts        (Ctrl+C to stop)
 */
import { spawn } from "node:child_process";
import { createPublicClient, createWalletClient, defineChain, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { NoxCreditsAbi, NoxCreditsBytecode, NoxGameAbi, NoxGameBytecode } from "../src/chain/contracts.js";
import { ViemLedger } from "../src/chain/viem-ledger.js";
import { PlayerWallets } from "../src/chain/wallets.js";
import { TemplateNarrator } from "../src/narrator.js";
import type { Keyboard, Messenger, Scheduler } from "../src/ports.js";
import { Registry } from "../src/registry.js";

const PORT = Number(process.env.DEV_CHAIN_PORT || 8545);
const RPC = `http://127.0.0.1:${PORT}`;
// Anvil's first well-known dev account. Local chain only.
const OPERATOR_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const chain = defineChain({ id: 31337, name: "Anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });

const anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "inherit" });
process.on("SIGINT", () => {
  anvil.kill();
  process.exit(0);
});

const pc = createPublicClient({ chain, transport: http(RPC), pollingInterval: 100 });
for (let i = 0; ; i++) {
  try {
    await pc.getChainId();
    break;
  } catch {
    if (i > 100) throw new Error("anvil did not start");
    await new Promise((r) => setTimeout(r, 100));
  }
}

const operator = privateKeyToAccount(OPERATOR_KEY);
const wallet = createWalletClient({ account: operator, chain, transport: http(RPC) });
const deploy = async (abi: never, bytecode: Hex, args: unknown[]) =>
  (await pc.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi, bytecode, args: args as never }) })).contractAddress!;
const credits = await deploy(NoxCreditsAbi as never, NoxCreditsBytecode, [operator.address]);
const game = await deploy(NoxGameAbi as never, NoxGameBytecode, [operator.address, operator.address, credits]);
const minter = await pc.readContract({ address: credits, abi: NoxCreditsAbi, functionName: "MINTER_ROLE" });
await pc.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: credits, abi: NoxCreditsAbi, functionName: "grantRole", args: [minter, game] }) });

const wallets = new PlayerWallets(Uint8Array.from({ length: 32 }, (_, i) => 7 + i));
const ledger = new ViemLedger({ chain, rpcUrl: RPC, gameAddress: game, operatorKey: OPERATOR_KEY, wallets, minBalance: 10n ** 15n, dripAmount: 10n ** 16n, pollingMs: 100, log: (l) => l.event === "chain_error" && console.error(JSON.stringify(l)) });

const dms = new Map<number, string[]>();
const messenger: Messenger = {
  sendGroup: async () => 1,
  editGroup: async () => true,
  sendDM: async (userId, html) => (dms.set(userId, [...(dms.get(userId) ?? []), html]), true),
};
const timers: (() => void)[] = [];
const scheduler: Scheduler = { schedule: (_ms, fn) => (timers.push(fn), () => undefined) };
const fire = async () => {
  const fns = timers.splice(0);
  fns.forEach((f) => f());
  await new Promise((r) => setTimeout(r, 0));
};

const names = ["Ava", "Ben", "Cy", "Dee", "Eli", "Fay", "Gus"];
async function demo(chatId: number, users: number[], villageWins: boolean) {
  const registry = new Registry({
    messenger,
    scheduler,
    timings: { lobbyMs: 1, nightMs: 1, discussionMs: 1, voteMs: 1 },
    // Fixed role deal so the demo always plays out the same way.
    randomInt: () => 0,
    botUsername: "nox_dev_bot",
    narratorFor: (lang) => new TemplateNarrator(lang),
    ledger,
  });
  users.forEach((u) => registry.markStarted(u));
  await registry.create(chatId, users[0]!, names[0]!, "en");
  const room = registry.roomOfChat(chatId)!;
  for (const [i, u] of users.slice(1).entries()) await registry.join(room.id, u, names[i + 1]!);
  await room.start(users[0]!);
  const by = (r: string) => users.filter((u) => room.roleOf(u) === r && room.isAlive(u));
  for (let round = 1; room.status === "running" && round < 10; round++) {
    const wolves = by("werewolf");
    const prey = users.filter((u) => room.isAlive(u) && room.roleOf(u) !== "werewolf");
    for (const w of wolves) await room.nightAction(w, round, String(prey[0]));
    for (const s of by("seer")) await room.nightAction(s, round, String(wolves[0]));
    for (const d of by("doctor")) await room.nightAction(d, round, String(villageWins ? prey[0] : d));
    if (room.status !== "running") break;
    await fire(); // discussion → vote
    const target = villageWins ? by("werewolf")[0]! : users.find((u) => room.isAlive(u) && room.roleOf(u) !== "werewolf")!;
    for (const u of users.filter((x) => room.isAlive(x))) await room.vote(u, round, String(target));
  }
  return { room, users };
}

const g1 = await demo(-1, [101, 102, 103, 104, 105], true);
const g2 = await demo(-2, [201, 202, 203, 204, 205, 206, 207], false);
await ledger.idle();

const sample = g1.users[1]!;
const salt = /<code>(0x[0-9a-f]{64})<\/code>/.exec(dms.get(sample)?.[0] ?? "")?.[1];
console.log(`
anvil running on ${RPC} (chain 31337). Ctrl+C to stop.

# nox-frontend/.env.local
NEXT_PUBLIC_CHAIN_ID=31337
NEXT_PUBLIC_RPC_URL=${RPC}
NEXT_PUBLIC_GAME_ADDRESS=${game}
NEXT_PUBLIC_CREDITS_ADDRESS=${credits}
NEXT_PUBLIC_FROM_BLOCK=0

Demo games:
  ${g1.room.gameId}  (${g1.room.status}, village should win)
  ${g2.room.gameId}  (${g2.room.status}, wolves should win)
Role check sample: address ${wallets.address(sample)}, role ${g1.room.roleOf(sample)}, salt ${salt}
`);
