import type { GmProvider } from "./gm/model.js";
import { DEFAULT_TIMINGS, type Timings } from "./ports.js";

export interface GmPoolEntryConfig {
  /** "anthropic" = Claude API with the SDK's own credentials; "oxion" = Oxion AI gateway. */
  provider: GmProvider;
  model: string;
  weight: number;
}

export interface GmConfig {
  /** "template" (default, no network) or "llm" (Claude via the Anthropic SDK). */
  mode: "template" | "llm";
  /** One entry = one fixed model; several = a model per game picked by weight, the rest as failover. */
  pool: GmPoolEntryConfig[];
  timeoutMs: number;
  baseURL?: string;
  authToken?: string;
  /** USD per million tokens [input, output], when the provider's rates differ from the Claude API. */
  price?: [number, number];
}

export interface ChainConfig {
  /** "off" (default): no chain. "local" = anvil (31337), "testnet" = QIE 1983, "mainnet" = QIE 1990. */
  network: "off" | "local" | "testnet" | "mainnet";
  rpcUrl?: string;
  gameAddress?: `0x${string}`;
  /** Agent Marketplace contracts (needed by the operator scripts for registration and settlement). */
  agentRegistryAddress?: `0x${string}`;
  paymentsAddress?: `0x${string}`;
  /** First block to scan for payment events. */
  paymentsFromBlock: bigint;
  operatorKey?: `0x${string}`;
  walletSecret?: string;
  /** Gas drip in wei: top a player up to dripWei when below minWei. */
  dripWei: bigint;
  minWei: bigint;
  /** Daily gas drip caps in wei: per player and for all players together. */
  dailyPerPlayerWei: bigint;
  dailyBudgetWei: bigint;
}

export interface Config {
  botToken: string;
  /** SQLite file for started users and encrypted game secrets. */
  dbPath: string;
  /** Public dashboard URL for proof links, e.g. https://nox.example (optional). */
  webUrl?: string;
  timings: Timings;
  gm: GmConfig;
  chain: ChainConfig;
}

