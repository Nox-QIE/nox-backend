import {
  BaseError,
  ContractFunctionRevertedError,
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

export const anvilChain: Chain = defineChain({
  id: 31337,
  name: "Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

export function chainFor(network: "local" | "testnet" | "mainnet"): Chain {
  return network === "mainnet" ? qieMainnet : network === "testnet" ? qieTestnet : anvilChain;
}

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
  /** Replaces the RPC transport (tests use it to simulate a misbehaving node). */
  transport?: Transport;
  /** Tries per transaction before the game is cancelled. Default 3. */
  maxAttempts?: number;
  /** Wait before retry n is n × this (ms). Default 1500. */
  retryDelayMs?: number;
  /** Called once a game is finalized, cancelled or disputed on-chain (to mark it settled in the store). */
  onSettled?: (gameId: Hex, outcome: "finalized" | "cancelled" | "disputed") => void;
  /** A game ended as Disputed: the reveal failed verification, or someone claimed the reveal timeout. */
  onDisputed?: (gameId: Hex, reason: "reveal_mismatch" | "reveal_timeout", detail: string) => void;
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
 * One game's on-chain steps. Ordered steps (create, commitRoles, recordRound, finalize, cancel) are
 * barriers: they wait for everything before them. Player actions between two barriers (the votes of
 * a day, the night commitments) come from different wallets and run in parallel, so a full table
 * lands in one or two blocks instead of one block per player.
 */
class GameQueue {
  private barrier: Promise<unknown> = Promise.resolve();
  private parallel: Promise<unknown>[] = [];

  run(job: () => Promise<void>, parallel: boolean): Promise<void> {
    if (parallel) {
      const p = this.barrier.then(job);
      this.parallel.push(p.catch(() => undefined));
      return p;
    }
    const p = Promise.allSettled([this.barrier, ...this.parallel]).then(job);
    this.barrier = p.catch(() => undefined);
    this.parallel = [];
    return p;
  }
}

/**
 * Gas floors per NoxGame function: the most each used in the contract tests (12 players for
 * revealAndFinalize), plus margin. On 26 Oct 2026 a QIE testnet RPC answered eth_estimateGas with
 * 22088 for createGame (the cost of calling an address with no code, as if a lagging node lacked
 * the contract); the transaction ran out of gas. Never send less than these.
 */
export const GAS_FLOOR: Record<string, bigint> = {
  createGame: 110_000n,
  joinGame: 150_000n,
  commitRoles: 90_000n,
  commitNightAction: 90_000n,
  castVote: 90_000n,
  recordRound: 90_000n,
  revealAndFinalize: 1_800_000n,
  cancelGame: 60_000n,
  reportDispute: 60_000n,
};

/** Gas limit to send: the node's estimate plus 25%, but never below the function's floor. */
export function gasLimitFor(functionName: string, estimate: bigint): bigint {
  const floor = GAS_FLOOR[functionName] ?? 100_000n;
  const padded = (estimate * 125n) / 100n;
  return padded > floor ? padded : floor;
}

/** A mined transaction that reverted: final, retrying would only burn gas again. */
class TxRevertedError extends Error {}
/** A gas drip refused by the daily caps: final until tomorrow. */
class DripRefusedError extends Error {}

const STATUS_FINALIZED = 3;
const STATUS_CANCELLED = 4;
const STATUS_DISPUTED = 5;

/** Reverts that mean the reveal itself does not match the commitments: retrying cannot help. */
const REVEAL_MISMATCH = new Set(["BadReveal", "BadNightReveal", "RevealCountMismatch"]);

/** The contract's custom error behind a viem error, if any. */
export function revertOf(err: unknown): { errorName: string; args: readonly unknown[] } | null {
  const revert = err instanceof BaseError ? err.walk((e) => e instanceof ContractFunctionRevertedError) : null;
  const data = (revert as ContractFunctionRevertedError | null)?.data;
  return data ? { errorName: data.errorName, args: data.args ?? [] } : null;
}

/** The game was already marked Disputed on-chain (someone claimed the reveal timeout). */
const isDisputedOnChain = (err: unknown) => {
  const r = revertOf(err);
  return r?.errorName === "WrongStatus" && Number(r.args[1]) === STATUS_DISPUTED;
};

/**
 * Whether a retry's revert shows the step already happened: the earlier attempt reached the chain
 * even though we saw an error (a lost RPC response, a node that answered late).
 */
export function alreadyDone(functionName: string, err: unknown): boolean {
  const data = revertOf(err);
  if (!data) return false;
  const args = data.args as readonly (number | bigint)[];
  switch (data.errorName) {
    case "AlreadyExists":
      return functionName === "createGame";
    case "AlreadyJoined":
      return functionName === "joinGame";
    case "AlreadyCommitted":
      return functionName === "commitNightAction";
    case "AlreadyVoted":
      return functionName === "castVote";
    case "WrongStatus": {
      const actual = Number(args[1]);
      return (
        (functionName === "commitRoles" && actual >= 2) ||
        (functionName === "revealAndFinalize" && actual === STATUS_FINALIZED) ||
        (functionName === "cancelGame" && actual === STATUS_CANCELLED) ||
        (functionName === "reportDispute" && actual === STATUS_DISPUTED)
      );
    }
    case "WrongRound":
      // recordRound(r) moves the game to round r + 1, so a repeat sees expected = actual + 1.
      return functionName === "recordRound" && Number(args[0]) === Number(args[1]) + 1;
  }
  return false;
}

/** Player actions that may run in parallel with each other (different wallets, same phase). */
const PARALLEL_STEPS = new Set(["commitNightAction", "castVote"]);

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
  private readonly gameQueues = new Map<Hex, GameQueue>();
  /** One queue per player wallet, so a player's own transactions never race on their nonce. */
  private readonly playerQueues = new Map<Address, SerialQueue>();
  /** Operator nonce kept locally so operator transactions can be pipelined. */
  private operatorNonce: number | null = null;
  private readonly failed = new Set<Hex>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly transport: Transport;
  private dripDay = "";
  private readonly drippedToday = new Map<Address, bigint>();
  private drippedTotalToday = 0n;

  constructor(private readonly o: ViemLedgerOptions) {
    this.transport = o.transport ?? rpcTransport(o.chain, o.rpcUrl);
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
      // Joins come from different wallets, so they can be in flight together. Wait for all of them
      // to settle before failing, so a later cancel never races joins or drips still in flight.
      const joins = await Promise.allSettled(players.map((p) => this.asPlayer(p, "joinGame", [gameId])));
      const failed = joins.find((j): j is PromiseRejectedResult => j.status === "rejected");
      if (failed) throw failed.reason;
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
      try {
        await this.asOperator("revealAndFinalize", [gameId, r, n, resultHash, winner]);
      } catch (e) {
        const revert = revertOf(e);
        if (revert && REVEAL_MISMATCH.has(revert.errorName)) {
          // Our own reveal does not match what we committed: say so on-chain instead of cancelling.
          await this.asOperator("reportDispute", [gameId, revert.errorName]);
          return this.settle(gameId, "disputed", "reveal_mismatch", revert.errorName);
        }
        if (isDisputedOnChain(e)) return this.settle(gameId, "disputed", "reveal_timeout", "claimed on-chain before the reveal");
        throw e;
      }
      this.settle(gameId, "finalized");
    });
  }

  cancel(gameId: Hex, reason: string) {
    this.enqueue(gameId, "cancel", async () => {
      try {
        await this.asOperator("cancelGame", [gameId, reason]);
      } catch (e) {
        if (isDisputedOnChain(e)) return this.settle(gameId, "disputed", "reveal_timeout", "claimed on-chain before the cancel");
        throw e;
      }
      this.settle(gameId, "cancelled");
    });
  }

  private settle(gameId: Hex, outcome: "finalized" | "cancelled" | "disputed", reason?: "reveal_mismatch" | "reveal_timeout", detail = "") {
    this.gameQueues.delete(gameId);
    this.o.onSettled?.(gameId, outcome);
    if (outcome === "disputed" && reason) {
      this.o.log?.({ event: "game_disputed", gameId, reason, detail });
      this.o.onDisputed?.(gameId, reason, detail);
    }
  }

  // ------------------------------------------------------------ internals

  private enqueue(gameId: Hex, step: string, job: () => Promise<unknown>) {
    let q = this.gameQueues.get(gameId);
    if (!q) this.gameQueues.set(gameId, (q = new GameQueue()));
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
      }, PARALLEL_STEPS.has(step))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  /** Simulate (so a revert surfaces with its custom error instead of burning gas), then submit. */
  private async submit(account: Account, functionName: string, args: readonly unknown[], nonce?: number): Promise<Hex> {
    const wallet = createWalletClient({ account, chain: this.o.chain, transport: this.transport });
    const call = { account, address: this.o.gameAddress, abi: NoxGameAbi, functionName: functionName as never, args: args as never };
    const { request } = await this.publicClient.simulateContract(call);
    const gas = gasLimitFor(functionName, await this.publicClient.estimateContractGas(call));
    return wallet.writeContract({ ...(request as object), gas, ...(nonce !== undefined ? { nonce } : {}) } as never);
  }

  private async confirm(hash: Hex, what: string) {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== "success") throw new TxRevertedError(`${what} reverted (${hash})`);
  }

  /**
   * Send and confirm one transaction, retrying up to maxAttempts (F05-S06, F11-S05). Before anything
   * was broadcast every error is retried (a simulated revert costs nothing; a lagging node may revert
   * wrongly). Once a hash exists, only its receipt is awaited again, never a second copy. A mined
   * revert is final. On a retry, `done` tells whether the earlier attempt landed after all.
   */
  private async withRetry(what: string, send: () => Promise<Hex>, done: (err: unknown) => Promise<boolean> | boolean): Promise<Hex | null> {
    const max = this.o.maxAttempts ?? 3;
    let hash: Hex | undefined;
    let last: unknown;
    for (let attempt = 1; ; attempt++) {
      try {
        // Nothing to wait for from the last try: make sure it did not land before sending again.
        if (attempt > 1 && !hash && (await done(last))) {
          this.o.log?.({ event: "chain_retry_done", what, attempt });
          return null;
        }
        hash ??= await send();
        await this.confirm(hash, what);
        return hash;
      } catch (e) {
        if (e instanceof TxRevertedError || e instanceof DripRefusedError) throw e;
        // A reveal that does not match, or a game already disputed, will not change on a retry.
        if (REVEAL_MISMATCH.has(revertOf(e)?.errorName ?? "") || isDisputedOnChain(e)) throw e;
        if (attempt > 1 && !hash && (await done(e))) {
          this.o.log?.({ event: "chain_retry_done", what, attempt });
          return null;
        }
        if (attempt >= max) throw e;
        last = e;
        this.o.log?.({ event: "chain_retry", what, attempt, error: e instanceof Error ? e.message.split("\n")[0] : String(e) });
        await new Promise((r) => setTimeout(r, (this.o.retryDelayMs ?? 1500) * attempt));
      }
    }
  }

  /**
   * Operator transactions are submitted one by one with a locally tracked nonce, but confirmed in
   * parallel, so drips and operator calls from many games share blocks instead of queuing a block each.
   */
  private async operatorSend(submit: (nonce: number) => Promise<Hex>): Promise<Hex> {
    return this.operatorQueue.run(async () => {
      this.operatorNonce ??= await this.publicClient.getTransactionCount({ address: this.operator.address, blockTag: "pending" });
      try {
        const hash = await submit(this.operatorNonce);
        this.operatorNonce++;
        return hash;
      } catch (e) {
        this.operatorNonce = null; // resync from the chain on the next send
        throw e;
      }
    });
  }

  private async asOperator(functionName: string, args: readonly unknown[]) {
    return this.withRetry(
      functionName,
      () => this.operatorSend((nonce) => this.submit(this.operator, functionName, args, nonce)),
      (e) => alreadyDone(functionName, e),
    );
  }

  private async asPlayer(userId: number, functionName: string, args: readonly unknown[]) {
    const account = this.o.wallets.account(userId);
    let q = this.playerQueues.get(account.address);
    if (!q) this.playerQueues.set(account.address, (q = new SerialQueue()));
    return q.run(async () => {
      await this.drip(account.address);
      return this.withRetry(
        functionName,
        () => this.submit(account, functionName, args),
        (e) => alreadyDone(functionName, e),
      );
    });
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
      throw new DripRefusedError(`gas drip refused: ${to} reached its daily cap`);
    }
    if (this.o.dripDailyBudget !== undefined && total > this.o.dripDailyBudget) {
      throw new DripRefusedError("gas drip refused: daily gas budget used up");
    }
    this.drippedToday.set(to, mine);
    this.drippedTotalToday = total;
  }

  private async drip(to: Address) {
    const balance = await this.publicClient.getBalance({ address: to });
    if (balance >= this.o.minBalance) return;
    this.reserveDrip(to, this.o.dripAmount - balance);
    const wallet = createWalletClient({ account: this.operator, chain: this.o.chain, transport: this.transport });
    const value = this.o.dripAmount - balance;
    // A drip that was sent but whose response got lost shows up as a topped-up balance: never send twice.
    const hash = await this.withRetry(
      "gas drip",
      () => this.operatorSend((nonce) => wallet.sendTransaction({ to, value, nonce, chain: this.o.chain })),
      async () => (await this.publicClient.getBalance({ address: to })) >= this.o.minBalance,
    );
    this.o.log?.({ event: "gas_drip", to, wei: value.toString(), hash });
  }
}
