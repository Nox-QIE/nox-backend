import { Bot, GrammyError, InlineKeyboard } from "grammy";
import { randomInt } from "node:crypto";
import type { Hex } from "viem";
import { esc, langFrom, T } from "./i18n.js";
import { noLedger, type GameLedger } from "./chain/ledger.js";
import { chainFor, ViemLedger, type PlayerReward, type ViemLedgerOptions } from "./chain/viem-ledger.js";
import { qie, TreasuryWatch } from "./treasury.js";
import { RateLimiter, rateLimitMiddleware } from "./ratelimit.js";
import { PlayerWallets } from "./chain/wallets.js";
import type { ChainConfig, Config, GmConfig } from "./config.js";
import { recoverGames } from "./recovery.js";
import { SqliteStore, storeKey, type Store } from "./store.js";
import { createGmModel } from "./gm/model.js";
import { GmModelPool } from "./gm/pool.js";
import { LlmNarrator } from "./gm/llm-narrator.js";
import { HEALTH, suspensionReason, type Persona } from "./agents.js";
import { TemplateNarrator, type Narrator, type NarratorReport, type Wording } from "./narrator.js";
import { realScheduler, type Keyboard, type Messenger } from "./ports.js";
import { Registry } from "./registry.js";
import { scenarioFrom } from "./scenarios.js";
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

export function narratorFactory(gm: GmConfig): (lang: "id" | "en", persona?: Persona, wording?: Wording) => Narrator {
  if (gm.mode === "template") return (lang, _persona, wording) => new TemplateNarrator(lang, wording);
  const pool = buildGmPool(gm);
  const log = (line: Record<string, unknown>) => console.log(JSON.stringify(line));
  // Each game (room) gets its own pick from the pool.
  return (lang, persona, wording) =>
    new LlmNarrator({
      model: pool.forGame(),
      lang,
      timeoutMs: gm.timeoutMs,
      log,
      ...(gm.price ? { price: gm.price } : {}),
      ...(persona ? { persona } : {}),
      ...(wording ? { wording } : {}),
    });
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

/** Callbacks the bot hangs on the ledger (store updates, alerts, DMs). */
export type LedgerHooks = Partial<Pick<ViemLedgerOptions, "onSettled" | "onDisputed" | "onRewards" | "onTx" | "onOperatorBalance">>;

export function buildLedger(c: ChainConfig, log = logLine, hooks: LedgerHooks = {}): GameLedger {
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
    ...hooks,
  });
}

/** Hooks that keep the store in step and alert people: settlement, disputes, rewards, D14, treasury. */
export function botLedgerHooks(a: {
  store: Store;
  messenger: Messenger;
  treasuryAlertWei: bigint;
  webUrl?: string;
  operatorChatId?: number;
  log?: (l: Record<string, unknown>) => void;
}): LedgerHooks {
  const log = a.log ?? logLine;
  const fail = (event: string, gameId?: Hex) => (e: unknown) => log({ event, ...(gameId ? { gameId } : {}), error: e instanceof Error ? e.message : String(e) });
  const watch = new TreasuryWatch({
    alertWei: a.treasuryAlertWei,
    snapshot: (wei) => a.store.recordOperatorBalance(wei),
    alert: (wei) => {
      log({ event: "treasury_low", wei: wei.toString() });
      if (a.operatorChatId) {
        void a.messenger
          .sendDM(a.operatorChatId, `⚠️ <b>Nox operator wallet is low</b>\nBalance: ${qie(wei)} QIE (alert below ${qie(a.treasuryAlertWei)} QIE). Gas drips and game transactions stop when it runs out.`)
          .catch(fail("treasury_alert_error"));
      }
    },
  });
  return {
    onSettled: (gameId, outcome) => a.store.setStatus(gameId, outcome),
    onDisputed: (gameId, reason, detail) =>
      void alertDispute({ messenger: a.messenger, store: a.store, gameId, reason, detail, ...(a.webUrl ? { webUrl: a.webUrl } : {}), ...(a.operatorChatId ? { operatorChatId: a.operatorChatId } : {}) }).catch(
        fail("dispute_alert_error", gameId),
      ),
    onRewards: (gameId, rewards) => void sendRewardDms({ messenger: a.messenger, store: a.store, gameId, rewards }).catch(fail("reward_dm_error", gameId)),
    onTx: (tx) => a.store.recordTx(tx),
    onOperatorBalance: (wei) => watch.observe(wei),
  };
}

