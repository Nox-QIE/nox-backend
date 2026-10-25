import type { GmProvider } from "./gm/model.js";
import { DEFAULT_TIMINGS, type Timings } from "./ports.js";

export interface GmConfig {
  /** "template" (default, no network) or "llm" (Claude via the Anthropic SDK). */
  mode: "template" | "llm";
  /** "anthropic" = Claude API with the SDK's own credentials; "oxion" = Oxion AI gateway. */
  provider: GmProvider;
  model: string;
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
  const provider = env.NOX_GM_PROVIDER ?? "anthropic";
  if (provider !== "anthropic" && provider !== "oxion") throw new Error('NOX_GM_PROVIDER must be "anthropic" or "oxion"');
  const gm: GmConfig = {
    mode,
    provider,
    model: env.NOX_GM_MODEL || "claude-opus-5-5",
    timeoutMs: seconds(env, "NOX_GM_TIMEOUT_SECONDS", 8000),
  };
  if (provider === "oxion") {
    if (env.NOX_GM_BASE_URL) gm.baseURL = env.NOX_GM_BASE_URL;
    if (env.OXION_API_KEY) gm.authToken = env.OXION_API_KEY;
  }
  if (env.NOX_GM_PRICE_PER_M) {
    const [i, o] = env.NOX_GM_PRICE_PER_M.split(",").map(Number);
    if (!Number.isFinite(i) || !Number.isFinite(o)) throw new Error('NOX_GM_PRICE_PER_M must look like "4,20"');
    gm.price = [i!, o!];
  }
  if (mode === "llm" && provider === "oxion" && !gm.authToken) throw new Error("OXION_API_KEY is not set");
  return gm;
}
