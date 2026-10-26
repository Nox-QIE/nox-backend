# Agent Marketplace: running your own Game Master endpoint

Besides hosted personas (Nox's LLM speaks in your style), an agent can be backed by **your own HTTPS service**. Nox calls it for the atmosphere line of every beat. The factual line (who died, votes, roles at the end) is always Nox's own.

## Request

`POST <your https URL>` with `content-type: application/json`:

```json
{ "v": 1, "agentId": 12, "lang": "id", "facts": { "kind": "morning", "round": 2, "eliminated": "Ben", "revealedRole": "seer", "alive": 4 } }
```

`facts` is exactly what Nox's own LLM sees: public information only. `kind` is one of `intro`, `nightFalls`, `morning`, `dayResult`, `gameOver`. Roles appear only when they are public: the role of an eliminated player, and every role in `gameOver`. You never receive Telegram ids, secret roles of living players, night actions or Nox's instructions.

Headers:
- `x-nox-timestamp`: Unix seconds.
- `x-nox-signature`: `sha256=` + hex HMAC-SHA256 of `${timestamp}.${raw body}` with your agent secret (shown once when your agent is added).

Verify both before answering: compare the signature in constant time, and reject timestamps more than about 5 minutes away from your clock, so a recorded request cannot be replayed.

```js
const expected = "sha256=" + crypto.createHmac("sha256", SECRET).update(`${ts}.${rawBody}`).digest("hex");
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature)) && Math.abs(Date.now() / 1000 - Number(ts)) < 300;
```

## Answer

`200` with `content-type: application/json` and `{"text": "one to three short sentences"}`, at most 4 KB, within the Game Master timeout (8 s by default). Redirects are not followed.

## Rules your text must follow

The same guard as Nox's own narration applies. A line is dropped (and Nox's own voice or the template is used) when it:
- names a living player, or hints at anyone's role;
- contains a link or domain, HTML or markdown, an @mention;
- talks about money: deposits, wallets, addresses, amounts with a currency, cashing out, OTP or PIN;
- is empty or longer than 500 characters.

If your lines are rejected 3 times in one game, Nox stops calling your endpoint for that game. Agents that keep failing are suspended automatically and reviewed (see `agents.ts log <id>`).

## Network rules

Nox only connects to `https://` URLs on port 443, with no credentials in the URL, whose name resolves to public addresses only. The check runs on every connection, not just at registration. Private, loopback, link-local, carrier-grade NAT, cloud metadata and multicast addresses are refused.
