/**
 * End-to-end playtest without five people: the real bot (grammY handlers, rooms, Game Master, chain
 * ledger on QIE) receives Telegram updates from five simulated players, as if they tapped the
 * buttons themselves. Every call the bot makes to Telegram is intercepted and printed as a
 * transcript; with --chat <id>, the group's messages also go to that real Telegram group so a person
 * can watch the game there (DMs to the simulated players never leave this process).
 *   node --env-file=.env --import tsx bot/scripts/sim-telegram.ts [--scamshield | --theme horor] [--chat -100…] [--lang en]
 * Uses BOT_TOKEN, the chain and GM settings from .env, a throwaway store, and short day timers.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, type Hex } from "viem";
import { NoxGameAbi } from "../src/chain/contracts.js";
import { chainFor, rpcTransport } from "../src/chain/viem-ledger.js";
import { loadConfig } from "../src/config.js";
import { installLogRedaction, secretsFrom } from "../src/redact.js";
import type { GameRoom } from "../src/room.js";
import { createNoxBot } from "../src/telegram.js";

installLogRedaction(secretsFrom(process.env));
const argv = process.argv.slice(2);
const flag = (name: string) => (argv.includes(`--${name}`) ? (argv[argv.indexOf(`--${name}`) + 1] ?? "") : undefined);
const lang = flag("lang") === "en" ? "en" : "id";
const realChat = flag("chat") ? Number(flag("chat")) : null;
const mode = argv.includes("--scamshield") ? "scamshield" : (flag("theme") ?? "");

const config = loadConfig();
config.dbPath = join(tmpdir(), `nox-sim-telegram-${Date.now()}.db`);
// Discussion would wait 90 s for people to talk; the simulated players vote right away.
config.timings = { ...config.timings, discussionMs: 5_000, voteMs: 120_000, nightMs: 120_000 };

const GROUP = -1_000_555_000_001;
const players = [
  { id: 880_000_001, name: "Ava" },
  { id: 880_000_002, name: "Ben" },
  { id: 880_000_003, name: "Cy" },
  { id: 880_000_004, name: "Dee" },
  { id: 880_000_005, name: "Eli" },
];
const nameOf = new Map(players.map((p) => [p.id, p.name]));
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s`;
const plain = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

interface Sent {
  to: "group" | number;
  text: string;
  buttons: { text: string; data: string }[];
}
const sent: Sent[] = [];
let messageId = 1;

const { bot, registry } = await createNoxBot(config);

// Every outgoing Telegram call lands here first: recorded, and only group messages may go out.
bot.api.config.use(async (prev, method, payload, signal) => {
  const p = payload as Record<string, unknown>;
  const chat = Number(p.chat_id);
  const keyboard = (p.reply_markup as { inline_keyboard?: { text: string; callback_data?: string }[][] } | undefined)?.inline_keyboard ?? [];
  const buttons = keyboard.flat().map((b) => ({ text: b.text, data: b.callback_data ?? "" }));
  if (method === "sendMessage" || method === "editMessageText") {
    const to = chat === GROUP ? "group" : chat;
    sent.push({ to, text: String(p.text), buttons });
    const who = to === "group" ? "GROUP" : `DM ${nameOf.get(chat) ?? chat}`;
    console.log(`${stamp()} ${method === "editMessageText" ? "✎" : "→"} ${who}: ${plain(String(p.text)).replace(/\n+/g, " ⏎ ").slice(0, 400)}${buttons.length ? `  [${buttons.map((b) => b.text).join(" | ")}]` : ""}`);
  } else if (method === "answerCallbackQuery" && p.text) {
    console.log(`${stamp()}   ↳ toast: ${plain(String(p.text))}`);
  }
  if (realChat !== null && chat === GROUP) {
    return prev(method, { ...payload, chat_id: realChat } as typeof payload, signal);
  }
  const result = method === "sendMessage" ? { message_id: messageId++, date: Math.floor(Date.now() / 1000), chat: { id: chat, type: "private" }, text: String(p.text) } : true;
  return { ok: true, result } as never;
});

let updateId = 1;
const user = (id: number) => ({ id, is_bot: false, first_name: nameOf.get(id)!, language_code: lang });
const groupChat = { id: GROUP, type: "group" as const, title: "Nox playtest" };
const command = (from: number, text: string, chat: object) =>
  bot.handleUpdate({
    update_id: updateId++,
    message: { message_id: messageId++, date: Math.floor(Date.now() / 1000), chat, from: user(from), text, entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] },
  } as never);
const tap = (from: number, data: string, chat: object) =>
  bot.handleUpdate({
    update_id: updateId++,
    callback_query: { id: String(updateId), from: user(from), chat_instance: "sim", data, message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat } },
  } as never);
const until = async (what: string, ok: () => boolean, ms = 180_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
};

console.log(`Simulated playtest with @${bot.botInfo.username}: ${players.map((p) => p.name).join(", ")} (${lang}${mode ? `, ${mode}` : ""})${realChat ? `, mirrored to chat ${realChat}` : ""}\n`);

// 1. Everyone presses Start in a private chat with the bot.
for (const p of players) await command(p.id, "/start", { id: p.id, type: "private", first_name: p.name });

// 2. The host opens a lobby in the group; the others join; the host starts.
const host = players[0]!.id;
await command(host, `/newgame${mode ? ` ${mode}` : ""}`, groupChat);
await until("the lobby", () => !!registry.roomOfChat(GROUP));
const room: GameRoom = registry.roomOfChat(GROUP)!;
for (const p of players.slice(1)) await tap(p.id, `j:${room.id}`, groupChat);
await tap(host, `s:${room.id}`, groupChat);
await until("the game to start", () => room.status !== "lobby");

// 3. Night 1: the werewolf attacks a villager, the doctor protects that villager, the seer checks the wolf.
const role = (r: string) => players.map((p) => p.id).filter((id) => room.roleOf(id) === r && room.isAlive(id));
const wolf = role("werewolf")[0]!;
const victim = role("villager")[0]!;
console.log(`\n${stamp()} (roles dealt: ${players.map((p) => `${p.name}=${room.roleOf(p.id)}`).join(", ")})\n`);
await tap(wolf, `n:${room.id}:1:${victim}`, { id: wolf, type: "private" });
await tap(role("seer")[0]!, `n:${room.id}:1:${wolf}`, { id: role("seer")[0]!, type: "private" });
await tap(role("doctor")[0]!, `n:${room.id}:1:${victim}`, { id: role("doctor")[0]!, type: "private" });

// 4. Day 1: once the vote opens, every living player votes for the werewolf.
await until("the vote", () => sent.some((s) => s.to === "group" && s.buttons.some((b) => b.data.startsWith(`v:${room.id}:1:`))));
for (const id of players.map((p) => p.id).filter((x) => room.isAlive(x))) await tap(id, `v:${room.id}:1:${wolf}`, groupChat);
await until("the end of the game", () => room.status === "ended");

// 5. The chain: the game should be finalized on QIE and each player DMed their credits.
const gameId = room.gameId as Hex | null;
if (config.chain.network !== "off" && gameId && config.chain.gameAddress) {
  const chain = chainFor(config.chain.network);
  const client = createPublicClient({ chain, transport: rpcTransport(chain, config.chain.rpcUrl) });
  const status = async () => Number((await client.readContract({ address: config.chain.gameAddress!, abi: NoxGameAbi, functionName: "games", args: [gameId] }))[0]);
  const end = Date.now() + 240_000;
  let s = await status();
  while (s !== 3 && s !== 4 && s !== 5 && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 2_000));
    s = await status();
  }
  await until("the reward DMs", () => players.every((p) => sent.some((m) => m.to === p.id && /Nox Credits/.test(m.text))), 60_000).catch(() => undefined);
  console.log(`\n${stamp()} on chain: game ${gameId} status ${["None", "Lobby", "Running", "Finalized", "Cancelled", "Disputed"][s] ?? s}`);
}
const dms = sent.filter((s) => s.to !== "group").length;
console.log(`${stamp()} done: ${sent.filter((s) => s.to === "group").length} group messages, ${dms} DMs, room ${room.status}`);
process.exit(0);
