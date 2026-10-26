import { loadConfig } from "./config.js";
import { installLogRedaction, secretsFrom } from "./redact.js";

// Before anything can log: keys and tokens never reach the output (F11-D04).
installLogRedaction(secretsFrom(process.env));
import { createNoxBot } from "./telegram.js";
import { WEBHOOK_PATH, webhookServer } from "./webhook.js";

const config = loadConfig();
const { bot } = await createNoxBot(config);

await bot.api.setMyCommands([
  { command: "newgame", description: "Open a Nox lobby (horror, fantasy, office, or scamshield)" },
  { command: "start", description: "Enable DMs so you can receive your secret role" },
  { command: "privacy", description: "What Nox stores and what goes on-chain" },
  { command: "forget", description: "Delete your off-chain data (in a private chat with the bot)" },
]);

const allowed_updates = ["message", "callback_query"] as const;
const gmLabel = config.gm.mode === "llm" ? config.gm.pool.map((e) => `${e.provider}:${e.model}@${e.weight}`).join(", ") : "template";

if (config.webhook) {
  const { url, secret, port, host } = config.webhook;
  const server = webhookServer(bot, secret);
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  await bot.api.setWebhook(`${url}${WEBHOOK_PATH}`, { secret_token: secret, allowed_updates: [...allowed_updates] });
  const stop = () => server.close();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.log(`Nox bot @${bot.botInfo.username} running (webhook ${url}${WEBHOOK_PATH} → ${host}:${port}, chain: ${config.chain.network}, GM: ${gmLabel})`);
} else {
  const stop = () => void bot.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.log(`Nox bot @${bot.botInfo.username} running (long polling, chain: ${config.chain.network}, GM: ${gmLabel})`);
  // bot.start removes any webhook first, so switching back from webhook mode just works.
  await bot.start({ allowed_updates: [...allowed_updates] });
}
