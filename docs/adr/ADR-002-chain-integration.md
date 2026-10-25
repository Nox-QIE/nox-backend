# ADR-002: Chain integration (wallets, gas, ordering)

- Status: accepted
- Date: 2026-10-25

## Context

`NoxGame` (nox-contracts) needs each player to send their own transactions (join, night commitments, votes) so every human shows up as an active account on the QIE explorer, while players never handle keys, seed phrases or gas. Gameplay in Telegram must never stall on block times or RPC hiccups.

## Decision

1. **Derived invisible wallets.** A player's key is `HKDF-SHA256(NOX_WALLET_SECRET, salt "nox-wallet-v1", info "player:<telegramId>")`, retried with a counter in the unlikely case it falls outside the secp256k1 range. No key database: the same player always gets the same address, and backup is one secret. The secret lives only in the env / secret manager; leaking it exposes every player wallet (they only hold gas dust and non-transferable credits).
2. **Gas drip.** Before a player transaction, if the wallet holds less than `NOX_GAS_MIN` (default 0.0005 QIE) the operator tops it up to `NOX_GAS_DRIP` (default 0.002 QIE). On mainnet (1.125 gwei, 25 Oct 2026) one player's game costs about 0.0004 QIE.
3. **Fire-and-forget ledger.** `GameRoom` calls a `GameLedger` port; the game never awaits the chain. `ViemLedger` keeps one serial queue per game (create → joins → commitRoles → commits/votes → recordRound → finalize land in order) and one global queue for the operator wallet (shared nonce). Joins run in parallel because they come from different wallets. Every write is simulated first so reverts surface with their custom error.
4. **Failure isolation.** If any step of a game fails, that game is marked failed, its remaining steps are skipped (logged as `chain_error`) and a `cancelGame` is queued so it does not stay "Running". A failed finalize is not cancelled; it is retried at the next boot. Other games and gameplay continue. Playing without the chain is the default (`NOX_CHAIN=off`).
5. **What goes on-chain, from the room:** at start a random `gameId`, `configHash` and the role Merkle root (each player gets their salt by DM); each night action as `actionHash` with a fresh nonce kept server-side; each day vote; each day's `resultHash`; at the end every role and night action is revealed and verified by `revealAndFinalize`.
6. **Contract artifacts** are copied from a nox-contracts build into `bot/src/chain/contracts.ts` by `bot/scripts/sync-contracts.ts`, stamped with the source commit.

7. **Durable secrets (D5).** Salts, proofs, night nonces and the finalize payload are written to SQLite (`node:sqlite`, `NOX_DB_PATH`, default `data/nox.db`) before anything goes on-chain, sealed with AES-256-GCM under a key derived from `NOX_WALLET_SECRET` (HKDF info `game-secrets`). Users who pressed Start are stored too.
8. **Recovery on boot.** Every game not yet settled is checked on-chain: already finalized/cancelled → marked settled; ended but not finalized → finalize retried; still running → cancelled on-chain and the group is told. Games are not resumed in Telegram (timers and buttons are gone).

## Consequences

- A restart costs the games in progress (cancelled cleanly) but never leaves one unverifiable or stuck "Running".
- The operator is trusted for liveness, as in ADR-001 of nox-contracts.
- Tested end to end against real contracts on anvil (`bot/test/chain.e2e.test.ts`, skipped when anvil is not installed).
