import { loadConfig } from "./config.js";
import { createNoxBot } from "./telegram.js";

const config = loadConfig();
const { bot } = await createNoxBot(config);

await bot.api.setMyCommands([
  { command: "newgame", description: "Open a Nox lobby in this group" },
  { command: "start", description: "Enable DMs so you can receive your secret role" },
]);

const stop = () => void bot.stop();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

console.log(`Nox bot @${bot.botInfo.username} running (long polling, chain: ${config.chain.network}, GM: ${config.gm.mode === "llm" ? config.gm.pool.map((e) => `${e.provider}:${e.model}@${e.weight}`).join(", ") : "template"})`);
await bot.start({ allowed_updates: ["message", "callback_query"] });
