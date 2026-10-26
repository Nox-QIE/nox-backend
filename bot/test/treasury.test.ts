import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { SqliteStore } from "../src/store.js";
import { botLedgerHooks } from "../src/telegram.js";
import { gasReport, qie, TreasuryWatch } from "../src/treasury.js";
import { FakeMessenger } from "./fakes.js";

const gameId = ("0x" + "cd".repeat(32)) as Hex;
const tx = (step: string, gas: bigint, status: "success" | "reverted" | "failed" = "success") => ({
  gameId,
  step,
  from: "0x552000070aB67Ae1ad012a5e72B46f8b44Cc1764" as Hex,
  to: "0x5ecA1C5A6d5A75920147eb396F0223873C0cA6e4" as Hex,
  hash: ("0x" + "ab".repeat(32)) as Hex,
  status,
  gasUsed: gas,
  feeWei: gas * 8n,
  block: 9375800n,
  attempts: 1,
  error: null,
});

describe("gas & transaction ledger (D14)", () => {
  it("stores every transaction with exact big numbers and finds them by game", () => {
    const store = new SqliteStore(":memory:");
    store.recordTx(tx("createGame", 95_000n));
    store.recordTx({ ...tx("revealAndFinalize", 1_647_056n), feeWei: 10n ** 30n }); // larger than SQLite's 64-bit integers
    store.recordTx({ ...tx("castVote", 0n, "failed"), hash: null, gasUsed: null, feeWei: null, block: null, attempts: 3, error: "fetch failed" });
    const rows = store.txsOfGame(gameId);
    expect(rows.map((r) => r.step)).toEqual(["createGame", "revealAndFinalize", "castVote"]);
    expect(rows[1]!.feeWei).toBe(10n ** 30n);
    expect(rows[2]).toMatchObject({ status: "failed", hash: null, gasUsed: null, attempts: 3, error: "fetch failed" });
    expect(store.txsBetween(0, Date.now() + 1)).toHaveLength(3);
  });

  it("sums gas and fees per day and step, counting unsuccessful ones", () => {
    const at = Date.UTC(2026, 9, 26, 3);
    const rows = gasReport([
      { ...tx("castVote", 50_000n), at },
      { ...tx("castVote", 52_000n), at },
      { ...tx("castVote", 0n, "failed"), gasUsed: null, feeWei: null, at },
      { ...tx("createGame", 95_000n), at: at + 86_400_000 },
    ]);
    expect(rows).toEqual([
      { day: "2026-10-26", step: "castVote", txs: 3, failed: 1, gasUsed: 102_000n, feeWei: 816_000n },
      { day: "2026-10-27", step: "createGame", txs: 1, failed: 0, gasUsed: 95_000n, feeWei: 760_000n },
    ]);
  });

  it("formats QIE amounts", () => {
    expect(qie(1_990_000_000_000_000_000n)).toBe("1.990000");
    expect(qie(43_733_584n, 12)).toBe("0.000000000043");
  });
});

describe("operator wallet watch (F11-D06, F11-S07)", () => {
  it("snapshots at most every 10 minutes and alerts at most every 6 hours when low", () => {
    let now = 0;
    const snaps: bigint[] = [];
    const alerts: bigint[] = [];
    const w = new TreasuryWatch({ alertWei: 100n, snapshot: (x) => snaps.push(x), alert: (x) => alerts.push(x), now: () => now });
    w.observe(500n);
    now += 60_000;
    w.observe(90n); // low, but within 10 minutes of the last snapshot
    now += 10 * 60_000;
    w.observe(80n);
    now += 3600_000;
    w.observe(70n); // still low: no second alert within 6 hours
    now += 6 * 3600_000;
    w.observe(60n);
    expect(snaps).toEqual([500n, 80n, 70n, 60n]);
    expect(alerts).toEqual([90n, 60n]);
  });

  it("DMs the operator and keeps snapshots through the bot hooks", async () => {
    const store = new SqliteStore(":memory:");
    const messenger = new FakeMessenger();
    const logs: Record<string, unknown>[] = [];
    const hooks = botLedgerHooks({ store, messenger, treasuryAlertWei: 5n * 10n ** 17n, operatorChatId: 7, log: (l) => logs.push(l) });
    hooks.onOperatorBalance!(2n * 10n ** 17n);
    await new Promise((r) => setTimeout(r, 0));
    expect(messenger.dms(7)[0]!.html).toContain("Balance: 0.200000 QIE (alert below 0.500000 QIE)");
    expect(logs).toContainEqual({ event: "treasury_low", wei: "200000000000000000" });
    expect(store.operatorBalances(0).map((b) => b.wei)).toEqual([2n * 10n ** 17n]);
    hooks.onTx!(tx("createGame", 1n));
    expect(store.txsOfGame(gameId)).toHaveLength(1);
  });
});
