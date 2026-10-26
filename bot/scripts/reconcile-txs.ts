/**
 * Check every transaction the bot recorded as successful against the events in the index (F07-D05).
 * Reads the bot store and the index; needs no keys.
 *   npm run reconcile:txs            (last 7 days)
 *   npm run reconcile:txs -- 30
 */
import { EventStore } from "../src/chain/indexer.js";
import { SqliteStore } from "../src/store.js";
import { reconcileTxs } from "../src/tx-reconcile.js";

const days = Number(process.argv[2] ?? 7);
if (!Number.isInteger(days) || days < 1) throw new Error("days must be a whole number ≥ 1");
const store = new SqliteStore(process.env.NOX_DB_PATH || "data/nox.db");
const index = new EventStore(process.env.NOX_INDEX_DB_PATH || "data/index.db");
const r = reconcileTxs(store.txsBetween(Date.now() - days * 86_400_000, Date.now() + 1), (h) => index.eventsOfTx(h), index.indexedBlock());
console.log(`checked ${r.checked} transaction(s), skipped ${r.skipped} (failed, no event expected, or not indexed yet), missing events: ${r.missing.length}`);
for (const m of r.missing) console.log(`  ${m.step} ${m.hash} (block ${m.block}, game ${m.gameId ?? "-"}): no ${m.expected}`);
process.exitCode = r.missing.length ? 1 : 0;
