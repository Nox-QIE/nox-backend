# Game Master LLM providers: data policy

Checked on 26 October 2026 for NOX-F09-D06: is narration data used to train models, and how long is it kept? Policies change, so check again before mainnet and whenever a provider or model is added.

## What Nox sends

Every Game Master request holds Nox's fixed system prompt, the persona's style text when an agent is picked, and the public facts of one beat ([data-contracts.md](data-contracts.md), E7). The facts include player **display names**: the eliminated player, and the full roster at game over. They never include Telegram ids, wallet addresses, the secret roles of living players, night actions or wolf chat. Display names are still personal data under UU PDP, so the provider matters.

## Findings

| | Anthropic Claude API (`anthropic`) | Oxion AI gateway (`oxion`) |
|---|---|---|
| Training on prompts and outputs | No, by default, for commercial products including the API. Exceptions: feedback the customer submits, or an explicit opt-in. Nox submits neither. | Oxion's terms say it does not train on prompts or outputs. For Claude models, its `/v1/models` lists the upstream as `owned_by: cleanapis`. No public policy for "cleanapis" could be found, so nothing is known about that hop. |
| Retention | Inputs and outputs are deleted from Anthropic's backend within 30 days. Content flagged by trust and safety may be kept up to 2 years, and classifier scores up to 7 years. "Covered models" (Claude Fable 5, Mythos 5) are always kept 30 days for safety review. Nox's pool does not use them. | Oxion says it stores no prompt or reply content, only metadata (time, model, tokens, status, key). A failed request may log an error fragment. The upstream's own retention "then applies", and that retention is unknown. |
| Operator and law | Anthropic PBC, under its Commercial Terms | "Operated by Oxion AI". No legal entity, address or governing law is given. Terms effective 23 Aug 2026. |
| Verdict in code | `verified` | `unverified` |

Sources:
- Anthropic: privacy.claude.com articles "Is my data used for model training?", "How long do you store my organization's data?" and "Data retention practices for covered models".
- Oxion: oxionai.com/terms and oxionai.com/privacy; `GET https://oxionai.com/v1/models`.

## Proposed decision (awaiting the team's approval)

1. **Real players, on mainnet and in pilot groups**: use the Anthropic Claude API directly (`NOX_GM_MODELS=anthropic:…`). Its no-training default and its 30-day deletion are published. Do not add covered models (Fable 5, Mythos 5) without noting their 30-day safety review in the privacy notice.
2. **Oxion**: fine for development, testnet runs and the red-team, where every name belongs to the team or is made up. Do not use it with real players until Oxion names its upstream for Claude models and that upstream publishes a no-training, bounded-retention policy.
3. **Privacy notice** (`/privacy`): it already says that eliminated players' names and the final roster go to the AI provider. Once the provider is decided, add its name and its retention period (30 days for Anthropic).

## In code

`GM_PROVIDER_POLICY` in `bot/src/config.ts` marks each provider `verified` or `unverified`. At startup the bot logs a `gm_data_policy` warning when the pool contains an unverified provider, and the wording is stricter on mainnet. Making this a hard stop on mainnet is a one-line change, made once the team approves the decision.
