/**
 * Plays one simulated 5-player game through the real GameRoom + ViemLedger on the chain in .env
 * (NOX_CHAIN=testnet|mainnet|local), without Telegram, and reports the on-chain result. Uses test
 * player ids 990001-990005, whose wallets are derived from NOX_WALLET_SECRET and funded by the
 * gas drip. Spends a little real QIE on testnet/mainnet.
 *   npm run sim:game
 */
import { buildLedger } from "../src/telegram.js";
import { loadChainConfig } from "../src/config.js";
import type { PlayerReward, ViemLedger } from "../src/chain/viem-ledger.js";
import { TemplateNarrator } from "../src/narrator.js";
import type { Messenger, Scheduler } from "../src/ports.js";
import { Registry } from "../src/registry.js";
import { SqliteStore } from "../src/store.js";
import { gasReport, qie } from "../src/treasury.js";

const chain = loadChainConfig();
if (chain.network === "off") throw new Error("set NOX_CHAIN in .env");
const logs: Record<string, unknown>[] = [];
const rewards: PlayerReward[] = [];
// The ledger's records go to an in-memory store, so the run can print its gas & transaction ledger.
const store = new SqliteStore(":memory:");
const ledger = buildLedger(
  chain,
  (l) => {
    logs.push(l);
    if (l.event === "chain_error") console.error(JSON.stringify(l));
  },
  { onRewards: (_id, r) => rewards.push(...r), onTx: (tx) => store.recordTx(tx), onOperatorBalance: (wei) => (operatorWei = wei) },
) as ViemLedger;
let operatorWei: bigint | null = null;

const messenger: Messenger = { sendGroup: async () => 1, editGroup: async () => true, sendDM: async () => true };
const timers: (() => void)[] = [];
const scheduler: Scheduler = { schedule: (_ms, fn) => (timers.push(fn), () => undefined) };
const fire = async () => {
  timers.splice(0).forEach((f) => f());
  await new Promise((r) => setTimeout(r, 0));
};

const registry = new Registry({
  messenger,
  scheduler,
  timings: { lobbyMs: 1, nightMs: 1, discussionMs: 1, voteMs: 1 },
  randomInt: () => 0,
  botUsername: "nox_sim",
  narratorFor: (lang) => new TemplateNarrator(lang),
  ledger,
});
const users = [990001, 990002, 990003, 990004, 990005];
users.forEach((u) => registry.markStarted(u));
await registry.create(-990, users[0]!, "Sim Host", "en");
const room = registry.roomOfChat(-990)!;
for (const u of users.slice(1)) await registry.join(room.id, u, `Sim ${u}`);

const t0 = Date.now();
await room.start(users[0]!);
const role = (r: string) => users.filter((u) => room.roleOf(u) === r && room.isAlive(u));
const wolf = role("werewolf")[0]!;
// Night 1: the wolf attacks, the doctor saves that player, the seer finds the wolf.
const target = role("villager")[0]!;
await room.nightAction(wolf, 1, String(target));
await room.nightAction(role("seer")[0]!, 1, String(wolf));
await room.nightAction(role("doctor")[0]!, 1, String(target));
await fire(); // discussion → vote
for (const u of users.filter((x) => room.isAlive(x))) await room.vote(u, 1, String(wolf));
console.log(`game ${room.gameId} ended in Telegram (${room.status}); waiting for the chain…`);
await ledger.idle();

const status = await ledger.statusOf(room.gameId!);
const drips = logs.filter((l) => l.event === "gas_drip").length;
console.log(`on-chain status ${status === 3 ? "Finalized" : status} after ${((Date.now() - t0) / 1000).toFixed(0)} s; gas drips ${drips}; chain errors ${logs.filter((l) => l.event === "chain_error").length}`);
console.log(`gameId ${room.gameId}`);
console.log(`players ${users.map((u) => ledger.addressOf(u)).join(", ")}`);
for (const r of rewards) console.log(`credits ${ledger.addressOf(r.userId)}: ${r.total} = base ${r.base} + role ${r.role} + vote ${r.vote} + streak ${r.streak} (streak ${r.streakDays} day(s))`);
for (const r of gasReport(store.txsOfGame(room.gameId!).map((t) => ({ ...t, at: Date.now() }))))
  console.log(`gas ${r.step}: ${r.txs} tx, ${r.gasUsed} gas, fee ${qie(r.feeWei, 12)} QIE${r.failed ? `, ${r.failed} not successful` : ""}`);
if (operatorWei !== null) console.log(`operator balance ${qie(operatorWei)} QIE`);
process.exitCode = status === 3 ? 0 : 1;
