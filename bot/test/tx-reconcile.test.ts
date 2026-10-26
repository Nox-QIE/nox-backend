import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { EventStore, type IndexedEvent } from "../src/chain/indexer.js";
import type { StoredTx } from "../src/store.js";
import { reconcileTxs } from "../src/tx-reconcile.js";

const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const game = h(999);
const tx = (step: string, hash: number | null, block: number | null, status: StoredTx["status"] = "success"): StoredTx => ({
  gameId: game,
  step,
  from: "0x01" as Hex,
  to: "0x02" as Hex,
  hash: hash === null ? null : h(hash),
  status,
  gasUsed: 1n,
  feeWei: 1n,
  block: block === null ? null : BigInt(block),
  attempts: 1,
  error: null,
  at: Date.now(),
});
const ev = (event: string, hash: number, block: number, logIndex = 0): IndexedEvent => ({ contract: "NoxGame", block, ts: 0, txHash: h(hash), logIndex, event, args: {}, gameId: game, account: null });

describe("tx ledger vs chain events (F07-D05)", () => {
  it("finds every successful transaction's event, flags the missing ones, skips what cannot be checked", () => {
    const index = new EventStore(":memory:");
    index.apply("k", [ev("GameCreated", 1, 100), ev("PlayerJoined", 2, 101), ev("VoteCast", 3, 105), ev("GameFinalized", 5, 110, 0), ev("RoleRevealed", 5, 110, 1)], 120n, null);
    const r = reconcileTxs(
      [
        tx("createGame", 1, 100),
        tx("joinGame", 2, 101),
        tx("castVote", 3, 105),
        tx("castVote", 4, 106), // no VoteCast in the index
        tx("revealAndFinalize", 5, 110),
        tx("castVote", 6, 130), // after the indexed block: not checkable yet
        tx("castVote", null, null), // an earlier try landed, hash unknown
        tx("joinGame", 7, 102, "failed"),
        tx("gas drip", 8, 103), // a plain transfer emits no event
      ],
      (hash) => index.eventsOfTx(hash),
      index.indexedBlock(),
    );
    expect(r.checked).toBe(5);
    expect(r.skipped).toBe(4);
    expect(r.missing).toEqual([{ step: "castVote", hash: h(4), gameId: game, block: 106, expected: "VoteCast" }]);
  });

  it("matches hashes in any letter case", () => {
    const index = new EventStore(":memory:");
    index.apply("k", [ev("VoteCast", 0xabc, 5)], 10n, null);
    expect(index.eventsOfTx(h(0xabc).toUpperCase().replace("0X", "0x") as Hex)).toEqual(["VoteCast"]);
  });
});
