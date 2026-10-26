import type { Hex } from "viem";
import type { StoredTx } from "./store.js";

/**
 * Reconcile the bot's transaction ledger (D14) with the chain events the index holds (F07-D05).
 * Every successful transaction must have emitted its event: a vote without VoteCast, or a join
 * without PlayerJoined, means the index missed something or the chain did not record what the bot
 * thinks it sent. Only transactions in blocks the index has already scanned are checked.
 */
export const EXPECTED_EVENT: Record<string, string | null> = {
  createGame: "GameCreated",
  joinGame: "PlayerJoined",
  commitRoles: "RolesCommitted",
  commitNightAction: "NightActionCommitted",
  castVote: "VoteCast",
  recordRound: "RoundRecorded",
  revealAndFinalize: "GameFinalized",
  cancelGame: "GameCancelled",
  reportDispute: "GameDisputed",
  // A retried badge award may emit nothing (already awarded); a drip is a plain transfer.
  award: null,
  "gas drip": null,
};

export interface TxReconciliation {
  checked: number;
  /** Not checkable yet or by design: failed, hash unknown, no event expected, or not indexed yet. */
  skipped: number;
  missing: { step: string; hash: Hex; gameId: Hex | null; block: number; expected: string }[];
}

export function reconcileTxs(txs: StoredTx[], eventsOfTx: (hash: Hex) => string[], indexedBlock: number): TxReconciliation {
  const r: TxReconciliation = { checked: 0, skipped: 0, missing: [] };
  for (const t of txs) {
    const expected = EXPECTED_EVENT[t.step];
    if (t.status !== "success" || !t.hash || !expected || t.block === null || Number(t.block) > indexedBlock) {
      r.skipped++;
      continue;
    }
    r.checked++;
    if (!eventsOfTx(t.hash).includes(expected)) r.missing.push({ step: t.step, hash: t.hash, gameId: t.gameId, block: Number(t.block), expected });
  }
  return r;
}
