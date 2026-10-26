import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Address, Hex } from "viem";
import type { EventStore } from "./chain/indexer.js";
import { verifyToken, sessionToken, SESSION_TTL_S } from "./login.js";
import { buildReport } from "./report.js";

/**
 * Public read-only API (F12-D05) over the event index, on Fastify. Everything it serves is already
 * public on chain; the API only saves clients from scanning logs themselves. GET only, JSON, CORS
 * open, every route described in OpenAPI at /v1/openapi.json. With a login secret it also takes
 * POST /v1/login (a one-time token from the bot, for a session) and GET /v1/me (who the session
 * belongs to), NOX-APP-14; those are never cached.
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
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const GAME_ID = "^0x[0-9a-fA-F]{64}$";
const ADDRESS = "^0x[0-9a-fA-F]{40}$";
const SEASON = "^\\d{4}-(0[1-9]|1[0-2])$";
const MAX_CACHE = 500;

const int = (minimum: number, maximum: number, def?: number, description?: string) => ({
  type: "integer",
  minimum,
  maximum,
  ...(def === undefined ? {} : { default: def }),
  ...(description ? { description } : {}),
});
const query = (properties: Record<string, object>) => ({ type: "object", properties, additionalProperties: false });
const param = (name: string, pattern: string, description: string) => ({
  type: "object",
  required: [name],
  properties: { [name]: { type: "string", pattern, description } },
});
const str = <T extends object>(x: T) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));

export async function createApi(o: ApiOptions): Promise<FastifyInstance> {
  const now = o.now ?? Date.now;
  const secret = o.loginSecret ?? null;
  const nowS = () => Math.floor(now() / 1000);
  const cache = new Map<string, { block: number; body: string }>();
  const { store } = o;

  const app = Fastify({
    trustProxy: o.trustProxy ?? false,
    routerOptions: { ignoreTrailingSlash: true },
    // Validation messages name the field: "limit must be <= 200", "id must match pattern …".
    schemaErrorFormatter: (errors, dataVar) =>
      new HttpError(400, errors.map((e) => `${e.instancePath.replace(/^\//, "") || dataVar} ${e.message}`).join("; ")),
  });

  await app.register(cors, {
    origin: "*",
    methods: secret ? ["GET", "HEAD", "POST", "OPTIONS"] : ["GET", "HEAD", "OPTIONS"],
    ...(secret ? { allowedHeaders: ["content-type", "authorization"] } : {}),
    maxAge: 86_400,
    // Answer any OPTIONS with 204, as before Fastify, even without Origin / Access-Control-Request-Method.
    strictPreflight: false,
  });
  await app.register(rateLimit, {
    max: o.ratePerMinute ?? 120,
    timeWindow: 60_000,
    errorResponseBuilder: () => new HttpError(429, "too many requests"),
  });
  await app.register(swagger, {
    openapi: {
      info: { title: "Nox public API", version: "1", description: "Read-only view of Nox's on-chain games on QIE. Field definitions: docs/metrics.md." },
    },
  });

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    return payload;
  });
  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) o.log?.({ event: "api_error", path: req.url, error: err.message });
    let message = status >= 500 ? "internal error" : err.message;
    // Bad or oversized login bodies get the same clear answer as before the move to Fastify.
    if (req.routeOptions.url === "/v1/login" && status === 400) message = "body must be JSON with a token";
    if (status === 413) message = "body too large";
    if (status === 429) reply.header("retry-after", "60");
    void reply.status(status).type("application/json; charset=utf-8").send({ error: message });
  });
  app.setNotFoundHandler((req, reply) => {
    // A GET route asked with another method is "only GET"; anything else simply does not exist.
    if (req.method !== "GET" && req.method !== "HEAD") {
      return reply.status(405).header("allow", "GET, HEAD, OPTIONS").send({ error: "only GET" });
    }
    return reply.status(404).send({ error: "not found" });
  });

  /** A public GET route, cached per URL until the index reaches a new block (ETag = that block). */
  const cached = <R extends FastifyRequest>(handler: (req: R) => unknown) => async (req: R, reply: FastifyReply) => {
    const block = store.indexedBlock();
    const etag = `W/"${block}"`;
    reply.header("etag", etag).header("cache-control", "public, max-age=5");
    if (req.headers["if-none-match"] === etag && cache.has(req.url)) return reply.status(304).send();
    let hit = cache.get(req.url);
    if (!hit || hit.block !== block) {
      hit = { block, body: JSON.stringify(handler(req)) };
      if (cache.size >= MAX_CACHE) cache.clear();
      cache.set(req.url, hit);
    }
    return reply.type("application/json; charset=utf-8").send(hit.body);
  };

  type Q<T> = FastifyRequest<{ Querystring: T }>;
  type P<T> = FastifyRequest<{ Params: T }>;
  const tags = (t: string) => ({ tags: [t] });

  app.get("/v1/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  app.get("/v1/health", { schema: { ...tags("status"), summary: "Network, chain id, indexed block, last reconciliations" } }, cached(() => ({
    ok: true,
    network: o.network,
    chainId: o.chainId,
    indexedBlock: store.indexedBlock(),
    reconciliation: store.lastReconciliation(),
    paymentsReconciliation: store.lastPaymentReconciliation(),
  })));

  app.get("/v1/stats", { schema: { ...tags("metrics"), summary: "All-time totals (players, signed txs, games, credits)" } }, cached(() => ({
    ...store.stats(),
    indexedBlock: store.indexedBlock(),
  })));

  app.get(
    "/v1/leaderboard",
    {
      schema: {
        ...tags("players"),
        summary: "Players ranked by credits, all time or for one season (a UTC month)",
        querystring: query({ limit: int(1, 200, 50), season: { type: "string", pattern: SEASON, description: "UTC month, e.g. 2026-10" } }),
      },
    },
    cached((req: Q<{ limit: number; season?: string }>) => ({ season: req.query.season ?? null, players: store.leaderboard(req.query.limit, req.query.season) })),
  );

  app.get(
    "/v1/daily",
    { schema: { ...tags("metrics"), summary: "Distinct signing players per UTC day", querystring: query({ days: int(1, 90, 30) }) } },
    cached((req: Q<{ days: number }>) => {
      const today = Math.floor(now() / 86_400_000) * 86_400;
      return { days: store.dailySigners(today - (req.query.days - 1) * 86_400) };
    }),
  );

  app.get(
    "/v1/engagement",
    { schema: { ...tags("metrics"), summary: "The Game Night report's metrics over every group, by ISO week", querystring: query({ weeks: int(1, 26, 8) }) } },
    cached((req: Q<{ weeks: number }>) => {
      // The last `weeks` ISO weeks, from Monday 00:00 UTC to now (docs/metrics.md). Counts only.
      const day = Math.floor(now() / 86_400_000);
      const monday = day - ((day + 3) % 7); // 1 Jan 1970 was a Thursday
      const from = (monday - 7 * (req.query.weeks - 1)) * 86_400;
      const to = Math.floor(now() / 1000) + 1;
      const iso = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
      return buildReport({ group: "all", from: iso(from), to: iso(to - 1), games: store.finalizedGames(from, to) });
    }),
  );

  app.get(
    "/v1/games",
    {
      schema: {
        ...tags("games"),
        summary: "Games, newest first",
        querystring: query({ limit: int(1, 100, 20), before: int(1, Number.MAX_SAFE_INTEGER, undefined, "only games created before this block") }),
      },
    },
    cached((req: Q<{ limit: number; before?: number }>) => ({ games: store.games(req.query.limit, req.query.before) })),
  );

  app.get(
    "/v1/games/:id",
    { schema: { ...tags("games"), summary: "One game with all its events", params: param("id", GAME_ID, "game id, 0x + 64 hex") } },
    cached((req: P<{ id: string }>) => {
      const game = store.game(req.params.id as Hex);
      if (!game) throw new HttpError(404, "game not indexed (yet)");
      return { game, events: store.eventsOfGame(req.params.id as Hex) };
    }),
  );

  app.get(
    "/v1/players/:address",
    { schema: { ...tags("players"), summary: "A wallet's stats, history and passes", params: param("address", ADDRESS, "game wallet, 0x + 40 hex") } },
    cached((req: P<{ address: string }>) => ({
      ...store.player(req.params.address as Address),
      // D9: the wallet's pass purchases, on chain or rupiah (amounts in wei as strings; rupiah amounts stay private).
      passes: store.passPurchases(req.params.address as Address, nowS()).map((p) => ({ ...p, amount: p.amount === null ? null : p.amount.toString() })),
    })),
  );

  app.get("/v1/agents", { schema: { ...tags("agents"), summary: "Agent Marketplace agents from NoxAgentRegistry (D16)" } }, cached(() => ({
    agents: store.agents().map((x) => ({ ...x, revenue: x.revenue.map(str) })),
  })));

  app.get(
    "/v1/agents/revenue",
    { schema: { ...tags("agents"), summary: "Agent revenue per agent and owner, from NoxPayments (wei, as strings)" } },
    cached(() => {
      const { agents, owners } = store.paymentLedger();
      return { agents: agents.map(str), owners: owners.map(str) };
    }),
  );

  app.get(
    "/v1/agents/:id",
    { schema: { ...tags("agents"), summary: "One agent by its NoxAgentRegistry id", params: param("id", "^\\d{1,9}$", "on-chain agent id") } },
    cached((req: P<{ id: string }>) => {
      const one = store.agents().find((x) => x.agentId === Number(req.params.id));
      if (!one) throw new HttpError(404, "agent not registered (or not indexed yet)");
      return { ...one, revenue: one.revenue.map(str) };
    }),
  );

  if (secret) {
    const noStore = { "cache-control": "no-store" };
    app.post(
      "/v1/login",
      {
        bodyLimit: 2048,
        schema: {
          ...tags("login"),
          summary: "Trade the bot's one-time login token for a 7-day session",
          body: { type: "object", required: ["token"], properties: { token: { type: "string", maxLength: 1024 } } },
        },
      },
      async (req: FastifyRequest<{ Body: { token: string } }>, reply) => {
        reply.headers(noStore);
        const c = verifyToken(secret, req.body.token, "login", nowS());
        if ("error" in c) return reply.status(401).send({ error: c.error });
        if (!store.useLoginNonce(c.n!, c.e, nowS())) return reply.status(401).send({ error: "link already used" });
        o.log?.({ event: "web_login", address: c.a });
        return { address: c.a, session: sessionToken(secret, c.a, nowS()), expiresAt: nowS() + SESSION_TTL_S };
      },
    );
    // GET on the login route says what to use instead.
    app.get("/v1/login", { schema: { hide: true } }, async (_req, reply) => reply.status(405).header("allow", "POST, OPTIONS").send({ error: "only POST" }));
    app.get("/v1/me", { schema: { ...tags("login"), summary: "The wallet a session belongs to (Authorization: Bearer <session>)" } }, async (req, reply) => {
      reply.headers(noStore);
      const auth = String(req.headers.authorization ?? "");
      const c = auth.startsWith("Bearer ") ? verifyToken(secret, auth.slice(7).trim(), "session", nowS()) : { error: "missing session" };
      if ("error" in c) return reply.status(401).send({ error: c.error });
      return { address: c.a, expiresAt: c.e, stats: store.playerStats(c.a as Address) };
    });
  }

  await app.ready();
  return app;
}
