/**
 * Event indexer service (F12-S01): keeps data/index.db in step with the Nox contracts on the chain
 * in .env and serves the public read-only API (F12-D05) on NOX_API_PORT (default 8787, "off" to
 * disable). Read-only: needs NOX_CHAIN, NOX_GAME_ADDRESS and the deploy block, no keys.
 *   npm run indexer            (keeps polling and serving; Ctrl+C to stop)
 *   npm run indexer -- --once  (catch up once, print stats and exit)
 */
import { createPublicClient, type Abi } from "viem";
import { createApi } from "../src/api.js";
import { loadIndexerConfig } from "../src/config.js";
import { NoxAgentRegistryAbi, NoxCreditsAbi, NoxGameAbi, NoxPaymentsAbi } from "../src/chain/contracts.js";
import { EventIndexer, EventStore, reconcileCredits, type IndexedContract, type IndexerClient } from "../src/chain/indexer.js";
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

const balanceAt = (account: `0x${string}`, blockNumber: bigint) =>
  client.readContract({ address: credits, abi: NoxCreditsAbi, functionName: "balanceOf", args: [account], blockNumber });
const reconcile = async () => {
  const r = await reconcileCredits(store, balanceAt);
  const bad = r.mismatches.length > 0 || r.orphanMints > 0;
  log({ event: bad ? "credits_mismatch" : "credits_reconciled", block: r.block, checked: r.checked, mismatches: r.mismatches, orphanMints: r.orphanMints });
};

if (process.argv.includes("--once")) {
  const r = await indexer.syncOnce();
  store.refreshPlayerStats();
  log({ event: "index_synced", events: r.events, block: r.block.toString(), stats: store.stats() });
  if (c.reconcileMinutes !== null) await reconcile();
  store.close();
} else {
  const api = c.api ? createApi({ store, network: c.network, chainId: chain.id, trustProxy: c.api.trustProxy, ratePerMinute: c.api.ratePerMinute, log }) : null;
  api?.on("error", (err) => {
    log({ event: "api_error", error: err.message });
    process.exit(1);
  });
  if (c.api && api) api.listen(c.api.port, c.api.host, () => log({ event: "api_listening", url: `http://${c.api!.host}:${c.api!.port}/v1/health` }));
  let stopping = false;
  const stop = () => {
    stopping = true;
    api?.close();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let lastRefresh = 0;
  let lastReconcile = 0;
  while (!stopping) {
    try {
      const r = await indexer.syncOnce();
      if (r.events) log({ event: "index_synced", events: r.events, block: r.block.toString() });
      // Streaks break with time alone, so the D7 mirror is also rebuilt every hour.
      if (Date.now() - lastRefresh >= 3600_000) {
        store.refreshPlayerStats();
        lastRefresh = Date.now();
      }
      if (c.reconcileMinutes !== null && Date.now() - lastReconcile >= c.reconcileMinutes * 60_000) {
        lastReconcile = Date.now();
        await reconcile();
      }
    } catch (err) {
      // RPC hiccups are expected on QIE; the checkpoint makes the next round resume where this one stopped.
      log({ event: "index_error", error: err instanceof Error ? err.message.split("\n")[0] : String(err) });
    }
    await new Promise((r) => setTimeout(r, c.pollMs));
  }
  store.close();
}
