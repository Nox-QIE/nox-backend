/**
 * A player wallet's audit history (F01-D05): when it was created, every gas drip with its reason
 * ("onboarding" for the first gas, then "top-up") and amount, and whether the account was deleted.
 * Reads the bot store only; it holds addresses, never Telegram ids or key material.
 *   npm run wallet:audit -- 0x<address>
 */
import { formatEther } from "viem";
import { SqliteStore } from "../src/store.js";

const address = process.argv[2];
if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("usage: wallet:audit 0x<address>");
const store = new SqliteStore(process.env.NOX_DB_PATH || "data/nox.db");
const history = store.walletAudit(address);
if (!history.length) console.log(`No record of ${address} (wallets created before the audit log started have none).`);
for (const e of history) {
  const detail = e.detail?.replace(/(\d+) wei/, (_, w: string) => `${formatEther(BigInt(w))} QIE`) ?? "";
  console.log(`${new Date(e.at).toISOString()}  ${e.event.padEnd(9)} ${detail}`);
}
store.close();
