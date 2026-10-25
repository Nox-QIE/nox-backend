import type { Address, Hex } from "viem";
import { computeSettlement, monthRange, type Settlement } from "../settlement.js";
import type { Store } from "../store.js";
import { allocateAgentPool, passRevenue, shareOf, type Operator } from "./operator.js";

export interface MonthSettlement extends Settlement {
  period: number;
  revenue: bigint;
  /** Local agent id → NoxAgentRegistry id, for agents that can be paid. */
  chainIds: Map<number, number>;
  /** Agents with valid games but not registered on-chain yet (their games still count in the total). */
  unregistered: number[];
  tx?: Hex;
}

/** Compute (and with `send`, submit) one month's agent pool settlement for one token. */
export async function settleMonth(
  store: Store,
  op: Operator,
  addrs: { registry: Address; payments: Address; paymentsFromBlock?: bigint },
  month: string,
  token: Address,
  send: boolean,
): Promise<MonthSettlement> {
  const { from, to, period } = monthRange(month);
  const games = store.finishedGames(from, to);
  const revenue = await passRevenue(op, addrs.payments, token, from, to, addrs.paymentsFromBlock ?? 0n);
  const chainIds = new Map<number, number>();
  const shareBps = new Map<number, number>();
  const unregistered: number[] = [];
  for (const id of new Set(games.map((g) => g.agentId).filter((x): x is number => x !== null))) {
    const chainId = store.getAgent(id)?.chainAgentId;
    if (!chainId) {
      unregistered.push(id);
      continue;
    }
    chainIds.set(id, chainId);
    shareBps.set(id, await shareOf(op, addrs.registry, chainId));
  }
  const s = computeSettlement({ games, revenue, shareBps });
  const payable = s.payouts.filter((p) => chainIds.has(p.agentId) && p.amount > 0n);
  const result: MonthSettlement = { ...s, payouts: payable, total: payable.reduce((t, p) => t + p.amount, 0n), period, revenue, chainIds, unregistered };
  if (send && payable.length) {
    result.tx = await allocateAgentPool(
      op,
      addrs.payments,
      period,
      token,
      payable.map((p) => chainIds.get(p.agentId)!),
      payable.map((p) => p.amount),
      s.usageRoot,
    );
  }
  return result;
}
