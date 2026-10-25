import {
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  http,
  type Transport,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { NoxGameAbi } from "./contracts.js";
import type { GameLedger, LedgerNightReveal, LedgerRoleReveal } from "./ledger.js";
import type { PlayerWallets } from "./wallets.js";

export const qieTestnet: Chain = defineChain({
  id: 1983,
  name: "QIE Testnet",
  nativeCurrency: { name: "QIE", symbol: "QIE", decimals: 18 },
  // Checked 25 Oct 2026: rpc1, rpc3 and rpc6 testnet were down.
  rpcUrls: { default: { http: ["https://rpc2testnet.qie.digital/", "https://rpc4testnet.qie.digital/", "https://rpc5testnet.qie.digital/"] } },
  blockExplorers: { default: { name: "QIE Testnet Explorer", url: "https://testnet.qie.digital" } },
});

export const qieMainnet: Chain = defineChain({
  id: 1990,
  name: "QIE Mainnet",
  nativeCurrency: { name: "QIE", symbol: "QIE", decimals: 18 },
  rpcUrls: {
    default: {
      http: [
        "https://rpc1mainnet.qie.digital",
        "https://rpc2mainnet.qie.digital",
        "https://rpc3mainnet.qie.digital",
        "https://rpc4mainnet.qie.digital",
        "https://rpc5mainnet.qie.digital",
      ],
    },
  },
  blockExplorers: { default: { name: "QIE Explorer", url: "https://mainnet.qie.digital" } },
});

/** One RPC when overridden, otherwise every RPC of the chain in order, failing over on errors. */
export function rpcTransport(chain: Chain, rpcUrl?: string): Transport {
  if (rpcUrl) return http(rpcUrl);
  const urls = chain.rpcUrls.default.http;
  return urls.length === 1 ? http(urls[0]) : fallback(urls.map((u) => http(u, { timeout: 10_000 })));
}

export interface ViemLedgerOptions {
  chain: Chain;
  /** Overrides the chain's RPC list (no failover). */
  rpcUrl?: string;
  gameAddress: Address;
  operatorKey: Hex;
  wallets: PlayerWallets;
  /** Top a player up to `dripAmount` when their balance is below `minBalance` (wei). */
  minBalance: bigint;
  dripAmount: bigint;
  /** Most wei one player can receive per UTC day, and the most all players together can (abuse guard). */
  dripDailyCapPerPlayer?: bigint;
  dripDailyBudget?: bigint;
  /** How often to poll for receipts (ms). Default 1000. */
  pollingMs?: number;
  /** Called once a game is finalized or cancelled on-chain (to mark it settled in the store). */
  onSettled?: (gameId: Hex, outcome: "finalized" | "cancelled") => void;
  log?: (line: Record<string, unknown>) => void;
}

/** Runs async jobs one after another; a failed job is logged and the next one still runs. */
class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(job, job);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/**
 * NoxGame through viem. Each game has its own queue so its transactions land in order; the operator
 * has one global queue because all games share its nonce. Every player transaction is sent from
 * that player's own derived wallet, after a gas drip from the operator if needed, so each human
 * shows up as an active account on the explorer. A failed game marks itself and skips the rest.
 */
export class ViemLedger implements GameLedger {
  readonly enabled = true;
  readonly publicClient: PublicClient;
  private readonly operator: Account;
  private readonly operatorQueue = new SerialQueue();
  private readonly gameQueues = new Map<Hex, SerialQueue>();
  private readonly failed = new Set<Hex>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly transport: Transport;
  private dripDay = "";
  private readonly drippedToday = new Map<Address, bigint>();
  private drippedTotalToday = 0n;

  constructor(private readonly o: ViemLedgerOptions) {
    this.transport = rpcTransport(o.chain, o.rpcUrl);
    this.publicClient = createPublicClient({ chain: o.chain, transport: this.transport, pollingInterval: o.pollingMs ?? 1000 }) as PublicClient;
    this.operator = privateKeyToAccount(o.operatorKey);
  }

  addressOf(userId: number) {
    return this.o.wallets.address(userId);
  }

  get operatorAddress() {
    return this.operator.address;
  }

  /** Resolves once every queued job (all games) has finished. Used by tests and on shutdown. */
  async idle() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  isFailed(gameId: Hex) {
    return this.failed.has(gameId);
  }

  async statusOf(gameId: Hex): Promise<number> {
    const g = await this.publicClient.readContract({ address: this.o.gameAddress, abi: NoxGameAbi, functionName: "games", args: [gameId] });
    return Number(g[0]);
  }

  // ------------------------------------------------------------ GameLedger

  startGame(gameId: Hex, configHash: Hex, players: number[], rolesRoot: Hex) {
    this.enqueue(gameId, "start", async () => {
      await this.asOperator("createGame", [gameId, configHash]);
      // Joins come from different wallets, so they can be in flight together.
      await Promise.all(players.map((p) => this.asPlayer(p, "joinGame", [gameId])));
      await this.asOperator("commitRoles", [gameId, rolesRoot]);
    });
  }

  commitNightAction(gameId: Hex, round: number, userId: number, actionHash: Hex) {
    this.enqueue(gameId, "commitNightAction", () => this.asPlayer(userId, "commitNightAction", [gameId, round, actionHash]));
  }

  castVote(gameId: Hex, round: number, userId: number, targetUserId: number) {
    this.enqueue(gameId, "castVote", () => this.asPlayer(userId, "castVote", [gameId, round, this.addressOf(targetUserId)]));
  }

  recordRound(gameId: Hex, round: number, resultHash: Hex) {
    this.enqueue(gameId, "recordRound", () => this.asOperator("recordRound", [gameId, round, resultHash]));
  }

  finalize(gameId: Hex, roles: LedgerRoleReveal[], nights: LedgerNightReveal[], resultHash: Hex, winner: number) {
    this.enqueue(gameId, "finalize", async () => {
      const r = roles.map((x) => ({ player: this.addressOf(x.userId), role: x.role, salt: x.salt, proof: x.proof }));
      const n = nights.map((x) => ({
        round: x.round,
        player: this.addressOf(x.userId),
        action: x.action,
        target: this.addressOf(x.targetUserId),
        nonce: x.nonce,
      }));
      await this.asOperator("revealAndFinalize", [gameId, r, n, resultHash, winner]);
      this.gameQueues.delete(gameId);
      this.o.onSettled?.(gameId, "finalized");
    });
  }

  cancel(gameId: Hex, reason: string) {
    this.enqueue(gameId, "cancel", async () => {
      await this.asOperator("cancelGame", [gameId, reason]);
      this.gameQueues.delete(gameId);
      this.o.onSettled?.(gameId, "cancelled");
    });
  }

  // ------------------------------------------------------------ internals

  private enqueue(gameId: Hex, step: string, job: () => Promise<unknown>) {
    let q = this.gameQueues.get(gameId);
    if (!q) this.gameQueues.set(gameId, (q = new SerialQueue()));
    const p = q
      .run(async () => {
        // After a failure only a cancel may still run, so the game does not stay "Running" forever.
        if (this.failed.has(gameId) && step !== "cancel") return;
        try {
          await job();
        } catch (e) {
          const first = !this.failed.has(gameId);
          this.failed.add(gameId);
          this.o.log?.({ event: "chain_error", gameId, step, error: e instanceof Error ? e.message.split("\n")[0] : String(e) });
          // A failed finalize keeps its record for the boot-time retry; any other failure cancels the game.
          if (first && step !== "finalize" && step !== "cancel") this.cancel(gameId, `chain error at ${step}`);
        }
      })
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  private async send(account: Account, functionName: string, args: readonly unknown[]): Promise<Hex> {
    const wallet = createWalletClient({ account, chain: this.o.chain, transport: this.transport });
    // Simulate first so a revert surfaces with its custom error instead of burning gas.
    const { request } = await this.publicClient.simulateContract({
      account,
      address: this.o.gameAddress,
      abi: NoxGameAbi,
      functionName: functionName as never,
      args: args as never,
    });
    const hash = await wallet.writeContract(request as never);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
    return hash;
  }

  private asOperator(functionName: string, args: readonly unknown[]) {
    return this.operatorQueue.run(() => this.send(this.operator, functionName, args));
  }

  private async asPlayer(userId: number, functionName: string, args: readonly unknown[]) {
    const account = this.o.wallets.account(userId);
    await this.drip(account.address);
    return this.send(account, functionName, args);
  }

  /** Reserve today's drip allowance for `to`, or throw when a cap would be exceeded. */
  private reserveDrip(to: Address, wei: bigint) {
    const day = new Date().toISOString().slice(0, 10);
    if (day !== this.dripDay) {
      this.dripDay = day;
      this.drippedToday.clear();
      this.drippedTotalToday = 0n;
    }
    const mine = (this.drippedToday.get(to) ?? 0n) + wei;
    const total = this.drippedTotalToday + wei;
    if (this.o.dripDailyCapPerPlayer !== undefined && mine > this.o.dripDailyCapPerPlayer) {
      throw new Error(`gas drip refused: ${to} reached its daily cap`);
    }
    if (this.o.dripDailyBudget !== undefined && total > this.o.dripDailyBudget) {
      throw new Error("gas drip refused: daily gas budget used up");
    }
    this.drippedToday.set(to, mine);
    this.drippedTotalToday = total;
  }

  private async drip(to: Address) {
    const balance = await this.publicClient.getBalance({ address: to });
    if (balance >= this.o.minBalance) return;
    this.reserveDrip(to, this.o.dripAmount - balance);
    await this.operatorQueue.run(async () => {
      const wallet = createWalletClient({ account: this.operator, chain: this.o.chain, transport: this.transport });
      const hash = await wallet.sendTransaction({ to, value: this.o.dripAmount - balance, chain: this.o.chain });
      await this.publicClient.waitForTransactionReceipt({ hash });
      this.o.log?.({ event: "gas_drip", to, wei: (this.o.dripAmount - balance).toString(), hash });
    });
  }
}
