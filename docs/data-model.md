# Data model as built

The design (vault 10.04, DFD level 1) plans data stores D1–D16 in Postgres. The MVP keeps the same data in three places:

- **Bot store** `data/nox.db` (SQLite, `node:sqlite`, WAL): everything only Nox knows. **Back it up** (`npm run backup`).
- **The chain** (NoxGame, NoxCredits, NoxAgentRegistry, NoxPayments on QIE): everything that must be public and verifiable. This is the source of truth.
- **Event index** `data/index.db` (SQLite): a read model of the chain, rebuilt by deleting the file and running `npm run indexer`. It needs no backup.

| Design store | As built | Fields | Protection | Retention |
|---|---|---|---|---|
| D1 Player account | bot `users` | telegram_id (PK), locale, address (derived wallet, unique), status, started_at, last_seen | none needed (no keys) | until `/forget` |
| D1 Wallet audit | bot `wallet_audit`; gas drips come from `chain_txs`; read with `npm run wallet:audit` | address, event (`created` / `forgotten`), detail, at | no Telegram id, no key material | kept (addresses are public on chain) |
| D2 Keystore | **none**: wallets are derived with HKDF from `NOX_WALLET_SECRET` and the Telegram id (ADR-002) | – | the secret lives in env only | – |
| D3 Game session | live state in `GameRoom` memory; bot `games` (game_id, chat_id, lang, status) for recovery; chain `GameCreated(configHash)`, `RolesCommitted`, `RoundRecorded`, `GameFinalized/Cancelled/Disputed` | | | `games` rows deleted 30 days after settle (disputed: kept) |
| D4 Action & vote log | chain `NightActionCommitted` (hash), `NightActionRevealed`, `VoteCast`, with block and tx; bot `chain_txs` holds every tx hash, gas and status | | public by design | permanent (chain) |
| D5 Role secrets & salts | bot `games.secret` / `games.finalize` | roles, salts, Merkle proofs, night nonces | **AES-256-GCM**, key derived from `NOX_WALLET_SECRET` | deleted 30 days after settle; **disputed games keep them as evidence** |
| D6 Themes, scenarios, templates | code: `themes.ts`, `scenarios.ts`, `narrator.ts`; each theme and scenario has a `version`, its content hash is pinned in `bot/content.lock.json`, and the configHash committed at `createGame` names the GM and scenario with version and hash | | | – |
| D7 Credits & stats | chain `NoxCredits` (truth) + `RewardGranted`; index `player_stats` (credits, games, wins, streak, rank, badges from `NoxBadges`), reconciled with `balanceOf` (`reconciliations`) | | | rebuildable |
| D9 Payments & access | chain `NoxPayments` (passes, Game Nights, owner balances); index ledger + `payment_reconciliations` | | | permanent (chain) |
| D10 Clients & schedule | bot `finished_games.chat_id` (the group of each game) for reports; bookings are not built yet | | | |
| D14 Gas & tx ledger | bot `chain_txs` (step, from, to, hash, status, gas, fee, attempts, error; for gas drips also reason `onboarding` / `top-up` and the QIE sent), `operator_balances` | | | kept |
| D15 Event index | index `chain_events`, `chain_checkpoints` | | | rebuildable |
| D16 Agents & revenue | bot `agents` (owner, persona, mode, endpoint, **secret**, status, chain id, accepted terms version and time), `agent_games`, `agent_moderation`; chain `NoxAgentRegistry` (share, metadata hash); revenue from `NoxPayments` events in the index | | endpoint secret **AES-256-GCM** | kept |
| D11–D13 Guilds, creators, hosts | not built (phase 2) | | | |

## Who can read and write what

| Store | Bot | Indexer + public API | Operator CLI | Anyone (public) |
|---|---|---|---|---|
| Env secrets (operator key, wallet secret, bot token, API keys, webhook secret) | read | none (the indexer needs no key) | read (`agents`, `settle-agents`, `sim:game`) | never; redacted from every log line |
| bot `users`, `games`, `finished_games` | read/write | none | read (`report`) | none |
| bot `games.secret` (D5) | write, read at finalize/recovery | none | none | revealed on chain at the end of each game |
| bot `agents` + secret | read | none | write (`agents.ts`), reads the secret for `ping` only | persona name/tagline shown in lobbies |
| bot `chain_txs`, `operator_balances` | write | none | read (`gas:report`) | the txs themselves are public on chain |
| chain contracts | write as operator and as each player's wallet | read | write (`settle-agents`, deploy) | read; `claimRevealTimeout` for anyone |
| index DB | none | read/write | read (`report`) | through the API: aggregates and public events only |

Rules behind the matrix:
- Only the bot process can decrypt game secrets and endpoint secrets. The indexer and the API cannot, because they never get `NOX_WALLET_SECRET`.
- The public API serves only data that is already public on chain, plus aggregates. Telegram ids never leave the bot store.
- Reports for clients (Game Night) contain counts only.

## Backup, retention, migration

- `npm run backup` writes a consistent snapshot of the bot store with `VACUUM INTO` to `NOX_BACKUP_DIR` (default `data/backups`) and keeps the newest `NOX_BACKUP_KEEP` (default 14). Run it daily, for example from cron. Copy snapshots off the machine: they hold encrypted secrets and Telegram ids.
- Retention: role secrets 30 days after a game settles (disputed ones are kept); a player's account until `/forget`; the chain is permanent.
- Migrations: each store adds missing columns on open (`PRAGMA table_info` + `ALTER TABLE`), so an old file keeps working after an upgrade. Indexes are created with `IF NOT EXISTS`.