/**
 * A game ended as Disputed (F08-S03): tell its group that the result is on hold and DM the operator.
 * The game's encrypted secrets stay in the store as evidence (disputed games are never purged).
 */
export async function alertDispute(a: {
  messenger: Messenger;
  store: Store;
  gameId: Hex;
  reason: string;
  detail: string;
  webUrl?: string;
  operatorChatId?: number;
}) {
  const g = a.store.gameInfo(a.gameId);
  const url = a.webUrl ? `${a.webUrl.replace(/\/+$/, "")}/game/?id=${a.gameId}` : null;
  if (g) await a.messenger.sendGroup(g.chatId, T[g.lang].disputed(url));
  if (a.operatorChatId) {
    await a.messenger.sendDM(
      a.operatorChatId,
      `🚨 <b>Nox incident: game disputed</b>\nGame: <code>${a.gameId}</code>\nReason: ${a.reason} (${a.detail})\nGroup: ${g ? g.chatId : "unknown"}\nThe encrypted reveal data is kept in the store for investigation.`,
    );
  }
}

/** F08-S08: after finalize, DM each player their credits breakdown in the game's language. */
export async function sendRewardDms(a: { messenger: Messenger; store: Store; gameId: Hex; rewards: PlayerReward[] }) {
  const lang = a.store.gameInfo(a.gameId)?.lang ?? "en";
  for (const r of a.rewards) await a.messenger.sendDM(r.userId, T[lang].rewardDm(r));
}

/**
 * After a game narrated by a Marketplace agent: keep its health record and suspend it automatically
 * when it keeps failing (F18-S11), with a moderation note (F18-D06), a log line and an operator DM.
 */
export function onAgentGame(a: { store: Store; messenger: Messenger; operatorChatId?: number; log?: (l: Record<string, unknown>) => void }) {
  const log = a.log ?? logLine;
  return (agentId: number, report: NarratorReport) => {
    a.store.recordAgentGame(agentId, report);
    const agent = a.store.getAgent(agentId);
    if (!agent || agent.status !== "active") return;
    const reason = suspensionReason(a.store.agentGames(agentId, HEALTH.window));
    if (!reason) return;
    a.store.setAgentStatus(agentId, "suspended");
    a.store.addModeration(agentId, "suspended", reason, "auto");
    log({ event: "agent_suspended", agentId, reason });
    if (a.operatorChatId) {
      void a.messenger
        .sendDM(a.operatorChatId, `⛔ <b>Agent #${agentId} "${esc(agent.persona.name)}" suspended automatically</b>\nReason: ${esc(reason)}\nReview it, then: agents.ts activate ${agentId} "<reason>"`)
        .catch((e) => log({ event: "agent_alert_error", agentId, error: e instanceof Error ? e.message : String(e) }));
    }
  };
}

/** Wire Telegram updates to the registry. Nox stays a regular bot: no Mini App / Web App buttons. */
export async function createNoxBot({ botToken, dbPath, webUrl, operatorChatId, timings, gm, chain, rateLimit }: Config) {
  const bot = new Bot(botToken);
  await bot.init();
  // First middleware: refused updates never reach the game.
  bot.use(rateLimitMiddleware(new RateLimiter(rateLimit), (ctx) => T[langFrom(ctx.from?.language_code)].slowDown, logLine));
  const messenger = telegramMessenger(bot);
  const store = new SqliteStore(dbPath, chain.walletSecret ? storeKey(chain.walletSecret) : null);
  const ledger = buildLedger(
    chain,
    logLine,
    botLedgerHooks({ store, messenger, treasuryAlertWei: chain.treasuryAlertWei, ...(webUrl ? { webUrl } : {}), ...(operatorChatId ? { operatorChatId } : {}) }),
  );
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
    onAgentGame: onAgentGame({ store, messenger, ...(operatorChatId ? { operatorChatId } : {}) }),
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
    // "/newgame scamshield" starts Scam Shield; "/newgame horor" preselects a theme (LLM GM only).
    const scenario = scenarioFrom(ctx.match);
    const theme = !scenario && gm.mode === "llm" ? themeIdFrom(ctx.match) : null;
    const r = await registry.create(ctx.chat.id, ctx.from.id, displayName(ctx.from), lang, {
      ...(theme !== null ? { agentId: theme } : {}),
      ...(scenario ? { scenario } : {}),
    });
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
