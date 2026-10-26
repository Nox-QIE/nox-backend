/**
 * Event indexer service (F12-S01): keeps data/index.db in step with the Nox contracts on the chain
 * in .env. Read-only: needs NOX_CHAIN, NOX_GAME_ADDRESS and the deploy block, no keys.
 *   npm run indexer            (keeps polling; Ctrl+C to stop)
 *   npm run indexer -- --once  (catch up once, print stats and exit)
 */
import { createPublicClient, type Abi } from "viem";
import { loadIndexerConfig } from "../src/config.js";
import { NoxAgentRegistryAbi, NoxCreditsAbi, NoxGameAbi, NoxPaymentsAbi } from "../src/chain/contracts.js";
import { EventIndexer, EventStore, type IndexedContract, type IndexerClient } from "../src/chain/indexer.js";
import { chainFor, rpcTransport } from "../src/chain/viem-ledger.js";

const c = loadIndexerConfig();
const chain = chainFor(c.network);
const client = createPublicClient({ chain, transport: rpcTransport(chain, c.rpcUrl) });
const log = (entry: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), ...entry }));

const credits = await client.readContract({ address: c.gameAddress, abi: NoxGameAbi, functionName: "credits" });
const contracts: IndexedContract[] = [
  { name: "NoxGame", address: c.gameAddress, abi: NoxGameAbi as Abi },
  { name: "NoxCredits", address: credits, abi: NoxCreditsAbi as Abi },
];
if (c.agentRegistryAddress) contracts.push({ name: "NoxAgentRegistry", address: c.agentRegistryAddress, abi: NoxAgentRegistryAbi as Abi });
if (c.paymentsAddress) contracts.push({ name: "NoxPayments", address: c.paymentsAddress, abi: NoxPaymentsAbi as Abi });

const store = new EventStore(c.dbPath);
const indexer = new EventIndexer({ client: client as unknown as IndexerClient, store, contracts, fromBlock: c.fromBlock, confirmations: c.confirmations, log });
log({ event: "index_start", network: c.network, contracts: contracts.map((x) => x.name), fromBlock: c.fromBlock.toString(), db: c.dbPath });

if (process.argv.includes("--once")) {
  const r = await indexer.syncOnce();
  log({ event: "index_synced", events: r.events, block: r.block.toString(), stats: store.stats() });
  store.close();
} else {
  let stopping = false;
  process.on("SIGINT", () => (stopping = true));
  process.on("SIGTERM", () => (stopping = true));
  while (!stopping) {
    try {
      const r = await indexer.syncOnce();
      if (r.events) log({ event: "index_synced", events: r.events, block: r.block.toString() });
    } catch (err) {
      // RPC hiccups are expected on QIE; the checkpoint makes the next round resume where this one stopped.
      log({ event: "index_error", error: err instanceof Error ? err.message.split("\n")[0] : String(err) });
    }
    await new Promise((r) => setTimeout(r, c.pollMs));
  }
  store.close();
}
