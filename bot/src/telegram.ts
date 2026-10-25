import { Bot, GrammyError, InlineKeyboard } from "grammy";
import { randomInt } from "node:crypto";
import { langFrom, T } from "./i18n.js";
import { noLedger, type GameLedger } from "./chain/ledger.js";
import { chainFor, ViemLedger } from "./chain/viem-ledger.js";
import { PlayerWallets } from "./chain/wallets.js";
import type { ChainConfig, Config, GmConfig } from "./config.js";
import { recoverGames } from "./recovery.js";
import { SqliteStore, storeKey, type Store } from "./store.js";
import { createGmModel } from "./gm/model.js";
import { GmModelPool } from "./gm/pool.js";
import { LlmNarrator } from "./gm/llm-narrator.js";
import type { Persona } from "./agents.js";
import { TemplateNarrator, type Narrator } from "./narrator.js";
import { realScheduler, type Keyboard, type Messenger } from "./ports.js";
import { Registry } from "./registry.js";
import { THEME_AGENTS, themeIdFrom } from "./themes.js";

function opts(keyboard?: Keyboard) {
  if (!keyboard) return { parse_mode: "HTML" as const };
  const kb = new InlineKeyboard();
  keyboard.forEach((row, i) => {
    for (const b of row) kb.text(b.text, b.data);
    if (i < keyboard.length - 1) kb.row();
  });
  return { parse_mode: "HTML" as const, reply_markup: kb };
}

export function telegramMessenger(bot: Bot): Messenger {
  return {
    async sendGroup(chatId, html, keyboard) {
      const m = await bot.api.sendMessage(chatId, html, opts(keyboard));
      return m.message_id;
    },
    async editGroup(chatId, messageId, html, keyboard) {
      try {
        await bot.api.editMessageText(chatId, messageId, html, opts(keyboard));
        return true;
      } catch {
        return false;
      }
    },
    async sendDM(userId, html, keyboard) {
      try {
        await bot.api.sendMessage(userId, html, opts(keyboard));
        return true;
      } catch (e) {
        // 403: the user never pressed Start or blocked the bot.
        if (e instanceof GrammyError && e.error_code === 403) return false;
        throw e;
      }
    },
  };
}

