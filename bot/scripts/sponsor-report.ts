/**
 * Scam Shield sponsor report (F10-S07): counts for one season, from the bot store (games, practice)
 * and, when present, the event index (Scam Spotter badges on chain). Writes Markdown and JSON.
 *   npm run sponsor:report -- <YYYY-MM | YYYY-MM-DD..YYYY-MM-DD> "<Sponsor>" [id|en]   (NOX_REPORT_DIR = output folder)
 */
import { existsSync, writeFileSync } from "node:fs";
import { keccak256, toHex } from "viem";
import { EventStore } from "../src/chain/indexer.js";
import { buildSponsorReport, sponsorMarkdown } from "../src/sponsor.js";
import { SqliteStore } from "../src/store.js";

const [period, sponsor, lang = "id"] = process.argv.slice(2);
const month = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period ?? "");
const range = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(period ?? "");
if ((!month && !range) || !sponsor?.trim() || (lang !== "id" && lang !== "en")) throw new Error('usage: sponsor:report <YYYY-MM | YYYY-MM-DD..YYYY-MM-DD> "<Sponsor>" [id|en]');
const from = month ? Date.UTC(Number(month[1]), Number(month[2]) - 1, 1) : Date.parse(`${range![1]}T00:00Z`);
// A date range includes its last day.
const to = month ? Date.UTC(Number(month[1]), Number(month[2]), 1) : Date.parse(`${range![2]}T00:00Z`) + 86_400_000;
if (!(to > from)) throw new Error("the period must end after it starts");
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const store = new SqliteStore(process.env.NOX_DB_PATH || "data/nox.db");
const indexPath = process.env.NOX_INDEX_DB_PATH || "data/index.db";
const index = existsSync(indexPath) ? new EventStore(indexPath) : null;
const report = buildSponsorReport({
  sponsor: sponsor.trim(),
  from: day(from),
  to: day(to - 1),
  games: store.scenarioGames(from, to),
  practice: store.practiceStats(day(from)).filter((p) => p.day < day(to)),
  ...(index ? { badges: index.badgesAwarded(keccak256(toHex("SCAM_SPOTTER")), from / 1000, to / 1000) } : {}),
});
const base = `${(process.env.NOX_REPORT_DIR || ".").replace(/\/+$/, "")}/sponsor-${period!.replace("..", "_")}`;
writeFileSync(`${base}.md`, sponsorMarkdown(report, lang));
writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
console.log(`${base}.md / .json: ${report.games} Scam Shield games, ${report.spotted} spotted, practice ${report.practice.finished}/${report.practice.started}${index ? "" : " (no event index: badges left out)"}`);
index?.close();
store.close();
