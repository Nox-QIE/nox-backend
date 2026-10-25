import { resultHash } from "@nox/shared/crypto-spec";
import type { Hex } from "viem";
import type { FinishedGame } from "./store.js";

export interface SettlementInput {
  /** Every finished game of the period (with or without an agent). */
  games: FinishedGame[];
  /** Pass revenue of the period, in the token's smallest unit. */
  revenue: bigint;
  /** Owner share per agent in basis points (from NoxAgentRegistry). */
  shareBps: Map<number, number>;
  minPlayers?: number;
  /** Games one host can count per UTC day (anti-farming). */
  hostDailyCap?: number;
}

export interface AgentPayout {
  agentId: number;
  validGames: number;
  amount: bigint;
}

export interface Settlement {
  totalValidGames: number;
  payouts: AgentPayout[];
  total: bigint;
  /** Commitment to the per-game data the amounts were computed from (no Telegram ids inside). */
  usageRoot: Hex;
}

/**
 * Agent share of pass revenue for one period:
 *   amount = revenue x shareBps / 10000 x validGames(agent) / validGames(all)
 * A game is valid when it had at least `minPlayers` players and its host had not already counted
 * `hostDailyCap` games that UTC day. Amounts round down; the remainder stays with Nox.
 */
export function computeSettlement({ games, revenue, shareBps, minPlayers = 5, hostDailyCap = 10 }: SettlementInput): Settlement {
  const perHostDay = new Map<string, number>();
  const valid = games.filter((g) => {
    if (g.players < minPlayers) return false;
    const key = `${g.hostId}:${new Date(g.endedAt).toISOString().slice(0, 10)}`;
    const n = (perHostDay.get(key) ?? 0) + 1;
    perHostDay.set(key, n);
    return n <= hostDailyCap;
  });
  const byAgent = new Map<number, number>();
  for (const g of valid) if (g.agentId !== null) byAgent.set(g.agentId, (byAgent.get(g.agentId) ?? 0) + 1);

  const totalValidGames = valid.length;
  const payouts: AgentPayout[] = [...byAgent.entries()]
    .sort(([a], [b]) => a - b)
    .map(([agentId, validGames]) => ({
      agentId,
      validGames,
      amount: totalValidGames ? (revenue * BigInt(shareBps.get(agentId) ?? 0) * BigInt(validGames)) / (10_000n * BigInt(totalValidGames)) : 0n,
    }));
  const usageRoot = resultHash(valid.map((g) => ({ game: g.chainGameId ?? `local:${g.id}`, agent: g.agentId, players: g.players, endedAt: g.endedAt })));
  return { totalValidGames, payouts, total: payouts.reduce((s, p) => s + p.amount, 0n), usageRoot };
}

/** "2026-11" → [start, end) in ms (UTC) and the on-chain period number 202611. */
export function monthRange(month: string): { from: number; to: number; period: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error("month must look like 2026-11");
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return { from: Date.UTC(y, mo - 1, 1), to: Date.UTC(y, mo, 1), period: y * 100 + mo };
}
