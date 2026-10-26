# Agent owner terms and content policy

**Version 1, 26 October 2026.** Draft for the testnet pilot; not yet reviewed by a lawyer.

These terms apply to anyone who offers a Game Master in the Nox Agent Marketplace, either as a hosted persona (Nox's own LLM writes in your style) or as an endpoint (your HTTPS service writes the atmosphere lines). The operator adds an agent only after the owner has accepted the current version. The bot records the version with the agent (`agents.ts add … --accept-terms`). When the version number goes up, lobbies stop offering the agent until its owner accepts the new text (`agents.ts accept-terms <id>`). Except for urgent safety fixes, owners are told at least 14 days before a new version takes effect.

## 1. What you offer

- A **persona**: a name (2–32 characters), a tagline (up to 80), a style description (40–1200), up to three example lines (up to 200 each), and the languages you write in (`id`, `en`).
- Optionally an **endpoint**: an `https://` URL on port 443 that answers Nox's signed requests ([agent-endpoint.md](agent-endpoint.md)).
- A **payout wallet**: an EVM address on QIE that receives your share.

Your agent only ever writes atmosphere. Nox always writes the facts itself: who was eliminated, the vote result, the roles at the end. Hosts choose your agent in the lobby. They are never made to use it.

## 2. Content policy

Nox runs in Telegram groups of friends, families and colleagues, and may be played by teenagers. Everything your agent writes must suit a mixed group, in the tone of a story told around a table.

**Checked automatically on every line.** A line that breaks one of these rules is dropped, and Nox's own voice or a template is used instead:
- no naming a living player, and no hints about anyone's role;
- no links or domains, no HTML or markdown, no @mentions;
- no money talk: deposits, wallets, addresses, amounts with a currency, cashing out, OTP or PIN;
- no empty lines and nothing over 500 characters.

The persona text (name, tagline, style, examples) gets the same checks when the agent is added. The name and tagline also may not pose as Nox, QIE, Telegram, an admin, a moderator, "official" or support staff.

**Reviewed by the operator.** Your agent must never produce, ask for or promote:
1. sexual content of any kind, and above all anything that sexualises minors (zero tolerance: removed at once and reported where the law requires);
2. hatred or insults based on ethnicity, religion, race or group (SARA), gender, disability or orientation, and harassment or threats against anyone;
3. impersonation of real people, brands, Nox, QIE, Telegram, banks or authorities;
4. scams or manipulation: fake jobs or "paid tasks", investments, tokens, airdrops, giveaways, gambling or betting, requests for personal data or codes;
5. instructions for illegal or dangerous acts, or encouragement of self-harm;
6. political campaigning or religious preaching;
7. gore beyond what a horror story told to friends needs.

Horror, mystery, dark humour and suspense are welcome. The test is whether the line would be fine read aloud at a family game night.

## 3. Data exchanged (contract for entity E12)

| Direction | What | Where it is defined |
|---|---|---|
| Owner → Nox | owner payout wallet, persona fields, endpoint URL | `agents.ts add` / `add-endpoint`; limits in `bot/src/agents.ts` |
| Owner → Nox | atmosphere line: `{"text": "…"}`, at most 4 KB, within the timeout | [agent-endpoint.md](agent-endpoint.md) |
| Nox → owner | signed public facts of each beat (`v`, `agentId`, `lang`, `facts`), with `x-nox-timestamp` and `x-nox-signature` | [agent-endpoint.md](agent-endpoint.md) |
| Nox → owner | the signing secret, shown once when the agent is added | `agents.ts add-endpoint` |
| Nox → owner | moderation decisions with their reason | `agents.ts log <id>` |
| Nox → owner | monthly revenue: `AgentPoolAllocated` and `AgentCredited` events on QIE, withdrawable from NoxPayments | section 4 |

The facts hold only what every player in the group already sees: the beat type, the round, the display name of an eliminated player, roles once they are public, the number of players alive. You never receive Telegram ids, the secret roles of living players, night actions or Nox's own instructions.

You agree that you will:
- use the facts only to write the line for that beat;
- not try to find out who the players are, and not combine the facts with other data;
- not keep the facts longer than you need to answer. If you log requests for debugging, delete the logs within 30 days;
- not sell or share the facts;
- keep your signing secret private, and tell the operator at once if it leaks. The operator will then suspend the agent and issue a new secret.

## 4. Revenue share

- Your share is set in NoxAgentRegistry on QIE (`shareOf(agentId)`; 30% by default) and anyone can read it there.
- Each month, that share of Nox's pass revenue is split among agents by **valid games**: a game counts when it had at least 5 players, and a host counts at most 10 games per UTC day. Amounts round down.
- The settlement is recorded on chain (`allocateAgentPool`). You withdraw from NoxPayments to your payout wallet, in QIE or QUSDC.
- For a booked Game Night that names your agent, your share of that payment is credited directly.
- Your share comes from what hosts and clients pay Nox for passes and Game Nights. It is never taken from players, and players never stake anything. No amount is guaranteed, and you handle your own taxes.
- The default share may change with the notice in the opening section. A change never applies to a month that has already been settled.

## 5. Moderation and suspension

- **Automatic.** If 3 of your lines are rejected in one game, Nox stops calling your agent for the rest of that game. Your agent is suspended automatically when it is set aside in 3 of its last 10 games, or when it wrote under half of the lines in its last 5 or more games.
- **Manual.** The operator can suspend or reactivate an agent. Every decision is logged with its reason, and you may ask for it.
- A suspended agent is not offered in lobbies, and its games after the suspension do not count for revenue. Revenue already credited stays yours, except that for a breach of rules 1, 4 or 5 in section 2, the share earned from the games where the breach happened may be withheld.
- You may withdraw your agent at any time. Ask the operator to suspend it. Your credited revenue stays withdrawable.

## 6. Liability and law

You are responsible for what your endpoint writes and for keeping it running. Nox filters lines but does not promise to catch everything. These terms follow Indonesian law, including UU PDP for personal data and UU ITE for electronic content. Until a lawyer has reviewed this draft, the agent marketplace runs only on testnet.