export const displayName = (u: { first_name: string; last_name?: string; username?: string }) =>
  [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || "?";

const stripTags = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

export function narratorFactory(gm: GmConfig): (lang: "id" | "en", persona?: Persona) => Narrator {
  if (gm.mode === "template") return (lang) => new TemplateNarrator(lang);
  const pool = buildGmPool(gm);
  const log = (line: Record<string, unknown>) => console.log(JSON.stringify(line));
  // Each game (room) gets its own pick from the pool.
  return (lang, persona) =>
    new LlmNarrator({ model: pool.forGame(), lang, timeoutMs: gm.timeoutMs, log, ...(gm.price ? { price: gm.price } : {}), ...(persona ? { persona } : {}) });
}

export function buildGmPool(gm: GmConfig): GmModelPool {
  const entries = gm.pool.map((e) => ({
    label: `${e.provider}:${e.model}`,
    weight: e.weight,
    model: createGmModel({
      provider: e.provider,
      model: e.model,
      ...(gm.baseURL ? { baseURL: gm.baseURL } : {}),
      ...(gm.authToken ? { authToken: gm.authToken } : {}),
    }),
  }));
  return new GmModelPool(entries, (max) => randomInt(max));
}



const logLine = (l: Record<string, unknown>) => console.log(JSON.stringify(l));

export function buildLedger(c: ChainConfig, log = logLine, store?: Store): GameLedger {
  if (c.network === "off") return noLedger;
  return new ViemLedger({
    chain: chainFor(c.network),
    ...(c.rpcUrl ? { rpcUrl: c.rpcUrl } : {}),
    gameAddress: c.gameAddress!,
    operatorKey: c.operatorKey!,
    wallets: PlayerWallets.fromHex(c.walletSecret!),
    minBalance: c.minWei,
    dripAmount: c.dripWei,
    dripDailyCapPerPlayer: c.dailyPerPlayerWei,
    dripDailyBudget: c.dailyBudgetWei,
    log,
    ...(store ? { onSettled: (gameId, outcome) => store.setStatus(gameId, outcome) } : {}),
  });
}

/** Wire Telegram updates to the registry. Nox stays a regular bot: no Mini App / Web App buttons. */
export async function createNoxBot({ botToken, dbPath, webUrl, timings, gm, chain }: Config) {
  const bot = new Bot(botToken);
  await bot.init();
  const messenger = telegramMessenger(bot);
  const store = new SqliteStore(dbPath, chain.walletSecret ? storeKey(chain.walletSecret) : null);
  const ledger = buildLedger(chain, logLine, store);
  const registry = new Registry({
    messenger,
    scheduler: realScheduler,
    timings,
    randomInt: (max) => randomInt(max),
    botUsername: bot.botInfo.username,
    narratorFor: narratorFactory(gm),
    // Personas need an LLM; with template narration there is nothing to pick.
    ...(gm.mode === "llm" ? { agents: () => [...THEME_AGENTS, ...store.listAgents(true)] } : {}),
    ledger,
    store,
    ...(webUrl ? { webUrl } : {}),
  });
  await recoverGames(store, ledger, messenger, logLine);

  bot.command("start", async (ctx) => {
    if (ctx.chat.type !== "private" || !ctx.from) return;
    registry.markStarted(ctx.from.id);
    await ctx.reply(T[langFrom(ctx.from.language_code)].welcome, { parse_mode: "HTML" });
  });

  bot.command(["privacy", "privasi"], async (ctx) => {
    if (!ctx.from) return;
    const url = webUrl ? `${webUrl.replace(/\/+$/, "")}/privacy/` : null;
    await ctx.reply(T[langFrom(ctx.from.language_code)].privacy(url), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  });

  bot.command(["forget", "lupakan"], async (ctx) => {
    if (ctx.chat.type !== "private" || !ctx.from) return;
    const t = T[langFrom(ctx.from.language_code)];
    await ctx.reply(t.forgetAsk, { reply_markup: new InlineKeyboard().text(t.forgetBtn, "f:yes") });
  });

  bot.command("newgame", async (ctx) => {
    if (!ctx.from) return;
    const lang = langFrom(ctx.from.language_code);
    if (ctx.chat.type === "private") return void (await ctx.reply(T[lang].groupOnly));
    // "/newgame horor" preselects a Nox theme (needs the LLM Game Master).
    const theme = gm.mode === "llm" ? themeIdFrom(ctx.match) : null;
    const r = await registry.create(ctx.chat.id, ctx.from.id, displayName(ctx.from), lang, theme ?? undefined);
    if (!r.ok && r.text) await ctx.reply(r.text, { parse_mode: "HTML" });
  });

  // Callback data: j:<room> | s:<room> | a:<room>:<agentId> | n:<room>:<round>:<target> | v:<room>:<round>:<target>
  bot.on("callback_query:data", async (ctx) => {
    const [kind, roomId, roundStr, target] = ctx.callbackQuery.data.split(":");
    if (kind === "f") {
      const t = T[langFrom(ctx.from.language_code)];
      const done = registry.forgetUser(ctx.from.id);
      await ctx.answerCallbackQuery({ text: done ? t.forgetDone : t.forgetBusy });
      if (done) await ctx.editMessageText(t.forgetDone).catch(() => undefined);
      return;
    }
    const room = roomId ? registry.get(roomId) : undefined;
    const user = ctx.from;
    const round = Number(roundStr);
    let reply: { ok: boolean; text?: string } = { ok: false, text: T.en.stale };
    if (room) {
      if (kind === "j") reply = await registry.join(room.id, user.id, displayName(user));
      else if (kind === "s") reply = await room.start(user.id);
      else if (kind === "a") reply = await room.pickAgent(user.id, Number(roundStr));
      else if (kind === "n" && target) reply = await room.nightAction(user.id, round, target);
      else if (kind === "v" && target) reply = await room.vote(user.id, round, target);
    }
    await ctx.answerCallbackQuery(reply.text ? { text: stripTags(reply.text) } : undefined);
  });

  bot.on("message:text", async (ctx) => {
    if (ctx.chat.type !== "private") return;
    registry.markStarted(ctx.from.id);
    const room = registry.roomOfUser(ctx.from.id);
    if (room) await room.wolfChat(ctx.from.id, ctx.message.text);
  });

  bot.catch((err) => console.error("bot error", err.error));
  return { bot, registry };
}
