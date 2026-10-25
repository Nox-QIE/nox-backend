import { DEFAULT_TIMINGS, type Timings } from "./ports.js";

export interface Config {
  botToken: string;
  timings: Timings;
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
  };
}