const seconds = (env: NodeJS.ProcessEnv, key: string, fallbackMs: number) => {
  const v = env[key];
  if (!v) return fallbackMs;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${key} must be a positive number of seconds`);
  return n * 1000;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const botToken = env.BOT_TOKEN;
  if (!botToken) throw new Error("BOT_TOKEN is not set (get one from @BotFather)");
  return {
    botToken,
    dbPath: env.NOX_DB_PATH || "data/nox.db",
    ...(env.NOX_WEB_URL ? { webUrl: env.NOX_WEB_URL } : {}),
    timings: {
      lobbyMs: seconds(env, "LOBBY_SECONDS", DEFAULT_TIMINGS.lobbyMs),
      nightMs: seconds(env, "NIGHT_SECONDS", DEFAULT_TIMINGS.nightMs),
      discussionMs: seconds(env, "DISCUSSION_SECONDS", DEFAULT_TIMINGS.discussionMs),
      voteMs: seconds(env, "VOTE_SECONDS", DEFAULT_TIMINGS.voteMs),
    },
    gm: loadGmConfig(env),
    chain: loadChainConfig(env),
  };
}

export function loadGmConfig(env: NodeJS.ProcessEnv = process.env): GmConfig {
  const mode = env.NOX_GM ?? "template";
  if (mode !== "template" && mode !== "llm") throw new Error('NOX_GM must be "template" or "llm"');
  const gm: GmConfig = {
    mode,
    pool: env.NOX_GM_MODELS ? parsePool(env.NOX_GM_MODELS) : [singleEntry(env)],
    timeoutMs: seconds(env, "NOX_GM_TIMEOUT_SECONDS", 8000),
  };
  if (gm.pool.some((e) => e.provider === "oxion")) {
    if (env.NOX_GM_BASE_URL) gm.baseURL = env.NOX_GM_BASE_URL;
    if (env.OXION_API_KEY) gm.authToken = env.OXION_API_KEY;
  }
  if (env.NOX_GM_PRICE_PER_M) {
    const [i, o] = env.NOX_GM_PRICE_PER_M.split(",").map(Number);
    if (!Number.isFinite(i) || !Number.isFinite(o)) throw new Error('NOX_GM_PRICE_PER_M must look like "4,20"');
    gm.price = [i!, o!];
  }
  if (mode === "llm" && gm.pool.some((e) => e.provider === "oxion") && !gm.authToken) throw new Error("OXION_API_KEY is not set");
  return gm;
}

const asProvider = (p: string): GmProvider => {
  if (p !== "anthropic" && p !== "oxion") throw new Error(`GM provider must be "anthropic" or "oxion", got "${p}"`);
  return p;
};

function singleEntry(env: NodeJS.ProcessEnv): GmPoolEntryConfig {
  return { provider: asProvider(env.NOX_GM_PROVIDER ?? "anthropic"), model: env.NOX_GM_MODEL || "claude-opus-5-5", weight: 1 };
}

/** "oxion:claude-opus-5.5@2, anthropic:claude-opus-5-5" → entries; weight defaults to 1. */
export function parsePool(spec: string): GmPoolEntryConfig[] {
  const entries = spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((item) => {
      const m = /^([a-z]+):([^@\s]+)(?:@(\d+))?$/.exec(item);
      if (!m) throw new Error(`NOX_GM_MODELS entry must look like "provider:model" or "provider:model@weight", got "${item}"`);
      const weight = m[3] ? Number(m[3]) : 1;
      if (weight < 1) throw new Error(`NOX_GM_MODELS weight must be ≥ 1, got "${item}"`);
      return { provider: asProvider(m[1]!), model: m[2]!, weight };
    });
  if (!entries.length) throw new Error("NOX_GM_MODELS is empty");
  return entries;
}

const qieToWei = (v: string, key: string) => {
  if (!/^\d+(\.\d{1,18})?$/.test(v)) throw new Error(`${key} must be a QIE amount like 0.002`);
  const [i, f = ""] = v.split(".");
  return BigInt(i!) * 10n ** 18n + BigInt(f.padEnd(18, "0"));
};

const hex = (v: string | undefined, key: string, bytes: number): `0x${string}` | undefined => {
  if (!v) return undefined;
  if (!new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(v)) throw new Error(`${key} must be 0x + ${bytes * 2} hex characters`);
  return v as `0x${string}`;
};

export function loadChainConfig(env: NodeJS.ProcessEnv = process.env): ChainConfig {
  const network = env.NOX_CHAIN || "off";
  if (!["off", "local", "testnet", "mainnet"].includes(network)) throw new Error('NOX_CHAIN must be "off", "local", "testnet" or "mainnet"');
  const c: ChainConfig = {
    network: network as ChainConfig["network"],
    dripWei: qieToWei(env.NOX_GAS_DRIP || "0.002", "NOX_GAS_DRIP"),
    minWei: qieToWei(env.NOX_GAS_MIN || "0.0005", "NOX_GAS_MIN"),
    dailyPerPlayerWei: qieToWei(env.NOX_GAS_DAILY_PER_PLAYER || "0.01", "NOX_GAS_DAILY_PER_PLAYER"),
    dailyBudgetWei: qieToWei(env.NOX_GAS_DAILY_BUDGET || "5", "NOX_GAS_DAILY_BUDGET"),
    paymentsFromBlock: BigInt(env.NOX_PAYMENTS_FROM_BLOCK || 0),
  };
  for (const [key, field] of [["NOX_AGENT_REGISTRY_ADDRESS", "agentRegistryAddress"], ["NOX_PAYMENTS_ADDRESS", "paymentsAddress"]] as const) {
    const v = env[key];
    if (!v) continue;
    if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`${key} must be a contract address`);
    c[field] = v as `0x${string}`;
  }
  if (c.network === "off") return c;
  if (env.NOX_RPC_URL) c.rpcUrl = env.NOX_RPC_URL;
  else if (c.network === "local") c.rpcUrl = "http://127.0.0.1:8545";
  const game = env.NOX_GAME_ADDRESS;
  if (!game || !/^0x[0-9a-fA-F]{40}$/.test(game)) throw new Error("NOX_GAME_ADDRESS must be the deployed NoxGame address");
  c.gameAddress = game as `0x${string}`;
  const operatorKey = hex(env.NOX_OPERATOR_KEY, "NOX_OPERATOR_KEY", 32);
  if (!operatorKey) throw new Error("NOX_OPERATOR_KEY is not set");
  c.operatorKey = operatorKey;
  if (!env.NOX_WALLET_SECRET || env.NOX_WALLET_SECRET.replace(/^0x/, "").length < 64) {
    throw new Error("NOX_WALLET_SECRET must be at least 32 bytes of hex (openssl rand -hex 32)");
  }
  c.walletSecret = env.NOX_WALLET_SECRET;
  return c;
}

export interface IndexerConfig {
  network: "local" | "testnet" | "mainnet";
  rpcUrl?: string;
  gameAddress: `0x${string}`;
  agentRegistryAddress?: `0x${string}`;
  paymentsAddress?: `0x${string}`;
  /** Deploy block: where the first scan starts. */
  fromBlock: bigint;
  confirmations: bigint;
  dbPath: string;
  pollMs: number;
  /** Public read-only API; null = off. Binds to localhost by default (put a reverse proxy in front). */
  api: { port: number; host: string; trustProxy: boolean; ratePerMinute: number } | null;
}

/** The indexer only reads public chain data, so it needs no operator key or wallet secret. */
export function loadIndexerConfig(env: NodeJS.ProcessEnv = process.env): IndexerConfig {
  const network = env.NOX_CHAIN;
  if (network !== "local" && network !== "testnet" && network !== "mainnet") throw new Error('NOX_CHAIN must be "local", "testnet" or "mainnet" for the indexer');
  const address = (key: string) => {
    const v = env[key];
    if (v && !/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`${key} must be a contract address`);
    return v as `0x${string}` | undefined;
  };
  const gameAddress = address("NOX_GAME_ADDRESS");
  if (!gameAddress) throw new Error("NOX_GAME_ADDRESS must be the deployed NoxGame address");
  const confirmations = Number(env.NOX_INDEX_CONFIRMATIONS ?? 2);
  if (!Number.isInteger(confirmations) || confirmations < 0) throw new Error("NOX_INDEX_CONFIRMATIONS must be a whole number ≥ 0");
  const c: IndexerConfig = {
    network,
    gameAddress,
    fromBlock: BigInt(env.NOX_INDEX_FROM_BLOCK || env.NOX_PAYMENTS_FROM_BLOCK || 0),
    confirmations: BigInt(confirmations),
    dbPath: env.NOX_INDEX_DB_PATH || "data/index.db",
    pollMs: seconds(env, "NOX_INDEX_POLL_SECONDS", 10_000),
    api: null,
  };
  if (env.NOX_API_PORT !== "off") {
    const port = Number(env.NOX_API_PORT || 8787);
    const rate = Number(env.NOX_API_RATE_PER_MINUTE || 120);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('NOX_API_PORT must be a port number or "off"');
    if (!Number.isInteger(rate) || rate < 1) throw new Error("NOX_API_RATE_PER_MINUTE must be a whole number ≥ 1");
    c.api = { port, host: env.NOX_API_HOST || "127.0.0.1", trustProxy: env.NOX_API_TRUST_PROXY === "1", ratePerMinute: rate };
  }
  const registry = address("NOX_AGENT_REGISTRY_ADDRESS");
  const payments = address("NOX_PAYMENTS_ADDRESS");
  if (registry) c.agentRegistryAddress = registry;
  if (payments) c.paymentsAddress = payments;
  if (env.NOX_RPC_URL) c.rpcUrl = env.NOX_RPC_URL;
  else if (network === "local") c.rpcUrl = "http://127.0.0.1:8545";
  return c;
}
