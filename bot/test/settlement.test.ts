import { describe, expect, it } from "vitest";
import { computeSettlement, monthRange } from "../src/settlement.js";
import type { FinishedGame } from "../src/store.js";

const day = Date.UTC(2026, 10, 3, 12);
let n = 0;
const game = (agentId: number | null, o: Partial<FinishedGame> = {}): FinishedGame => ({
  id: ++n,
  agentId,
  players: 6,
  hostId: 100 + n,
  chainGameId: null,
  endedAt: day,
  ...o,
});

describe("computeSettlement", () => {
  it("pays each agent its share of revenue, pro-rata to valid games across all games", () => {
    const games = [game(1), game(1), game(1), game(2), game(null)];
    const s = computeSettlement({ games, revenue: 1_000_000n, shareBps: new Map([[1, 3000], [2, 5000]]) });
    expect(s.totalValidGames).toBe(5);
    expect(s.payouts).toEqual([
      { agentId: 1, validGames: 3, amount: 180_000n }, // 1M x 30% x 3/5
      { agentId: 2, validGames: 1, amount: 100_000n }, // 1M x 50% x 1/5
    ]);
    expect(s.total).toBe(280_000n);
  });

  it("ignores games under the player minimum and games over a host's daily cap", () => {
    const farm = Array.from({ length: 12 }, () => game(1, { hostId: 7 }));
    const s = computeSettlement({ games: [...farm, game(1, { players: 4 }), game(null)], revenue: 1_000n, shareBps: new Map([[1, 10_000]]), hostDailyCap: 10 });
    expect(s.totalValidGames).toBe(11); // 10 from the farming host + 1 default game
    expect(s.payouts[0]!.validGames).toBe(10);
    expect(s.payouts[0]!.amount).toBe(909n); // rounds down
  });

  it("commits to the usage without Telegram ids and pays nothing with no revenue or games", () => {
    const s = computeSettlement({ games: [game(1, { hostId: 123456789 })], revenue: 0n, shareBps: new Map([[1, 3000]]) });
    expect(s.payouts[0]!.amount).toBe(0n);
    expect(computeSettlement({ games: [], revenue: 5n, shareBps: new Map() }).payouts).toEqual([]);
    const a = computeSettlement({ games: [game(1, { id: 1, hostId: 1 })], revenue: 1n, shareBps: new Map() }).usageRoot;
    const b = computeSettlement({ games: [game(1, { id: 1, hostId: 2 })], revenue: 1n, shareBps: new Map() }).usageRoot;
    expect(a).toBe(b); // host id is not part of the published commitment
  });

  it("maps a month to its UTC range and on-chain period", () => {
    expect(monthRange("2026-11")).toEqual({ from: Date.UTC(2026, 10, 1), to: Date.UTC(2026, 11, 1), period: 202611 });
    expect(() => monthRange("Nov 2026")).toThrow();
  });
});
