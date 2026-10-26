# Data contracts per external entity (DFD level 0)

Vault note 10.03 (DFD level 0) draws Nox as one process with eleven external entities. This page writes down, for each entity, what flows in and what flows out as the code is built today. Each flow lists its format and the place in the code that defines it. Flows that are designed but not built yet are marked **not built**. `bot/test/data-contracts.test.ts` fails when the bot gains a button, command, Game Master beat, chain call or API resource that this page does not name.

## E6 Telegram (carrier for E1 players and E2 hosts)

**In.** Telegram sends updates to `POST /telegram/webhook` with the header `X-Telegram-Bot-Api-Secret-Token`. Any other value gets `401` (`bot/src/webhook.ts`). Without `NOX_WEBHOOK_URL`, the bot polls instead. Each user is rate-limited per command, button and DM (`bot/src/ratelimit.ts`).

Commands:

| Command | Who | Payload | Effect |
|---|---|---|---|
| `/start` | player, private chat | optional deep-link word: `latihan` / `practice` opens the Scam Shield quiz | creates the account and its derived wallet; stores telegram id, locale and wallet address |
| `/newgame` | host, group | optional theme word, e.g. `/newgame horor` | opens a lobby |
| `/pass` | host, private chat | – | shows Host Pass status (read on chain) |
| `/latihan`, `/practice` | anyone, private chat | – | Scam Shield practice quiz |
| `/privacy`, `/privasi` | anyone | – | privacy notice |
| `/forget`, `/lupakan` | player | confirmed with the `f:yes` button | deletes the account (right to erasure) |

Button callback data, at most 64 bytes as Telegram requires. `<room>` is the lobby id, `<round>` the round number, `<target>` a seat id:

| Data | Who | Meaning |
|---|---|---|
| `j:<room>` | player | join the lobby |
| `s:<room>` | host | start the game |
| `a:<room>:<agentId>` | host | pick a Game Master (`0` = Nox) |
| `n:<room>:<round>:<target>` | player with a night role, by DM | night action (kill, see, protect) |
| `v:<room>:<round>:<target>` | living player | day vote |
| `q:<item>:<s\|k>` | anyone in the practice quiz | answer: scam (`s`) or safe (`k`) |
| `f:yes` | player | confirm `/forget` |

Text messages:
- **Group**: counted only, to see whether discussion has gone quiet (discussion nudge). Never stored or read further.
- **Private, from a living werewolf at night**: forwarded to the other living werewolves (wolf chat). Never stored.

**Out.** Messages are sent with `parse_mode: HTML`, with inline keyboards built from the callback formats above. Every name and every piece of user text is HTML-escaped.

| To | What |
|---|---|
| group | lobby status, narration of each beat, vote and night results, final roles, proof link of the game (when `NOX_WEB_URL` is set) |
| player DM | secret role and night-action buttons; wolf chat; rewards (credits with their breakdown, the Scam Spotter badge); Host Pass status; quiz items |
| operator DM (`NOX_OPERATOR_CHAT_ID`) | alerts: error spikes, disputed game, low operator balance, suspended agent |

## E7 LLM provider

**Out** (`bot/src/gm/prompt.ts`, `llm-narrator.ts`):
- **System prompt**: Nox's fixed rules first. For a persona, the persona then follows inside `<style>…</style>` as JSON, marked as data, not instructions.
- **User message**: `<facts>{beat as JSON}</facts>`.

Beat kinds:

| `kind` | Fields |
|---|---|
| `intro` | `playerCount` |
| `nightFalls` | `round`, `alive` |
| `morning` | `round`, `eliminated` (display name or null), `revealedRole`, `alive` |
| `dayResult` | `round`, `eliminated`, `revealedRole`, `alive` |
| `gameOver` | `winner`, `roster` (display name and role of everyone) |
| `nudge` | `round`, `alive` |

Only public facts are sent. The LLM never receives Telegram ids, the secret roles of living players, night actions, wolf chat or wallet addresses.

**In.** One narration text. It must pass the guard (`bot/src/gm/guard.ts`):
- names no living player and hints at no role;
- has no links, markup, @mentions or money talk;
- is 1–500 characters.

A line that fails falls back in layers: persona → Nox's own voice → template. The provider is `NOX_GM_PROVIDER` (`anthropic` or `oxion`); costs per game are recorded in `gm_games`. What each provider does with the prompts (training, retention) is in [llm-data-policy.md](llm-data-policy.md).

## E8 QIE blockchain

**Out: transactions** (`bot/src/chain/viem-ledger.ts`, `operator.ts`). The arguments are fixed by the contract ABIs in `bot/src/chain/contracts.ts` (synced from nox-contracts). Each transaction, with its hash, gas, fee and status, goes into the `chain_txs` ledger.

