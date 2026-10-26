/**
 * Host Pass ledger (D9, F14-D01) and rupiah passes paid by hand (MVP, until a PSP checkout exists).
 *   npm run pass -- list <0xwallet | tg:<telegram-id>>
 *   npm run pass -- fiat <0xwallet | tg:<telegram-id>> <periods> <rupiah> <receipt-file> [--type 1] [--send]
 * `fiat` hashes the receipt (bound to the holder; the file never leaves this machine), refuses a
 * receipt already used, and with --send records NoxPayments.recordFiatPass with the operator key.
 * NoxPayments refuses a repeated receipt since nox-contracts#16; the testnet deployment before it does
 * not, so this script checks too. tg: needs NOX_WALLET_SECRET.
 */
import { existsSync, readFileSync } from "node:fs";
import { formatUnits, type Address } from "viem";
import { isAddress } from "../src/agents.js";
import { receiptHash } from "../src/bookings.js";
import { EventStore } from "../src/chain/indexer.js";
import { operatorFrom, recordFiatPassOnChain } from "../src/chain/operator.js";
import { HOST_PASS } from "../src/chain/passes.js";
import { PlayerWallets } from "../src/chain/wallets.js";
import { loadChainConfig } from "../src/config.js";
import { installLogRedaction, secretsFrom } from "../src/redact.js";
import { SqliteStore } from "../src/store.js";

installLogRedaction(secretsFrom(process.env));
const argv = process.argv.slice(2);
const typeAt = argv.indexOf("--type");
const passType = typeAt >= 0 ? Number(argv[typeAt + 1]) : HOST_PASS;
const args = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--type"));
const [cmd, who, periods, rupiah, receiptFile] = args;

function holderOf(w: string | undefined): Address {
  if (w && isAddress(w)) return w.toLowerCase() as Address;
  const tg = /^tg:(\d+)$/.exec(w ?? "");
  if (tg) {
    if (!process.env.NOX_WALLET_SECRET) throw new Error("tg:<id> needs NOX_WALLET_SECRET to derive the game wallet");
    return PlayerWallets.fromHex(process.env.NOX_WALLET_SECRET).address(Number(tg[1])).toLowerCase() as Address;
  }
  throw new Error("holder must be 0x<wallet> or tg:<telegram-id>");
}

const indexPath = process.env.NOX_INDEX_DB_PATH || "data/index.db";
const index = existsSync(indexPath) ? new EventStore(indexPath) : null;
const store = new SqliteStore(process.env.NOX_DB_PATH || "data/nox.db");

switch (cmd) {
  case "list": {
    const holder = holderOf(who);
    if (!index) throw new Error(`no event index at ${indexPath} (npm run indexer)`);
    console.log(`Passes of ${holder}:`);
    for (const p of index.passPurchases(holder)) {
      const paid = p.rail === "onchain" ? `${formatUnits(p.amount!, 18)} ${p.token === "0x0000000000000000000000000000000000000000" ? "QIE" : p.token}${p.payer !== p.holder ? ` paid by ${p.payer}` : ""}` : `rupiah, receipt ${p.receiptHash}`;
      const local = p.receiptHash ? store.fiatPassByReceipt(p.receiptHash) : null;
      console.log(
        `  ${new Date(p.ts * 1000).toISOString().slice(0, 10)}  type ${p.passType}  ${p.periods} period(s)  ${paid}${local ? ` (Rp ${local.amount.toLocaleString("id-ID")})` : ""}  until ${new Date(p.expiresAt * 1000).toISOString().slice(0, 10)} ${p.status}`,
      );
    }
    break;
  }
  case "fiat": {
    const holder = holderOf(who);
    const n = Number(periods);
    const amount = Number(rupiah);
    if (!Number.isInteger(n) || n < 1 || !Number.isInteger(amount) || amount < 1 || !receiptFile) {
      throw new Error("usage: fiat <0xwallet | tg:<id>> <periods> <rupiah> <receipt-file> [--type 1] [--send]");
    }
    const hash = receiptHash(holder, readFileSync(receiptFile));
    // A NoxPayments deployed before nox-contracts#16 accepts the same receipt twice: refuse it here too.
    if (store.fiatPassByReceipt(hash) || index?.passPurchases(holder).some((p) => p.receiptHash?.toLowerCase() === hash)) {
      throw new Error(`receipt ${hash} was already recorded`);
    }
    console.log(`Receipt hash ${hash}`);
    if (!argv.includes("--send")) {
      console.log(`Dry run. With --send the operator records recordFiatPass(${holder}, ${passType}, ${n}, ${hash}) for Rp ${amount.toLocaleString("id-ID")}.`);
      break;
    }
    const c = loadChainConfig();
    if (!c.paymentsAddress) throw new Error("set NOX_PAYMENTS_ADDRESS");
    const tx = await recordFiatPassOnChain(operatorFrom(c), c.paymentsAddress, holder, passType, n, hash);
    store.addFiatPass({ receiptHash: hash, holder, passType, periods: n, amount, currency: "IDR", tx, at: Date.now() });
    console.log(`Recorded: ${holder} +${n} period(s) of pass ${passType} (tx ${tx}).`);
    break;
  }
  default:
    console.log("commands: list <0xwallet | tg:id> | fiat <0xwallet | tg:id> <periods> <rupiah> <receipt-file> [--type 1] [--send]");
}
index?.close();
store.close();
