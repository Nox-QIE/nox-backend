import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Address, Hex } from "viem";
import type { EventStore } from "./chain/indexer.js";
import { buildReport } from "./report.js";

/**
 * Public read-only API (F12-D05) over the event index. Everything it serves is already public on
 * chain; the API only saves clients from scanning logs themselves. GET only, JSON, CORS open.
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
        return store.player(id as Address);
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

  return createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, HEAD, OPTIONS", "access-control-max-age": "86400" });
      res.end();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, JSON.stringify({ error: "only GET" }), { allow: "GET, HEAD, OPTIONS" });
    if (!allow(clientIp(req))) return send(res, 429, JSON.stringify({ error: "too many requests" }), { "retry-after": "60" });

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
