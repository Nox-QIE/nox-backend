import type { BadgeKey } from "../moments.js";
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
  parseEventLogs,
  keccak256,
  toHex,
  type Abi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { NoxBadgesAbi, NoxGameAbi } from "./contracts.js";
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
  /** NoxBadges, for achievement badges after finalized games (optional). */
  badgesAddress?: Address;
  /** Tries per transaction before the game is cancelled. Default 3. */
  maxAttempts?: number;
  /** Wait before retry n is n × this (ms). Default 1500. */
  retryDelayMs?: number;
  /** Called once a game is finalized, cancelled or disputed on-chain (to mark it settled in the store). */
  onSettled?: (gameId: Hex, outcome: "finalized" | "cancelled" | "disputed") => void;
  /** Every transaction the ledger sent or gave up on, for the gas & transaction ledger (D14). */
  onTx?: (tx: TxRecord) => void;
  /** The operator's balance, read after gas drips and finalizes (at most once a minute). */
  onOperatorBalance?: (wei: bigint) => void;
  /** Each player's credits as minted at finalize (from RewardGranted), with their daily streak. */
  onRewards?: (gameId: Hex, rewards: PlayerReward[]) => void;
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
 * barriers: they wait for everything before them. Player actions of one kind (the night commitments,
 * the votes of a day) come from different wallets and run in parallel, so a full table lands in one
 * or two blocks instead of one block per player. A switch to another kind (night → day) waits for
 * the previous kind, so no vote lands on chain before a night commitment of the same round.
 */
export class GameQueue {
  private barrier: Promise<unknown> = Promise.resolve();
  private parallel: Promise<unknown>[] = [];
  private group: string | null = null;

  /** `group` = the kind of a parallel player action, or null for an ordered step. */
  run(job: () => Promise<void>, group: string | null): Promise<void> {
    if (group !== null && group === this.group) {
      const p = this.barrier.then(job);
      this.parallel.push(p.catch(() => undefined));
      return p;
    }
    const before = Promise.allSettled([this.barrier, ...this.parallel]);
    this.parallel = [];
    this.group = group;
    if (group !== null) {
      // First action of a new kind: it and the rest of its kind wait for everything before.
      this.barrier = before;
      const p = before.then(job);
      this.parallel.push(p.catch(() => undefined));
      return p;
    }
    const p = before.then(job);
    this.barrier = p.catch(() => undefined);
    return p;
  }
}

/**
 * Gas limits on QIE (measured 26 Oct 2026). Two quirks of its Cosmos EVM:
 * - eth_estimateGas runs low: createGame is estimated at 50,474 on every testnet RPC but uses 70,758
 *   (one RPC even answered 22,088, intrinsic gas only, and that transaction ran out of gas);
 * - a transaction is charged at least half its gas limit (revealAndFinalize with a 2.4M limit was
 *   charged exactly 1.2M).
 * So the limit is twice the estimate, which costs nothing while the estimate is at or below the real
 * use, and never less than a fallback sized from the contract tests. Each fallback is under twice its
 * function's real use, so it never makes a transaction pay more than it uses.
 */
export const GAS_FALLBACK: Record<string, bigint> = {
  createGame: 110_000n,
  createGameWithMode: 140_000n,
  joinGame: 150_000n,
  commitRoles: 90_000n,
  commitNightAction: 90_000n,
  castVote: 90_000n,
  recordRound: 90_000n,
  cancelGame: 60_000n,
  reportDispute: 60_000n,
};

/**
 * Fallback for revealAndFinalize, by size. Contract tests with first-time players: 5 players and
 * 3 night reveals use about 571k, 12 and 25 about 1.65M; this gives about 1.25x of each.
 */
export const finalizeFallback = (players: number, nights: number) => 60_000n + 125_000n * BigInt(players) + 18_000n * BigInt(nights);

/** Gas limit to send for `functionName`, given the node's estimate and the call's args (for sizing). */
export function gasLimitFor(functionName: string, estimate: bigint, args: readonly unknown[] = []): bigint {
  const len = (i: number) => (Array.isArray(args[i]) ? (args[i] as unknown[]).length : 12);
  const fallback =
    functionName === "revealAndFinalize"
      ? finalizeFallback(len(1), len(2))
      : functionName === "award"
        ? 60_000n + 55_000n * BigInt(len(2)) // NoxBadges.award: about 50k per new player in the contract tests
        : (GAS_FALLBACK[functionName] ?? 150_000n);
  const doubled = estimate * 2n;
  return doubled > fallback ? doubled : fallback;
}


