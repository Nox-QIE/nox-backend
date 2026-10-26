# ADR-006: No persistent transaction queue

- Status: accepted
- Date: 2026-10-26

## Context

The design (F11-D03) asks for a transaction queue and operator nonce that survive a restart, as with BullMQ + Redis. Since then the build has settled two things. Games are **not resumed** after a restart: their Telegram timers, buttons and in-memory engine state are gone. And every transaction goes through `withRetry` (ADR-002, nox-backend#23).

## Decision

No queue is persisted. What a restart must preserve is already durable or is redone safely:

| Step | After a restart |
|---|---|
| A game that had **ended** | The reveal payload (roles, salts, proofs, night nonces) was sealed into the store before finalize was sent; boot recovery sends `revealAndFinalize` again. A finalize that already landed is recognized (`WrongStatus`, game Finalized → done) |
| A game still **running** | Cancelled on-chain at boot (`cancelGame`), and the group is told. Its pending votes and night commitments would be meaningless without the game, so they are dropped on purpose |
| A game **disputed** meanwhile | Recognized at boot (status 5) and marked disputed |
| The **operator nonce** | Never stored: read from the chain (`pending`) on first use and again after any error, so it cannot go stale across restarts |
| **Player wallets** | Their own nonces come from the chain; each wallet has its own in-memory queue |
| **Gas drips** | A drip lost to a crash is simply sent again when the player next acts (the balance is checked first) |

## Consequences

- Nothing to migrate or replay, and no Redis to run, back up or secure.
- A crash during a game costs that game (it is cancelled and announced), never correctness. A game is a few minutes long, so this is acceptable for the MVP.
- If games ever need to survive restarts (long Game Nights, several bot instances), persist the room state and the ledger queue together, not the queue alone.
