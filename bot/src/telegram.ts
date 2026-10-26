import { Bot, GrammyError, InlineKeyboard } from "grammy";
import { randomInt } from "node:crypto";
import { createPublicClient, formatUnits, type Address, type Hex } from "viem";
import { esc, langFrom, T, type Lang, type PlayerStatsLite } from "./i18n.js";
import { noLedger, type GameLedger } from "./chain/ledger.js";
import { chainFor, rpcTransport, ViemLedger, type PlayerReward, type ViemLedgerOptions } from "./chain/viem-ledger.js";
import { HOST_PASS, PassReader, type PassClient } from "./chain/passes.js";
import { countryGuess, parseCountry, payRail, type PayRail } from "./pay-rail.js";
import { LOGIN_TTL_S, loginLink, loginToken } from "./login.js";
import { GameNights } from "./gamenight.js";
import { Practice, PRACTICE, PRACTICE_PAYLOADS, practiceLink } from "./practice.js";
import { AlertMonitor } from "./alerts.js";
import { qie, TreasuryWatch } from "./treasury.js";
import { RateLimiter, rateLimitMiddleware } from "./ratelimit.js";
import { PlayerWallets } from "./chain/wallets.js";
import type { ChainConfig, Config, GmConfig } from "./config.js";
import { recoverGames } from "./recovery.js";
import { SqliteStore, storeKeyring, type Store } from "./store.js";
import { createGmModel } from "./gm/model.js";
import { GmModelPool } from "./gm/pool.js";
import { LlmNarrator } from "./gm/llm-narrator.js";
import { HEALTH, suspensionReason, type AgentRecord, type Persona } from "./agents.js";
import { EndpointModel } from "./gm/endpoint.js";
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

