import type { Context, MiddlewareFn } from "grammy";

/**
 * Per-user fixed-window rate limit (L0-11). Telegram delivers every tap and command to the bot, so a
 * user (or a script on a user account) can flood the lobby, the buttons or the werewolf relay.
 */
export class RateLimiter {
  private readonly hits = new Map<number, { windowStart: number; count: number }>();

  constructor(
    private readonly o: { limit: number; windowMs: number; now?: () => number; maxKeys?: number },
  ) {}

  /** `firstDenied` is true only for the first refused hit of a window (to warn once, not on every tap). */
  hit(key: number): { allowed: boolean; firstDenied: boolean } {
    const now = (this.o.now ?? Date.now)();
    let h = this.hits.get(key);
    if (!h || now - h.windowStart >= this.o.windowMs) {
      if (!h && this.hits.size >= (this.o.maxKeys ?? 50_000)) this.prune(now);
      h = { windowStart: now, count: 0 };
      this.hits.set(key, h);
    }
    h.count++;
    return { allowed: h.count <= this.o.limit, firstDenied: h.count === this.o.limit + 1 };
  }

  private prune(now: number) {
    for (const [k, v] of this.hits) if (now - v.windowStart >= this.o.windowMs) this.hits.delete(k);
  }
}

/** "20/10" → 20 updates per 10 seconds. */
export function parseRateLimit(spec: string): { limit: number; windowMs: number } {
  const m = /^(\d+)\/(\d+)$/.exec(spec.trim());
  if (!m || Number(m[1]) < 1 || Number(m[2]) < 1) throw new Error('NOX_RATE_LIMIT must look like "20/10" (updates per seconds)');
  return { limit: Number(m[1]), windowMs: Number(m[2]) * 1000 };
}

/**
 * Limits what a user sends to the bot: commands, button taps and private messages. Ordinary group
 * chat is never limited (the bot ignores it). A refused button tap gets one short notice per window.
 */
export function rateLimitMiddleware(limiter: RateLimiter, notice: (ctx: Context) => string, log?: (l: Record<string, unknown>) => void): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const user = ctx.from?.id;
    const text = ctx.message?.text;
    const counted = ctx.callbackQuery !== undefined || ctx.chat?.type === "private" || (text !== undefined && text.startsWith("/"));
    if (user === undefined || !counted) return next();
    const r = limiter.hit(user);
    if (r.allowed) return next();
    if (r.firstDenied) {
      log?.({ event: "rate_limited", userId: user });
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: notice(ctx) }).catch(() => undefined);
    }
  };
}