export interface TxRecord {
  gameId: Hex | null;
  /** NoxGame function name, or "gas drip". */
  step: string;
  from: Address;
  /** Contract called, or the player who got the drip. */
  to: Address;
  /** null when a retry found the earlier try had landed without knowing its hash. */
  hash: Hex | null;
  status: "success" | "reverted" | "failed";
  gasUsed: bigint | null;
  feeWei: bigint | null;
  block: bigint | null;
  attempts: number;
  error: string | null;
  /** Why a gas drip was sent: "onboarding" (the wallet's first gas) or "top-up". */
  reason?: string | null;
  /** QIE sent with the transaction (gas drips), in wei. */
  valueWei?: bigint | null;
}

export interface PlayerReward {
  userId: number;
  /** participation (+ win) */
  base: number;
  role: number;
  vote: number;
  streak: number;
  /** Scam Shield bonus: the village spotted the scammers (F10-S05). */
  scamShield: number;
  total: number;
  /** Consecutive UTC days with a finalized game, including today. */
  streakDays: number;
}

type TxContext = Pick<TxRecord, "gameId" | "step" | "from" | "to" | "reason" | "valueWei">;

/** A mined transaction that reverted: final, retrying would only burn gas again. */
class TxRevertedError extends Error {
  constructor(
    message: string,
    readonly receipt: { gasUsed: bigint; effectiveGasPrice: bigint; blockNumber: bigint },
  ) {
    super(message);
  }
}
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
  private balanceCheckedAt = 0;
  /** Games whose finalize landed (badges are only awarded for those, never for disputed ones). */
  private readonly finalized = new Set<Hex>();

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

  /** Whether the deployed NoxGame has game modes (nox-contracts#17); asked once. */
  private modes?: Promise<boolean>;

  private supportsModes(): Promise<boolean> {
    this.modes ??= this.publicClient
      .readContract({ address: this.o.gameAddress, abi: NoxGameAbi, functionName: "scamShieldBonus" })
      .then(
        () => true,
        () => false,
      );
    return this.modes;
  }

  startGame(gameId: Hex, configHash: Hex, players: number[], rolesRoot: Hex, mode = 0) {
    this.enqueue(gameId, "start", async () => {
      // An older NoxGame has no modes: the game still runs, as a standard one (no on-chain bonus).
      if (mode !== 0 && (await this.supportsModes())) await this.asOperator("createGameWithMode", [gameId, configHash, mode]);
      else {
        if (mode !== 0) this.o.log?.({ event: "game_mode_unsupported", gameId, mode });
        await this.asOperator("createGame", [gameId, configHash]);
      }
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
      let hash: Hex | null;
      try {
        hash = await this.asOperator("revealAndFinalize", [gameId, r, n, resultHash, winner]);
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
      if (hash && this.o.onRewards) await this.reportRewards(gameId, hash, roles.map((x) => x.userId));
      await this.checkOperatorBalance();
    });
  }

  /** Read the RewardGranted breakdown from the finalize receipt. Failing here never affects the game. */
  private async reportRewards(gameId: Hex, hash: Hex, userIds: number[]) {
    try {
      const receipt = await this.publicClient.getTransactionReceipt({ hash });
      const byAddress = new Map(userIds.map((u) => [this.addressOf(u).toLowerCase(), u]));
      const grants = parseEventLogs({ abi: NoxGameAbi, eventName: "RewardGranted", logs: receipt.logs });
      const bonus = new Map(parseEventLogs({ abi: NoxGameAbi, eventName: "ScamShieldBonus", logs: receipt.logs }).map((b) => [b.args.player.toLowerCase(), b.args.amount]));
      const rewards: PlayerReward[] = [];
      for (const g of grants) {
        const userId = byAddress.get(g.args.player.toLowerCase());
        if (userId === undefined) continue;
        const [, days] = await this.publicClient.readContract({ address: this.o.gameAddress, abi: NoxGameAbi, functionName: "streakOf", args: [g.args.player] });
        const { base, roleBonus, voteBonus, streakBonus } = g.args;
        const scamShield = bonus.get(g.args.player.toLowerCase()) ?? 0;
        rewards.push({ userId, base, role: roleBonus, vote: voteBonus, streak: streakBonus, scamShield, total: base + roleBonus + voteBonus + streakBonus + scamShield, streakDays: days });
      }
      this.o.onRewards?.(gameId, rewards);
    } catch (e) {
      this.o.log?.({ event: "rewards_read_error", gameId, error: e instanceof Error ? e.message.split("\n")[0] : String(e) });
    }
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

  awardBadge(gameId: Hex, badge: BadgeKey, userIds: number[]) {
    const badges = this.o.badgesAddress;
    if (!badges || !userIds.length) return;
    // Queued after finalize on the same game queue, so it runs once the outcome is known.
    this.enqueue(gameId, "awardBadge", async () => {
      if (!this.finalized.has(gameId)) return this.o.log?.({ event: "badge_skipped", gameId, badge, reason: "game not finalized" });
      // A badge the admin has not defined yet would revert: skip it with a clear note instead.
      const [, active] = (await this.publicClient.readContract({ address: badges, abi: NoxBadgesAbi as Abi, functionName: "badges", args: [keccak256(toHex(badge))] })) as [string, boolean];
      if (!active) return this.o.log?.({ event: "badge_skipped", gameId, badge, reason: "not defined on NoxBadges (npm run badges -- --send)" });
      const accounts = userIds.map((u) => this.addressOf(u));
      const hash = await this.asOperator("award", [keccak256(toHex(badge)), gameId, accounts], { address: badges, abi: NoxBadgesAbi as Abi });
      this.o.log?.({ event: "badge_awarded", gameId, badge, players: accounts.length, hash });
    });
  }

  private settle(gameId: Hex, outcome: "finalized" | "cancelled" | "disputed", reason?: "reveal_mismatch" | "reveal_timeout", detail = "") {
    if (outcome === "finalized") this.finalized.add(gameId);
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
          // A badge is a bonus: its failure is logged and never touches the finalized game.
          if (step === "awardBadge") return this.o.log?.({ event: "badge_error", gameId, error: e instanceof Error ? e.message.split("\n")[0] : String(e) });
          const first = !this.failed.has(gameId);
          this.failed.add(gameId);
          this.o.log?.({ event: "chain_error", gameId, step, error: e instanceof Error ? e.message.split("\n")[0] : String(e) });
          // A failed finalize keeps its record for the boot-time retry; any other failure cancels the game.
          if (first && step !== "finalize" && step !== "cancel") this.cancel(gameId, `chain error at ${step}`);
        }
      }, PARALLEL_STEPS.has(step) ? step : null)
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  /** Simulate (so a revert surfaces with its custom error instead of burning gas), then submit. */
  private async submit(account: Account, functionName: string, args: readonly unknown[], nonce?: number, target?: { address: Address; abi: Abi }): Promise<Hex> {
    const wallet = createWalletClient({ account, chain: this.o.chain, transport: this.transport });
    const call = { account, address: target?.address ?? this.o.gameAddress, abi: (target?.abi ?? NoxGameAbi) as Abi, functionName: functionName as never, args: args as never };
    const { request } = await this.publicClient.simulateContract(call);
    const gas = gasLimitFor(functionName, await this.publicClient.estimateContractGas(call), args);
    return wallet.writeContract({ ...(request as object), gas, ...(nonce !== undefined ? { nonce } : {}) } as never);
  }

  private async confirm(hash: Hex, what: string) {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== "success") throw new TxRevertedError(`${what} reverted (${hash})`, receipt);
    return receipt;
  }

  private record(ctx: TxContext, tx: Omit<TxRecord, keyof TxContext>) {
    try {
      this.o.onTx?.({ ...ctx, ...tx });
    } catch (e) {
      this.o.log?.({ event: "tx_record_error", error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Report the operator's balance (for the treasury alert), at most once a minute. */
  private async checkOperatorBalance() {
    if (!this.o.onOperatorBalance || Date.now() - this.balanceCheckedAt < 60_000) return;
    this.balanceCheckedAt = Date.now();
    try {
      this.o.onOperatorBalance(await this.publicClient.getBalance({ address: this.operator.address }));
    } catch (e) {
      this.o.log?.({ event: "balance_read_error", error: e instanceof Error ? e.message.split("\n")[0] : String(e) });
    }
  }

  /**
   * Send and confirm one transaction, retrying up to maxAttempts (F05-S06, F11-S05). Before anything
   * was broadcast every error is retried (a simulated revert costs nothing; a lagging node may revert
   * wrongly). Once a hash exists, only its receipt is awaited again, never a second copy. A mined
   * revert is final. On a retry, `done` tells whether the earlier attempt landed after all.
   */
  private async withRetry(
    ctx: TxContext,
    send: () => Promise<Hex>,
    done: (err: unknown) => Promise<boolean> | boolean,
  ): Promise<Hex | null> {
    const what = ctx.step;
    const max = this.o.maxAttempts ?? 3;
    const none = { gasUsed: null, feeWei: null, block: null };
    let hash: Hex | undefined;
    let last: unknown;
    for (let attempt = 1; ; attempt++) {
      try {
        // Nothing to wait for from the last try: make sure it did not land before sending again.
        if (attempt > 1 && !hash && (await done(last))) {
          this.o.log?.({ event: "chain_retry_done", what, attempt });
          this.record(ctx, { hash: null, status: "success", ...none, attempts: attempt, error: "an earlier try landed" });
          return null;
        }
        hash ??= await send();
        const r = await this.confirm(hash, what);
        this.record(ctx, { hash, status: "success", gasUsed: r.gasUsed, feeWei: r.gasUsed * r.effectiveGasPrice, block: r.blockNumber, attempts: attempt, error: null });
        return hash;
      } catch (e) {
        const message = e instanceof Error ? e.message.split("\n")[0]! : String(e);
        if (e instanceof TxRevertedError) {
          const r = e.receipt;
          this.record(ctx, { hash: hash ?? null, status: "reverted", gasUsed: r.gasUsed, feeWei: r.gasUsed * r.effectiveGasPrice, block: r.blockNumber, attempts: attempt, error: message });
          throw e;
        }
        if (e instanceof DripRefusedError) throw e;
        const final = REVEAL_MISMATCH.has(revertOf(e)?.errorName ?? "") || isDisputedOnChain(e);
        if (!final && attempt > 1 && !hash && (await done(e))) {
          this.o.log?.({ event: "chain_retry_done", what, attempt });
          this.record(ctx, { hash: null, status: "success", ...none, attempts: attempt, error: "an earlier try landed" });
          return null;
        }
        if (final || attempt >= max) {
          this.record(ctx, { hash: hash ?? null, status: "failed", ...none, attempts: attempt, error: message });
          throw e;
        }
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

  private async asOperator(functionName: string, args: readonly unknown[], target?: { address: Address; abi: Abi }) {
    // NoxGame calls take the game id first; NoxBadges.award takes it second.
    const gameId = (target ? args[1] : args[0]) as Hex;
    return this.withRetry(
      { gameId, step: functionName, from: this.operator.address, to: target?.address ?? this.o.gameAddress },
      () => this.operatorSend((nonce) => this.submit(this.operator, functionName, args, nonce, target)),
      (e) => alreadyDone(functionName, e),
    );
  }

  private async asPlayer(userId: number, functionName: string, args: readonly unknown[]) {
    const account = this.o.wallets.account(userId);
    let q = this.playerQueues.get(account.address);
    if (!q) this.playerQueues.set(account.address, (q = new SerialQueue()));
    return q.run(async () => {
      await this.drip(account.address, args[0] as Hex);
      return this.withRetry(
        { gameId: args[0] as Hex, step: functionName, from: account.address, to: this.o.gameAddress },
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

  private async drip(to: Address, gameId: Hex) {
    const balance = await this.publicClient.getBalance({ address: to });
    if (balance >= this.o.minBalance) return;
    this.reserveDrip(to, this.o.dripAmount - balance);
    const wallet = createWalletClient({ account: this.operator, chain: this.o.chain, transport: this.transport });
    const value = this.o.dripAmount - balance;
    // An empty derived wallet has never been funded: its first gas is onboarding (F01-D04).
    const reason = balance === 0n ? "onboarding" : "top-up";
    // A drip that was sent but whose response got lost shows up as a topped-up balance: never send twice.
    const hash = await this.withRetry(
      { gameId, step: "gas drip", from: this.operator.address, to, reason, valueWei: value },
      () => this.operatorSend((nonce) => wallet.sendTransaction({ to, value, nonce, chain: this.o.chain })),
      async () => (await this.publicClient.getBalance({ address: to })) >= this.o.minBalance,
    );
    this.o.log?.({ event: "gas_drip", to, wei: value.toString(), reason, hash });
    await this.checkOperatorBalance();
  }
}
