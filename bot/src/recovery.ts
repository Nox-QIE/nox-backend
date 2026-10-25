import type { GameLedger } from "./chain/ledger.js";
import { T } from "./i18n.js";
import type { Messenger } from "./ports.js";
import type { Store } from "./store.js";

// NoxGame.Status
const FINALIZED = 3;
const CANCELLED = 4;
const NONE = 0;

/**
 * On boot, settle every game the last process left open. Games are not resumed in Telegram (timers
 * and buttons are gone): a game that had ended gets its finalize retried, a game still running is
 * cancelled on-chain and its group is told.
 */
export async function recoverGames(store: Store, ledger: GameLedger, messenger: Messenger, log: (l: Record<string, unknown>) => void) {
  if (!ledger.enabled) return;
  for (const g of store.unsettledGames()) {
    try {
      const status = await ledger.statusOf(g.gameId);
      if (status === FINALIZED) store.setStatus(g.gameId, "finalized");
      else if (status === CANCELLED || status === NONE) store.setStatus(g.gameId, "cancelled");
      else if (g.finalize) {
        ledger.finalize(g.gameId, g.finalize.roles, g.finalize.nights, g.finalize.resultHash, g.finalize.winner);
        log({ event: "recovery_finalize", gameId: g.gameId });
      } else {
        ledger.cancel(g.gameId, "server restart");
        await messenger.sendGroup(g.chatId, T[g.lang].restartCancelled);
        log({ event: "recovery_cancel", gameId: g.gameId });
      }
    } catch (e) {
      log({ event: "recovery_error", gameId: g.gameId, error: e instanceof Error ? e.message.split("\n")[0] : String(e) });
    }
  }
}
