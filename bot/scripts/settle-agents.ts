/**
 * Monthly Agent Marketplace settlement: pass revenue x owner share, pro-rata to valid games.
 *   node --env-file=.env --import tsx bot/scripts/settle-agents.ts 2026-11            # dry run
 *   node --env-file=.env --import tsx bot/scripts/settle-agents.ts 2026-11 --send     # allocateAgentPool
 *   ... --token 0x<QUSDC>   (default: native QIE)
 */
import { formatUnits, zeroAddress, type Address } from "viem";
import { operatorFrom } from "../src/chain/operator.js";
import { settleMonth } from "../src/chain/settle.js";
import { loadChainConfig } from "../src/config.js";
import { SqliteStore } from "../src/store.js";

const args = process.argv.slice(2);
const month = args.find((a) => /^\d{4}-\d{2}$/.test(a));
if (!month) throw new Error("usage: settle-agents.ts <YYYY-MM> [--token 0x…] [--send]");
const ti = args.indexOf("--token");
const token = (ti >= 0 && args[ti + 1] ? args[ti + 1] : zeroAddress) as Address;
const send = args.includes("--send");

const c = loadChainConfig();
if (!c.agentRegistryAddress || !c.paymentsAddress) throw new Error("set NOX_AGENT_REGISTRY_ADDRESS and NOX_PAYMENTS_ADDRESS");
const store = new SqliteStore(process.env.NOX_DB_PATH || "data/nox.db");
const r = await settleMonth(store, operatorFrom(c), { registry: c.agentRegistryAddress, payments: c.paymentsAddress, paymentsFromBlock: c.paymentsFromBlock }, month, token, send);

const fmt = (v: bigint) => formatUnits(v, token === zeroAddress ? 18 : 6);
console.log(`Period ${r.period}  token ${token === zeroAddress ? "QIE" : token}`);
console.log(`Pass revenue ${fmt(r.revenue)}  valid games ${r.totalValidGames}  usageRoot ${r.usageRoot}`);
for (const p of r.payouts) console.log(`  agent #${p.agentId} (chain #${r.chainIds.get(p.agentId)}): ${p.validGames} games -> ${fmt(p.amount)}`);
if (r.unregistered.length) console.log(`Not registered on-chain (no payout yet): ${r.unregistered.map((i) => `#${i}`).join(", ")}`);
console.log(`Total ${fmt(r.total)}`);
console.log(r.tx ? `Sent: ${r.tx}` : send ? "Nothing to send." : "Dry run. Add --send to allocate on-chain.");
