import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Address, Hex } from "viem";
import type { EventStore } from "./chain/indexer.js";
import { verifyToken, sessionToken, SESSION_TTL_S } from "./login.js";
import { buildReport } from "./report.js";

/**
 * Public read-only API (F12-D05) over the event index. Everything it serves is already public on
 * chain; the API only saves clients from scanning logs themselves. GET only, JSON, CORS open. With a
 * login secret it also takes POST /v1/login (a one-time token from the bot, for a session) and
 * GET /v1/me (who the session belongs to), NOX-APP-14; those are never cached.
 * Responses are cached per URL until the index moves to a new block, and each IP gets a fixed
 * number of requests per minute.
 */
export interface ApiOptions {
  store: EventStore;
  network: string;
  chainId: number;
  /** Requests per minute per client IP. Default 120. */
  ratePerMinute?: number;
  /** Use X-Forwarded-For as the client IP (only behind a reverse proxy that sets it). */
  trustProxy?: boolean;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
  /** NOX_LOGIN_SECRET: turns on POST /v1/login and GET /v1/me (web login, NOX-APP-14). */
  loginSecret?: Buffer | null;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const GAME_ID = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MAX_CACHE = 500;
const MAX_CLIENTS = 10_000;

function intParam(url: URL, key: string, fallback: number, min: number, max: number): number {
  const v = url.searchParams.get(key);
  if (v === null) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${key} must be a whole number from ${min} to ${max}`);
  return n;
}

export function createApi(o: ApiOptions): Server {
  const now = o.now ?? Date.now;
  const rate = o.ratePerMinute ?? 120;
  const cache = new Map<string, { block: number; body: string }>();
  const clients = new Map<string, { windowStart: number; count: number }>();

  const route = (url: URL): unknown => {
    const { store } = o;
    const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    if (parts[0] !== "v1") throw new HttpError(404, "not found");
    const [, resource, id, ...rest] = parts;
    if (rest.length) throw new HttpError(404, "not found");
    switch (resource) {
      case "health":
        return {
          ok: true,
          network: o.network,
          chainId: o.chainId,
          indexedBlock: store.indexedBlock(),
          reconciliation: store.lastReconciliation(),
          paymentsReconciliation: store.lastPaymentReconciliation(),
        };
      case "stats":
        if (id) break;
        return { ...store.stats(), indexedBlock: store.indexedBlock() };
      case "leaderboard": {
        if (id) break;
        const season = url.searchParams.get("season") ?? undefined;
        if (season !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(season)) throw new HttpError(400, "season must look like 2026-10");
        return { season: season ?? null, players: store.leaderboard(intParam(url, "limit", 50, 1, 200), season) };
      }
      case "daily": {
        if (id) break;
        const days = intParam(url, "days", 30, 1, 90);
        const today = Math.floor(now() / 86_400_000) * 86_400;
        return { days: store.dailySigners(today - (days - 1) * 86_400) };
      }
      case "engagement": {
        // The Game Night report's metrics over every group (docs/metrics.md): the last `weeks` ISO
        // weeks, from Monday 00:00 UTC to now. Counts only; small weekly counts are hidden.
        if (id) break;
        const weeks = intParam(url, "weeks", 8, 1, 26);
        const day = Math.floor(now() / 86_400_000);
        const monday = day - ((day + 3) % 7); // 1 Jan 1970 was a Thursday
        const from = (monday - 7 * (weeks - 1)) * 86_400;
        const to = Math.floor(now() / 1000) + 1;
        const iso = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
        return buildReport({ group: "all", from: iso(from), to: iso(to - 1), games: store.finalizedGames(from, to) });
      }
      case "games": {
        if (!id) {
          const before = url.searchParams.has("before") ? intParam(url, "before", 0, 1, Number.MAX_SAFE_INTEGER) : undefined;
          return { games: store.games(intParam(url, "limit", 20, 1, 100), before) };
        }
        if (!GAME_ID.test(id)) throw new HttpError(400, "game id must be 0x + 64 hex characters");
        const game = store.game(id as Hex);
        if (!game) throw new HttpError(404, "game not indexed (yet)");
        return { game, events: store.eventsOfGame(id as Hex) };
      }
      case "agents": {
        // Agent Marketplace revenue, public on chain: per agent, owner and token (amounts in wei, as strings).
        if (id !== "revenue") break;
        const { agents, owners } = store.paymentLedger();
        const str = <T extends object>(x: T) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
        return { agents: agents.map(str), owners: owners.map(str) };
      }
      case "players":
        if (!id || !ADDRESS.test(id)) throw new HttpError(400, "address must be 0x + 40 hex characters");
        // D9: the wallet's pass purchases, on chain or rupiah (amounts in wei as strings; rupiah amounts stay private).
        return {
          ...store.player(id as Address),
          passes: store.passPurchases(id as Address, Math.floor(now() / 1000)).map((p) => ({ ...p, amount: p.amount === null ? null : p.amount.toString() })),
        };
    }
    throw new HttpError(404, "not found");
  };

  const clientIp = (req: IncomingMessage) => {
    const fwd = o.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() : "";
    return fwd || req.socket.remoteAddress || "unknown";
  };

  const allow = (ip: string): boolean => {
    const t = now();
    const c = clients.get(ip);
    if (!c || t - c.windowStart >= 60_000) {
      if (clients.size >= MAX_CLIENTS) for (const [k, v] of clients) if (t - v.windowStart >= 60_000) clients.delete(k);
      clients.set(ip, { windowStart: t, count: 1 });
      return true;
    }
    c.count++;
    return c.count <= rate;
  };

  const send = (res: ServerResponse, status: number, body: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
      ...extra,
    });
    res.end(res.req.method === "HEAD" ? undefined : body);
  };

  const secret = o.loginSecret ?? null;
  const nowS = () => Math.floor(now() / 1000);
  const noStore = { "cache-control": "no-store" };

  /** POST /v1/login {token}: spend the bot's one-time token, answer with a session for that wallet. */
  const login = (req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    let tooBig = false;
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
      if (raw.length > 2048) tooBig = true;
    });
    req.on("end", () => {
      if (tooBig) return send(res, 413, JSON.stringify({ error: "body too large" }), noStore);
      let token: unknown;
      try {
        token = (JSON.parse(raw) as { token?: unknown }).token;
      } catch {
        return send(res, 400, JSON.stringify({ error: "body must be JSON with a token" }), noStore);
      }
      if (typeof token !== "string") return send(res, 400, JSON.stringify({ error: "body must be JSON with a token" }), noStore);
      const c = verifyToken(secret!, token, "login", nowS());
      if ("error" in c) return send(res, 401, JSON.stringify({ error: c.error }), noStore);
      if (!o.store.useLoginNonce(c.n!, c.e, nowS())) return send(res, 401, JSON.stringify({ error: "link already used" }), noStore);
      o.log?.({ event: "web_login", address: c.a });
      send(res, 200, JSON.stringify({ address: c.a, session: sessionToken(secret!, c.a, nowS()), expiresAt: nowS() + SESSION_TTL_S }), noStore);
    });
  };

  /** GET /v1/me with "Authorization: Bearer <session>": the wallet the session belongs to. */
  const me = (req: IncomingMessage, res: ServerResponse) => {
    const auth = String(req.headers.authorization ?? "");
    const c = auth.startsWith("Bearer ") ? verifyToken(secret!, auth.slice(7).trim(), "session", nowS()) : { error: "missing session" };
    if ("error" in c) return send(res, 401, JSON.stringify({ error: c.error }), noStore);
    send(res, 200, JSON.stringify({ address: c.a, expiresAt: c.e, stats: o.store.playerStats(c.a as Address) }), noStore);
  };

  return createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": secret ? "GET, HEAD, POST, OPTIONS" : "GET, HEAD, OPTIONS",
        ...(secret ? { "access-control-allow-headers": "content-type, authorization" } : {}),
        "access-control-max-age": "86400",
      });
      res.end();
      return;
    }
    const path = (req.url ?? "/").split("?")[0]!.replace(/\/+$/, "");
    const isLogin = secret !== null && path === "/v1/login";
    if (isLogin ? req.method !== "POST" : req.method !== "GET" && req.method !== "HEAD") {
      return send(res, 405, JSON.stringify({ error: isLogin ? "only POST" : "only GET" }), { allow: isLogin ? "POST, OPTIONS" : "GET, HEAD, OPTIONS" });
    }
    if (!allow(clientIp(req))) return send(res, 429, JSON.stringify({ error: "too many requests" }), { "retry-after": "60" });
    if (isLogin) return login(req, res);
    if (secret !== null && path === "/v1/me") return me(req, res);

    try {
      const url = new URL(req.url ?? "/", "http://api");
      const key = url.pathname + url.search;
      const block = o.store.indexedBlock();
      const etag = `W/"${block}"`;
      const headers = { etag, "cache-control": "public, max-age=5" };
      if (req.headers["if-none-match"] === etag && cache.has(key)) {
        res.writeHead(304, { ...headers, "access-control-allow-origin": "*" });
        res.end();
        return;
      }
      let hit = cache.get(key);
      if (!hit || hit.block !== block) {
        hit = { block, body: JSON.stringify(route(url)) };
        if (cache.size >= MAX_CACHE) cache.clear();
        cache.set(key, hit);
      }
      send(res, 200, hit.body, headers);
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, JSON.stringify({ error: err.message }));
      o.log?.({ event: "api_error", path: req.url, error: err instanceof Error ? err.message : String(err) });
      send(res, 500, JSON.stringify({ error: "internal error" }));
    }
  });
}
