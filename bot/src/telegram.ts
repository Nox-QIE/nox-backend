import { Bot, GrammyError, InlineKeyboard } from "grammy";
import { randomInt } from "node:crypto";
import { langFrom, T } from "./i18n.js";
import type { Config, GmConfig } from "./config.js";
import { createGmModel } from "./gm/model.js";
import { LlmNarrator } from "./gm/llm-narrator.js";
import { TemplateNarrator, type Narrator } from "./narrator.js";
import { realScheduler, type Keyboard, type Messenger } from "./ports.js";
import { Registry } from "./registry.js";

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

export function narratorFactory(gm: GmConfig): (lang: "id" | "en") => Narrator {
  if (gm.mode === "template") return (lang) => new TemplateNarrator(lang);
  const model = createGmModel(gm);
  const log = (line: Record<string, unknown>) => console.log(JSON.stringify(line));
  return (lang) => new LlmNarrator({ model, lang, timeoutMs: gm.timeoutMs, log, ...(gm.price ? { price: gm.price } : {}) });
}

/** Wire Telegram updates to the registry. Nox stays a regular bot: no Mini App / Web App buttons. */
export async function createNoxBot({ botToken, timings, gm }: Config) {
  const bot = new Bot(botToken);
  await bot.init();
  const registry = new Registry({
    messenger: telegramMessenger(bot),
    scheduler: realScheduler,
    timings,
    randomInt: (max) => randomInt(max),
    botUsername: bot.botInfo.username,
    narratorFor: narratorFactory(gm),
  });

  bot.command("start", async (ctx) => {
    if (ctx.chat.type !== "private" || !ctx.from) return;
    registry.startedUsers.add(ctx.from.id);
    await ctx.reply(T[langFrom(ctx.from.language_code)].welcome, { parse_mode: "HTML" });
  });

  bot.command("newgame", async (ctx) => {
    if (!ctx.from) return;
    const lang = langFrom(ctx.from.language_code);
    if (ctx.chat.type === "private") return void (await ctx.reply(T[lang].groupOnly));
    const r = await registry.create(ctx.chat.id, ctx.from.id, displayName(ctx.from), lang);
    if (!r.ok && r.text) await ctx.reply(r.text, { parse_mode: "HTML" });
  });

  // Callback data: j:<room> | s:<room> | n:<room>:<round>:<target> | v:<room>:<round>:<target>
  bot.on("callback_query:data", async (ctx) => {
    const [kind, roomId, roundStr, target] = ctx.callbackQuery.data.split(":");
    const room = roomId ? registry.get(roomId) : undefined;
    const user = ctx.from;
    const round = Number(roundStr);
    let reply: { ok: boolean; text?: string } = { ok: false, text: T.en.stale };
    if (room) {
      if (kind === "j") reply = await registry.join(room.id, user.id, displayName(user));
      else if (kind === "s") reply = await room.start(user.id);
      else if (kind === "n" && target) reply = await room.nightAction(user.id, round, target);
      else if (kind === "v" && target) reply = await room.vote(user.id, round, target);
    }
    await ctx.answerCallbackQuery(reply.text ? { text: stripTags(reply.text) } : undefined);
  });

  bot.on("message:text", async (ctx) => {
    if (ctx.chat.type !== "private") return;
    registry.startedUsers.add(ctx.from.id);
    const room = registry.roomOfUser(ctx.from.id);
    if (room) await room.wolfChat(ctx.from.id, ctx.message.text);
  });

  bot.catch((err) => console.error("bot error", err.error));
  return { bot, registry };
}