export function narratorFactory(
  gm: GmConfig,
  /** The signing secret of an endpoint agent (F18-S10), read from the store only when a game needs it. */
  endpointSecret?: (agentId: number) => string | null,
): (lang: "id" | "en", persona?: Persona, wording?: Wording, agent?: AgentRecord) => Narrator {
  if (gm.mode === "template") return (lang, _persona, wording) => new TemplateNarrator(lang, wording);
  const pool = buildGmPool(gm);
  const log = (line: Record<string, unknown>) => logLine(line);
  // Each game (room) gets its own pick from the pool.
  return (lang, persona, wording, agent) => {
    const secret = agent?.mode === "endpoint" && agent.endpoint ? endpointSecret?.(agent.id) : null;
    const personaModel = secret && agent?.endpoint ? new EndpointModel({ agentId: agent.id, url: agent.endpoint, secret, lang }) : undefined;
    return new LlmNarrator({
      model: pool.forGame(),
      lang,
      timeoutMs: gm.timeoutMs,
      log,
      ...(gm.price ? { price: gm.price } : {}),
      ...(persona ? { persona } : {}),
      ...(personaModel ? { personaModel } : {}),
      ...(wording ? { wording } : {}),
    });
  };
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



/** Error-rate alerts (APP-08): set when the bot starts with an operator to tell. */
let alertMonitor: AlertMonitor | null = null;
const logLine = (l: Record<string, unknown>) => {
  console.log(JSON.stringify(l));
  alertMonitor?.observe(l);
};

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
    ...(c.badgesAddress ? { badgesAddress: c.badgesAddress } : {}),
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

/** A player's public stats from the indexer API (D7 mirror), or null when it is not reachable. */
export function statsFromApi(apiUrl: string, timeoutMs = 2000) {
  return async (address: string): Promise<PlayerStatsLite | null> => {
    const res = await fetch(`${apiUrl}/v1/players/${address}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = (await res.json()) as { stats?: PlayerStatsLite | null };
    return body.stats ?? null;
  };
}

/**
 * /start in a private chat (F01-S01): create or update the D1 account (locale, derived wallet
 * address), allow DMs, then greet. A returning player gets their stats (F01-S06) when the indexer
 * API answers; otherwise a plain welcome back. Idempotent: pressing Start again never duplicates.
 */
export async function startReply(a: {
  registry: Registry;
  store?: Store;
  ledger: GameLedger;
  userId: number;
  lang: Lang;
  statsFor?: (address: string) => Promise<PlayerStatsLite | null>;
  /** First guess of the account's country, for the payment rail (F14-D04); never overwrites a choice. */
  country?: string | null;
}): Promise<string> {
  const address = a.ledger.addressOf(a.userId);
  const isNew = a.store ? a.store.upsertUser(a.userId, { locale: a.lang, address, country: a.country ?? null }).isNew : !a.registry.startedUsers.has(a.userId);
  a.registry.markStarted(a.userId);
  const t = T[a.lang];
  if (isNew) return t.welcome;
  const stats = address && a.statsFor ? await a.statsFor(address).catch(() => null) : null;
  return t.welcomeBack(stats);
}

/** /pass in a private chat: the player's game wallet, their Host Pass, and how to pay for it. */
export async function passReply(a: {
  ledger: GameLedger;
  passes: PassReader | null;
  payments?: string;
  explorer?: string;
  userId: number;
  lang: Lang;
  /** The account's payment rail (F14-D04) and who sells rupiah passes. */
  rail?: PayRail;
  contact?: string;
  /** QUSDC (6 decimals), offered next to QIE when NoxPayments has a QUSDC price (F14-S04). */
  qusdc?: Address;
}): Promise<string> {
  const t = T[a.lang];
  const wallet = a.ledger.addressOf(a.userId);
  if (!wallet || !a.passes || !a.payments) return t.passStatus({ wallet: wallet ?? "-", active: false, until: null, price: null, periodDays: null, payments: "", explorer: "" });
  const [status, offer, usd] = await Promise.all([
    a.passes.status(wallet),
    a.passes.offer(),
    a.qusdc ? a.passes.offer(HOST_PASS, a.qusdc).catch(() => null) : Promise.resolve(null),
  ]);
  let text = t.passStatus({
    wallet,
    active: status.active,
    until: status.active ? new Date(status.expiresAt * 1000).toISOString().slice(0, 10) : null,
    price: offer ? qie(offer.wei, 4).replace(/\.?0+$/, "") : null,
    periodDays: offer?.periodDays ?? null,
    payments: a.payments,
    explorer: `${a.explorer ?? ""}/address/${a.payments}`,
  });
  if (usd && a.qusdc) text += `\n\n${t.passQusdc({ wallet, price: formatUnits(usd.wei, 6), token: a.qusdc, payments: a.payments })}`;
  // Rupiah rail: the invoice comes first; paying on chain from a wallet stays possible.
  return a.rail === "rupiah" && offer ? `${text}\n\n${t.passRupiah(wallet, a.contact ?? null)}` : text;
}

/** Wire Telegram updates to the registry. Nox stays a regular bot: no Mini App / Web App buttons. */
export async function createNoxBot({ botToken, dbPath, webUrl, operatorChatId, apiUrl, timings, gm, chain, rateLimit, hostPass, nudge, paymentContact, loginSecret }: Config) {
  const bot = new Bot(botToken);
  await bot.init();
  // First middleware: refused updates never reach the game.
  bot.use(rateLimitMiddleware(new RateLimiter(rateLimit), (ctx) => T[langFrom(ctx.from?.language_code)].slowDown, logLine));
  const messenger = telegramMessenger(bot);
  const store = new SqliteStore(dbPath, storeKeyring(chain.walletSecret, chain.storeKeys));
  if (operatorChatId) {
    alertMonitor = new AlertMonitor({
      send: (text) => void messenger.sendDM(operatorChatId, text).catch(() => console.log(JSON.stringify({ event: "alert_send_error" }))),
    });
  }
  const ledger = buildLedger(
    chain,
    logLine,
    botLedgerHooks({ store, messenger, treasuryAlertWei: chain.treasuryAlertWei, ...(webUrl ? { webUrl } : {}), ...(operatorChatId ? { operatorChatId } : {}) }),
  );
  // Host Passes live in NoxPayments; reading them needs only a public client.
  const passes =
    chain.network !== "off" && chain.paymentsAddress
      ? new PassReader({
          client: createPublicClient({ chain: chainFor(chain.network), transport: rpcTransport(chainFor(chain.network), chain.rpcUrl) }) as unknown as PassClient,
          payments: chain.paymentsAddress,
        })
      : null;
  const explorer = chain.network !== "off" ? chainFor(chain.network).blockExplorers?.default.url : undefined;
  const hostPassCheck =
    hostPass === "required" && passes
      ? async (userId: number) => {
          const wallet = ledger.addressOf(userId);
          if (!wallet) return true;
          try {
            return (await passes.status(wallet)).active;
          } catch (e) {
            // An RPC outage must not lock hosts out of their lobby: let them in and log it.
            logLine({ event: "pass_check_error", userId, error: e instanceof Error ? e.message.split("\n")[0] : String(e) });
            return true;
          }
        }
      : undefined;
  const registry = new Registry({
    messenger,
    scheduler: realScheduler,
    timings,
    randomInt: (max) => randomInt(max),
    botUsername: bot.botInfo.username,
    narratorFor: narratorFactory(gm, (id) => store.agentSecret(id)),
    // Personas need an LLM; with template narration there is nothing to pick.
    ...(gm.mode === "llm" ? { agents: () => [...THEME_AGENTS, ...store.listAgents(true)] } : {}),
    ledger,
    store,
    ...(webUrl ? { webUrl } : {}),
    onAgentGame: onAgentGame({ store, messenger, ...(operatorChatId ? { operatorChatId } : {}) }),
    onGameReport: (g) => store.recordGmGame(g),
    // Counting a quiet discussion needs Telegram privacy mode off (BotFather → Group Privacy → Disable).
    ...(nudge !== "off" ? { nudge, canCountMessages: bot.botInfo.can_read_all_group_messages } : {}),
    ...(hostPassCheck ? { hostPass: hostPassCheck } : {}),
  });
  await recoverGames(store, ledger, messenger, logLine);

  const statsFor = apiUrl ? statsFromApi(apiUrl) : undefined;
  bot.command("pass", async (ctx) => {
    if (ctx.chat.type !== "private" || !ctx.from) return;
    const lang = langFrom(ctx.from.language_code);
    const country = store.getUser(ctx.from.id)?.country ?? countryGuess(ctx.from.language_code);
    const text = await passReply({
      ledger,
      passes,
      ...(chain.paymentsAddress ? { payments: chain.paymentsAddress } : {}),
      ...(explorer ? { explorer } : {}),
      userId: ctx.from.id,
      lang,
      rail: payRail(country),
      ...(chain.qusdcAddress ? { qusdc: chain.qusdcAddress } : {}),
      ...(paymentContact ? { contact: paymentContact } : {}),
    }).catch(() => T[lang].stale);
    await ctx.reply(text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  });
  // /web, /masuk: a one-time sign-in link to the web app for this player's game wallet (NOX-APP-14).
  bot.command(["web", "masuk"], async (ctx) => {
    if (ctx.chat.type !== "private" || !ctx.from) return;
    const t = T[langFrom(ctx.from.language_code)];
    const wallet = ledger.addressOf(ctx.from.id);
    if (!loginSecret || !webUrl || !wallet) return void (await ctx.reply(t.webOff));
    registry.markStarted(ctx.from.id);
    const link = loginLink(webUrl, loginToken(loginSecret, wallet, Math.floor(Date.now() / 1000)));
    await ctx.reply(t.webLogin(link, LOGIN_TTL_S / 60), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  });
  // /negara ID, /country SG: the player's own country, which only picks the payment rail (F14-D04).
  bot.command(["negara", "country"], async (ctx) => {
    if (ctx.chat.type !== "private" || !ctx.from) return;
    const t = T[langFrom(ctx.from.language_code)];
    const country = parseCountry(ctx.match);
    if (!country) return void (await ctx.reply(t.countryUsage));
    // A private chat with the bot means the player started it, so a missing account is created here.
    if (!store.setUserCountry(ctx.from.id, country)) {
      store.upsertUser(ctx.from.id, { locale: langFrom(ctx.from.language_code), address: ledger.addressOf(ctx.from.id), country });
      registry.markStarted(ctx.from.id);
    }
    await ctx.reply(t.countrySet(country, payRail(country) === "rupiah"));
  });
  const practice = new Practice({ botUsername: bot.botInfo.username, counts: store });
  // Booked Game Nights (F04-S06): announcements and the open call in the client's group, every minute.
  const gameNights = new GameNights({ store, messenger, botUsername: bot.botInfo.username, llm: gm.mode === "llm", log: logLine });
  const nightsTick = () => void gameNights.tick().catch((e) => logLine({ event: "gamenight_error", error: e instanceof Error ? e.message : String(e) }));
  setInterval(nightsTick, 60_000).unref();
  nightsTick();
  bot.command(["latihan", "practice"], async (ctx) => {
    const lang = langFrom(ctx.from?.language_code);
    await ctx.reply(PRACTICE[lang].groupLink(practiceLink(bot.botInfo.username, lang)), { link_preview_options: { is_disabled: true } });
  });
  bot.command("start", async (ctx) => {
    if (ctx.chat.type !== "private" || !ctx.from) return;
    // t.me/<bot>?start=latihan opens the Scam Shield practice; it creates no account (nothing about the person is kept).
    if (PRACTICE_PAYLOADS.includes(ctx.match.trim().toLowerCase())) {
      const q = practice.start(ctx.from.id, ctx.match.trim().toLowerCase() === "latihan" ? "id" : langFrom(ctx.from.language_code));
      await ctx.reply(q.text, opts(q.keyboard));
      return;
    }
    const text = await startReply({
      registry,
      store,
      ledger,
      userId: ctx.from.id,
      lang: langFrom(ctx.from.language_code),
      country: countryGuess(ctx.from.language_code),
      ...(statsFor ? { statsFor } : {}),
    });
    await ctx.reply(text, { parse_mode: "HTML" });
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
  // | q:<item>:<s|k> (practice) | f:yes (forget) | g:<booking> (open a booked Game Night)
  bot.on("callback_query:data", async (ctx) => {
    const [kind, roomId, roundStr, target] = ctx.callbackQuery.data.split(":");
    if (kind === "q") {
      const next = practice.answer(ctx.from.id, Number(roomId), roundStr === "s" ? "s" : "k");
      if (!next) return void (await ctx.answerCallbackQuery({ text: stripTags(T[langFrom(ctx.from.language_code)].stale) }));
      await ctx.answerCallbackQuery();
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined); // no second tap on an answered item
      await ctx.reply(next.text, opts(next.keyboard));
      return;
    }
    if (kind === "g") {
      const r = ctx.chat ? await gameNights.claim(registry, roomId ?? "", ctx.chat.id, ctx.from.id, displayName(ctx.from)) : { ok: false, text: T.en.stale };
      await ctx.answerCallbackQuery(r.text ? { text: stripTags(r.text) } : undefined);
      return;
    }
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
    if (ctx.chat.type !== "private") {
      // Only counted, never stored or read further: is the discussion going quiet? (F07-S02)
      registry.roomOfChat(ctx.chat.id)?.noteGroupMessage();
      return;
    }
    registry.markStarted(ctx.from.id);
    const room = registry.roomOfUser(ctx.from.id);
    if (room) await room.wolfChat(ctx.from.id, ctx.message.text);
  });

  bot.catch((err) => logLine({ event: "bot_error", error: err.error instanceof Error ? err.error.message : String(err.error) }));
  return { bot, registry };
}
