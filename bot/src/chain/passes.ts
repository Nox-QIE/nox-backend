import type { Address } from "viem";
import { NoxPaymentsAbi } from "./contracts.js";

/** NoxPayments pass types (configured by the admin with configurePass). */
export const HOST_PASS = 1;
/** Players in a lobby without a Host Pass when passes are required. */
export const FREE_MAX_PLAYERS = 8;

export interface PassClient {
  readContract(args: { address: Address; abi: typeof NoxPaymentsAbi; functionName: string; args: readonly unknown[] }): Promise<unknown>;
}

export interface PassStatus {
  active: boolean;
  /** Unix seconds; 0 when the wallet never had the pass. */
  expiresAt: number;
}

/**
 * Reads Host Passes from NoxPayments (F03-D05, F14-D03). A pass belongs to the host's game wallet;
 * anyone can pay for it with buyPassFor. Results are cached briefly so a busy lobby does not hit the
 * RPC on every tap.
 */
export class PassReader {
  private readonly cache = new Map<string, { at: number; status: PassStatus }>();

  constructor(
    private readonly o: { client: PassClient; payments: Address; ttlMs?: number; now?: () => number },
  ) {}

  async status(holder: Address, passType = HOST_PASS): Promise<PassStatus> {
    const now = (this.o.now ?? Date.now)();
    const key = `${holder.toLowerCase()}|${passType}`;
    const hit = this.cache.get(key);
    if (hit && now - hit.at < (this.o.ttlMs ?? 300_000)) return hit.status;
    const expiresAt = Number(
      await this.o.client.readContract({ address: this.o.payments, abi: NoxPaymentsAbi, functionName: "passExpiry", args: [holder, passType] }),
    );
    const status = { active: expiresAt > now / 1000, expiresAt };
    this.cache.set(key, { at: now, status });
    return status;
  }

  /** Price per period in native QIE (wei) and the period length, or null when not for sale. */
  async offer(passType = HOST_PASS): Promise<{ wei: bigint; periodDays: number } | null> {
    const zero = "0x0000000000000000000000000000000000000000";
    const [wei, period] = await Promise.all([
      this.o.client.readContract({ address: this.o.payments, abi: NoxPaymentsAbi, functionName: "priceOf", args: [passType, zero] }),
      this.o.client.readContract({ address: this.o.payments, abi: NoxPaymentsAbi, functionName: "periodOf", args: [passType] }),
    ]);
    return (wei as bigint) > 0n ? { wei: wei as bigint, periodDays: Math.round(Number(period) / 86_400) } : null;
  }
}
