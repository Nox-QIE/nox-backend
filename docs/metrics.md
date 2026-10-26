# Public metrics: definitions

Every number Nox publishes comes from contract events on QIE, indexed by `npm run indexer` and served by the public API (`/v1/*`). Anyone can recount them from the chain. This page defines each one. The client Game Night report (`npm run report`) uses the same definitions, because `/v1/engagement` and the report call the same function (`buildReport` in `bot/src/report.ts`) on the same games (`EventStore.finalizedGames` / `gameDetail`).

## Common rules

- **Player** means a wallet. Each Telegram account has exactly one derived wallet (ADR-002). A player is therefore an account, not yet a verified human: that needs QIE ID, and `verifiedHumans` stays `null` until QIE ID is live.
- **Time** is the block timestamp, in UTC. Days run from 00:00 to 24:00 UTC. Weeks are ISO weeks (Monday start, week 1 holds the first Thursday). Seasons are UTC calendar months.
- **Finalized game**: a game with a `GameFinalized` event. Its roles were revealed and checked on chain. Cancelled (`GameCancelled`) and disputed (`GameDisputed`) games never count as played games.
- **Confirmations**: the indexer reads blocks only once they are `NOX_INDEX_CONFIRMATIONS` deep (default 2). So the newest blocks show up a few seconds late, and a reorg cannot add or remove events.
- **Privacy**: the API serves on-chain data and aggregates only. Telegram ids and names never leave the bot. In engagement numbers, a weekly count of 1 or 2 players is returned as `null` (shown as "<3"); 0 is shown, since it singles out no one.

## `GET /v1/stats`: all-time totals

| Field | Definition | Events |
|---|---|---|
| `players` | distinct wallets that joined any game, including games later cancelled | `PlayerJoined` |
| `playerTxs` | transactions signed by players: joins, sealed night actions and votes (distinct tx hashes) | `PlayerJoined`, `NightActionCommitted`, `VoteCast` |
| `finishedGames` | finalized games | `GameFinalized` |
| `cancelledGames` | cancelled games | `GameCancelled` |
| `disputedGames` | games whose roles failed the on-chain check | `GameDisputed` |
| `credits` | all Nox Credits minted, for every reason | `CreditsMinted.amount` |
| `lastBlock` / `indexedBlock` | newest block holding a Nox event / newest block the indexer has read | – |

`players` here counts people who tried. `uniquePlayers` in `/v1/engagement` counts people who finished a game. On their own data, the two differ only by players whose every game was cancelled.

## `GET /v1/daily?days=N`: daily signers

`players` for each UTC day is the number of distinct wallets that signed at least one game transaction that day (join, sealed night action or vote). Days with no signer are left out. `days` can be 1–90 (default 30).

## `GET /v1/engagement?weeks=N`: engagement, same as the Game Night report

The window starts at Monday 00:00 UTC, `N` ISO weeks back counting the current week, and ends now. `N` can be 1–26 (default 8). Only games finalized in the window count, by their `GameFinalized` time.

| Field | Definition |
|---|---|
| `games` | finalized games |
| `seats` | players across those games: one person playing 3 games counts 3 times |
| `uniquePlayers` | distinct player wallets across those games |
| `verifiedHumans` | distinct players verified with QIE ID; `null` until QIE ID is live |
| `avgPlayers` | `seats ÷ games`, one decimal |
| `avgMinutes` | mean of (`GameFinalized` time − `GameCreated` time), in minutes, one decimal |
| `avgRounds` | mean `RoundRecorded` events per game, one decimal |
| `credits` | credits minted in those games |
| `weeks[].active` | distinct players with a finalized game that ISO week (`null` for 1 or 2) |
| `weeks[].returning` | that week's active players who also played in the ISO week right before; 0 when that week had no games (`null` for 1 or 2, or when the week's active players are below 3) |
| `weeks[].retention` | `returning ÷ the week before's active players`, in percent, rounded (`null` for the first week of the window, or when either week has fewer than 3 players) |

The client report (`npm run report -- <chat-id> <YYYY-MM>`) is the same calculation, limited to the games played in one Telegram group in one month. It also lists the proof link of every game.

## `GET /v1/leaderboard[?season=YYYY-MM]` and `GET /v1/players/<address>`

| Field | Definition |
|---|---|
| `credits` | all-time: every credit minted to the wallet; per season: credits minted in games finalized that month |
| `games` | finalized games the wallet played in (it has a `RoleRevealed` in them) |
| `wins` | finalized games where the wallet's team won: werewolves when its revealed role is werewolf, the village for every other role, compared with `GameFinalized.winner` |
| `streakDays` | consecutive UTC days, up to today or yesterday, with at least one finalized game; 0 once a whole day passes without one |
| `bestStreak` | the longest such run ever |
| `rank` | position by credits, then wins, then address (all-time only) |
| `badges` | NoxBadges awarded to the wallet, by badge name (`BadgeAwarded`, names from the latest `BadgeDefined`) |

The all-time numbers come from the `player_stats` mirror. It is rebuilt after every indexer sync and every hour, and checked against `NoxCredits.balanceOf` (`/v1/health` → `reconciliation`). Credits are status points: they cannot be transferred or cashed out.

## `GET /v1/agents/revenue`

These are Agent Marketplace amounts from NoxPayments events, in the token's smallest unit, as strings. Per agent: Game Night credits and monthly pool allocations (`AgentCredited`, `AgentPoolAllocated`). Per owner: credited, withdrawn and still owed. `/v1/health` → `paymentsReconciliation` checks them against the contract's balances.