| Function | Signed by | Payload |
|---|---|---|
| `NoxGame.createGame` | operator | game id, `configHash` (players, timings, language, Game Master and scenario with version and hash) |
| `NoxGame.joinGame` | the player's own wallet | game id |
| `NoxGame.commitRoles` | operator | Merkle root of salted roles |
| `NoxGame.commitNightAction` | the player's own wallet | round, `actionHash` (sealed action) |
| `NoxGame.castVote` | the player's own wallet | round, target wallet |
| `NoxGame.recordRound` | operator | round, `resultHash` |
| `NoxGame.revealAndFinalize` | operator | revealed roles with salts and proofs, night nonces, result hash, winner |
| `NoxGame.reportDispute` | operator | game id, the check that failed |
| `NoxGame.cancelGame` | operator | game id, reason |
| `NoxBadges.award` | operator | badge id, game id, wallets |
| `NoxAgentRegistry.registerAgent` | operator | owner wallet, mode, metadata hash |
| `NoxPayments.allocateAgentPool` | operator | period, token, agent ids, amounts, usage root (commitment to the per-game data) |
| gas drip (plain transfer) | operator | value to a player wallet; ledger reason `onboarding` or `top-up` |

Reads: `games`, `streakOf` (NoxGame), `passExpiry`, `priceOf`, `periodOf` (NoxPayments), `shareOf` (NoxAgentRegistry), balances.

**In: events.** The indexer reads NoxGame, NoxCredits, NoxAgentRegistry, NoxPayments and NoxBadges, `NOX_INDEX_CONFIRMATIONS` blocks deep, at most 10,000 blocks per `eth_getLogs` call. The events go into `chain_events`, keyed by block and log index. Public definitions of what is counted are in [metrics.md](metrics.md).

## E5 Nox operator

- **In.**
  - Env configuration (`.env`; secrets are only ever redacted, never logged).
  - The CLI: `agents.ts`, `settle-agents.ts`, `npm run report`, `ops:report`, `gas:report`, `wallet:audit`, `reconcile:txs`, `backup`, `content:lock`.
  - Theme and scenario content in code, versioned (`bot/content.lock.json`).
  - Treasury top-ups: QIE sent to the operator address.
- **Out.**
  - Alert DMs (above).
  - CLI reports. Each takes no key except `settle-agents --send`, `agents.ts register` and deploys.
  - The Game Night report as Markdown and JSON: counts only.

## E12 Agent owner

See [agent-terms.md](agent-terms.md), section 3, for the full table. In short:
- **In.** Persona fields and payout wallet (`agents.ts add`), an endpoint URL, and atmosphere lines `{"text"}` from the endpoint.
- **Out.**
  - Signed public facts: HMAC-SHA256 over `timestamp.body` ([agent-endpoint.md](agent-endpoint.md)).
  - The signing secret, shown once.
  - Moderation decisions with their reason.
  - Revenue on chain (`AgentCredited`, `AgentPoolAllocated`).

## Public read API (out to E1, E3 and anyone)

`GET /v1/health`, `/v1/stats`, `/v1/leaderboard`, `/v1/daily`, `/v1/engagement`, `/v1/games`, `/v1/games/<id>`, `/v1/players/<address>`, `/v1/agents/revenue`. These are GET/HEAD only, with CORS `*` and an ETag equal to the indexed block. They return JSON: public chain data and aggregates only. Every field is defined in [metrics.md](metrics.md).

## E3 B2B client

- **Out.**
  - The Game Night engagement report: Markdown and JSON from `npm run report`, the same definitions as `/v1/engagement`. It holds counts only and hides counts of 1–2.
- **In.**
  - Payment for a Game Night on chain: `NoxPayments.payGameNight` (booking id, agent id, token, amount). It credits the agent owner's share directly.
  - Booking, custom themes and sponsor funds: **not built** (portal planned, L0-08).
  - Rupiah payment: **not built** (E10).

## E9 QIE ID: not built

The design: Nox opens a verification session bound to the player's wallet address and a one-time nonce. QIE ID answers with a verification status and a unique-human id (nullifier). Nox stores only the status, the nullifier and the time, never KYC data. The interface is waiting on QIE's answer about partner API versus on-chain attestation (F02-S01).

## E10 Rupiah PSP: not built

The design: a checkout for passes and Game Nights, and a payment webhook whose signature is verified before anything is granted. A receipt hash is recorded through NoxPayments (`FiatGameNightRecorded`). No PSP account exists yet (F14-S07).

## E4 Creator: not built (phase 2)

The design: Story Packs and payout data in; moderation status and royalties out.
