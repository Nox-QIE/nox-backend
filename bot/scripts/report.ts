/**
 * Game Night engagement report for one client group (F04-S07): reads the bot store (which games ran
 * in the group) and the event index (players and timing from the chain), writes Markdown and JSON.
 * Aggregates only; see src/report.ts for the metric definitions and the privacy rules.
 *   npm run report -- <telegram-chat-id> <YYYY-MM> [id|en] ["Group name"]   (NOX_REPORT_DIR = output folder)
 */
import { writeFileSync } from "node:fs";
import type { Hex } from "viem";
import { EventStore } from "../src/chain/indexer.js";
import { buildReport, reportMarkdown, type ReportGame } from "../src/report.js";
import { SqliteStore } from "../src/store.js";

const [chat, month, lang = "id", name] = process.argv.slice(2);
if (!chat || !/^-?\d+$/.test(chat) || !month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || (lang !== "id" && lang !== "en")) {
  throw new Error('usage: report <telegram-chat-id> <YYYY-MM> [id|en] ["Group name"]');
}
const [y, m] = month.split("-").map(Number) as [number, number];
const from = Date.UTC(y, m - 1, 1);
const to = Date.UTC(y, m, 1);
const store = new SqliteStore(process.env.NOX_DB_PATH || "data/nox.db");
const index = new EventStore(process.env.NOX_INDEX_DB_PATH || "data/index.db");

const games: ReportGame[] = [];
let notIndexed = 0;
for (const g of store.finishedGamesOfChat(Number(chat), from, to)) {
  const d = g.chainGameId ? index.gameDetail(g.chainGameId) : null;
  // Only games finalized on chain count: that is what anyone can verify.
  if (!d || d.status !== "finalized" || d.endedTs === null) {
    notIndexed++;
    continue;
  }
  games.push({ gameId: g.chainGameId as Hex, players: d.players, createdTs: d.createdTs, endedTs: d.endedTs, rounds: d.rounds, credits: d.credits });
}
const web = process.env.NOX_WEB_URL?.replace(/\/+$/, "");
const report = buildReport({
  group: name ?? `Telegram ${chat}`,
  from: new Date(from).toISOString().slice(0, 10),
  to: new Date(to - 1).toISOString().slice(0, 10),
  games,
  ...(web ? { proofUrl: (id: Hex) => `${web}/game/?id=${id}` } : {}),
});
const base = `${(process.env.NOX_REPORT_DIR || ".").replace(/\/+$/, "")}/report-${chat.replace("-", "m")}-${month}`;
writeFileSync(`${base}.md`, reportMarkdown(report, lang));
writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
console.log(`${base}.md / .json: ${report.games} games, ${report.uniquePlayers} unique players${notIndexed ? ` (${notIndexed} game(s) not finalized or not indexed yet, left out)` : ""}`);
