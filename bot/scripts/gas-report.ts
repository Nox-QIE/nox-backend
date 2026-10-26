/**
 * Daily gas & fee report (F11-D05) from the bot's transaction ledger (D14), plus the latest operator
 * balance snapshots. Reads only public data from the store; needs no keys.
 *   npm run gas:report            (last 7 days)
 *   npm run gas:report -- 30      (last 30 days)
 */
import { SqliteStore } from "../src/store.js";
import { gasReport, qie } from "../src/treasury.js";

const days = Number(process.argv[2] ?? 7);
if (!Number.isInteger(days) || days < 1) throw new Error("days must be a whole number ≥ 1");
const store = new SqliteStore(process.env.NOX_DB_PATH || "data/nox.db");
const from = Date.now() - days * 86_400_000;
const rows = gasReport(store.txsBetween(from, Date.now() + 1));

if (!rows.length) console.log(`No transactions in the last ${days} day(s).`);
let day = "";
let dayFee = 0n;
const flush = () => day && console.log(`  ${"total".padEnd(20)} ${"".padStart(5)} ${"".padStart(12)} ${qie(dayFee, 12).padStart(18)} QIE`);
for (const r of rows) {
  if (r.day !== day) {
    flush();
    day = r.day;
    dayFee = 0n;
    console.log(`\n${day}  ${"step".padEnd(18)} ${"txs".padStart(5)} ${"gas".padStart(12)} ${"fee".padStart(18)}`);
  }
  dayFee += r.feeWei;
  console.log(`  ${r.step.padEnd(20)} ${String(r.txs).padStart(5)} ${String(r.gasUsed).padStart(12)} ${qie(r.feeWei, 12).padStart(18)} QIE${r.failed ? `  (${r.failed} not successful)` : ""}`);
}
flush();
const balances = store.operatorBalances(from);
if (balances.length) console.log(`\nOperator balance: ${qie(balances.at(-1)!.wei)} QIE at ${new Date(balances.at(-1)!.at).toISOString()} (${balances.length} snapshots)`);
store.close();
