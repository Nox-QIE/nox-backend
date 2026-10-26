import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Bot, type Context } from "grammy";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { parseRateLimit, RateLimiter, rateLimitMiddleware } from "../src/ratelimit.js";
import { WEBHOOK_PATH, webhookServer } from "../src/webhook.js";

describe("rate limit (L0-11)", () => {
  it("allows `limit` hits per window, flags the first refusal once, and resets", () => {
    let now = 0;
    const l = new RateLimiter({ limit: 3, windowMs: 10_000, now: () => now });
    const r = [1, 2, 3, 4, 5].map(() => l.hit(7));
    expect(r.map((x) => x.allowed)).toEqual([true, true, true, false, false]);
    expect(r.map((x) => x.firstDenied)).toEqual([false, false, false, true, false]);
    expect(l.hit(8).allowed).toBe(true); // other users are independent
    now = 10_000;
    expect(l.hit(7)).toEqual({ allowed: true, firstDenied: false });
  });

  it("parses NOX_RATE_LIMIT", () => {
    expect(parseRateLimit("20/10")).toEqual({ limit: 20, windowMs: 10_000 });
    expect(() => parseRateLimit("0/10")).toThrow();
    expect(() => parseRateLimit("fast")).toThrow();
  });

  const ctx = (o: { user?: number; chat?: string; text?: string; callback?: boolean }) => {
    const answers: unknown[] = [];
    const c = {
      from: o.user === undefined ? undefined : { id: o.user, language_code: "id" },
      chat: o.chat ? { type: o.chat } : undefined,
      message: o.text !== undefined ? { text: o.text } : undefined,
      callbackQuery: o.callback ? { data: "v:1:1:2" } : undefined,
      answerCallbackQuery: async (a: unknown) => void answers.push(a),
    };
    return { c: c as unknown as Context, answers };
  };

  it("limits commands, taps and private messages, never ordinary group chat", async () => {
    const mw = rateLimitMiddleware(new RateLimiter({ limit: 2, windowMs: 60_000 }), () => "pelan", () => undefined);
    let passed = 0;
    const next = async () => void passed++;
    for (let i = 0; i < 5; i++) await mw(ctx({ user: 1, chat: "group", text: "I think Ben is the wolf" }).c, next);
    expect(passed).toBe(5);

    passed = 0;
    const taps = [1, 2, 3, 4].map(() => ctx({ user: 2, chat: "group", callback: true }));
    for (const t of taps) await mw(t.c, next);
    expect(passed).toBe(2);
    expect(taps[2]!.answers).toEqual([{ text: "pelan" }]); // one notice
    expect(taps[3]!.answers).toEqual([]);

    passed = 0;
    for (const t of ["/newgame", "/newgame", "/newgame"]) await mw(ctx({ user: 3, chat: "group", text: t }).c, next);
    for (const t of ["hi", "hi", "hi"]) await mw(ctx({ user: 4, chat: "private", text: t }).c, next);
    expect(passed).toBe(4);
  });
});

describe("webhook mode (L0-01)", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());
  const secret = "s".repeat(40);

  async function start() {
    const bot = new Bot("123:test", {
      botInfo: { id: 123, is_bot: true, first_name: "Nox", username: "nox_test_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false } as never,
    });
    const seen: string[] = [];
    bot.on("message:text", (c) => void seen.push(c.message.text));
    server = webhookServer(bot, secret);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const update = { update_id: 1, message: { message_id: 1, date: 0, chat: { id: 5, type: "private", first_name: "A" }, from: { id: 5, is_bot: false, first_name: "A" }, text: "hello" } };
    const post = (token?: string) =>
      fetch(base + WEBHOOK_PATH, { method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-telegram-bot-api-secret-token": token } : {}) }, body: JSON.stringify(update) });
    return { base, seen, post };
  }

  it("accepts updates only with the secret token", async () => {
    const { seen, post } = await start();
    expect((await post()).status).toBe(401);
    expect((await post("wrong")).status).toBe(401);
    expect(seen).toEqual([]);
    expect((await post(secret)).status).toBe(200);
    expect(seen).toEqual(["hello"]);
  });

  it("serves a health check and nothing else", async () => {
    const { base } = await start();
    expect(await (await fetch(`${base}/healthz`)).text()).toBe("ok");
    expect((await fetch(`${base}/telegram/other`, { method: "POST" })).status).toBe(404);
    expect((await fetch(base + WEBHOOK_PATH)).status).toBe(404); // GET
  });

  it("validates its settings", () => {
    const env = { BOT_TOKEN: "1:x", NOX_WEBHOOK_URL: "https://bot.nox.example/", NOX_WEBHOOK_SECRET: "a".repeat(32) };
    expect(loadConfig(env).webhook).toEqual({ url: "https://bot.nox.example", secret: "a".repeat(32), port: 8080, host: "127.0.0.1" });
    expect(loadConfig({ BOT_TOKEN: "1:x" }).webhook).toBeUndefined();
    expect(() => loadConfig({ ...env, NOX_WEBHOOK_URL: "http://bot.nox.example" })).toThrow(/https/);
    expect(() => loadConfig({ ...env, NOX_WEBHOOK_SECRET: "short" })).toThrow(/NOX_WEBHOOK_SECRET/);
  });
});
