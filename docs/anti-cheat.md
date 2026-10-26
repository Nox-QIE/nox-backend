# Anti-cheat: what is defended where

Red-team of cheating by players and by the server (APP-11). The tests live in `bot/test/anti-cheat.test.ts`, `bot/test/redteam.test.ts` (prompt injection) and `nox-contracts/test/NoxGame.t.sol`.

| Attempt | Defense | Where |
|---|---|---|
| Act or vote without being in the game, or in another group's game | Engine rejects unknown players; each room only knows its own seats | `@nox/shared/engine`, `GameRoom` |
| A villager forges a night-action button | Engine: `no_night_action` for roles without one | engine |
| Act twice, change the target, double vote | Engine: `already_acted`, `already_voted`; contract: `AlreadyCommitted`, `AlreadyVoted` | engine, `NoxGame` |
| Dead player acts or votes; target a dead, missing or odd id (`__proto__`, `11abc`, `1e3`) | Engine: dead or unknown player | engine |
| Replay an old button (earlier round), vote at night or during discussion | `GameRoom.isStale`: status, phase step and round must match | `GameRoom` |
| Parallel taps or a script racing the bot | Each room runs one action at a time (`run` queue); lobby never overfills | `GameRoom` |
| Join twice, after the start, or in two games at once | Lobby checks; one game per user | `GameRoom`, `Registry` |
| Start the game or pick the Game Master as a non-host | Host check | `GameRoom` |
| Pose as a werewolf in the werewolf chat | Only living werewolves at night are relayed | `GameRoom.wolfChat` |
| Flood commands, buttons or DMs | Per-user rate limit (`NOX_RATE_LIMIT`) | `ratelimit.ts` |
| Inject instructions or links through a display name or a persona | Prompt guard, name cleaning, 20 red-team attacks | `gm/guard.ts`, `names.ts` |
| A refused action still reaching the chain (which would revert and cancel the game) | Every refused attempt above is checked to send nothing to the ledger | anti-cheat tests |

**The server cheating** (changing roles after the deal, inventing night actions, sitting on a reveal) is covered by commit-reveal: roles are committed before they are dealt and checked at the reveal. A mismatch becomes a public `GameDisputed`, and anyone can flag a silent game after `revealTimeout` (ADR-001, ADR-004 in nox-contracts).

## Known limits

- **Multiple accounts.** One person can join a game from several Telegram accounts, and each gets its own wallet. Nothing in Telegram or in the wallets shows they are the same human. The planned defense is ranked play behind QIE ID, one verified human per account (F02). Until then, credits stay status-only and are not transferable, so farming them has no cash value.
- **Collusion outside the game.** Players can share their roles in another chat. This is inherent to social-deduction games and is not detectable from inside the game.
