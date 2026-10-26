import { createServer, type Server } from "node:http";
import { webhookCallback, type Bot } from "grammy";

export const WEBHOOK_PATH = "/telegram/webhook";

/**
 * Webhook mode (L0-01). Telegram signs nothing, but setWebhook's secret_token comes back in the
 * X-Telegram-Bot-Api-Secret-Token header of every update; grammY answers 401 when it does not match,
 * so only Telegram can push updates. Also serves GET /healthz for the hosting platform.
 */
export function webhookServer(bot: Bot, secret: string): Server {
  const handle = webhookCallback(bot, "http", { secretToken: secret });
  return createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (req.method === "POST" && path === WEBHOOK_PATH) return void handle(req, res);
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
}
