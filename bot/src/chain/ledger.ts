import type { Address, Hex } from "viem";

export interface LedgerRoleReveal {
  userId: number;
  role: number;
  salt: Hex;
  proof: Hex[];
}

export interface LedgerNightReveal {
  round: number;
  userId: number;
  action: number;
  targetUserId: number;
  nonce: Hex;
}

/**
 * On-chain record of a game (NoxGame). Calls are fire-and-forget from the room's point of view:
 * gameplay never waits for the chain. Implementations must apply calls for one game in order.
 */
export interface GameLedger {
  readonly enabled: boolean;
  addressOf(userId: number): Address | null;
  startGame(gameId: Hex, configHash: Hex, players: number[], rolesRoot: Hex): void;
  commitNightAction(gameId: Hex, round: number, userId: number, actionHash: Hex): void;
  castVote(gameId: Hex, round: number, userId: number, targetUserId: number): void;
  recordRound(gameId: Hex, round: number, resultHash: Hex): void;
  finalize(gameId: Hex, roles: LedgerRoleReveal[], nights: LedgerNightReveal[], resultHash: Hex, winner: number): void;
  cancel(gameId: Hex, reason: string): void;
}

/** Chain disabled (NOX_CHAIN=off): the game runs exactly as before. */
export const noLedger: GameLedger = {
  enabled: false,
  addressOf: () => null,
  startGame() {},
  commitNightAction() {},
  castVote() {},
  recordRound() {},
  finalize() {},
  cancel() {},
};
