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

export interface Config {
  botToken: string;
  timings: Timings;
  gm: GmConfig;
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
    timings: {
      lobbyMs: seconds(env, "LOBBY_SECONDS", DEFAULT_TIMINGS.lobbyMs),
      nightMs: seconds(env, "NIGHT_SECONDS", DEFAULT_TIMINGS.nightMs),
      discussionMs: seconds(env, "DISCUSSION_SECONDS", DEFAULT_TIMINGS.discussionMs),
      voteMs: seconds(env, "VOTE_SECONDS", DEFAULT_TIMINGS.voteMs),
    },
    gm: loadGmConfig(env),
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
