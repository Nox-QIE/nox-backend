# nox-backend

Backend Nox: bot Telegram, worker on-chain, dan database.

| Folder | Isi |
|---|---|
| `bot/` | Bot Telegram (grammY, webhook) + runtime game engine + AI Game Master |
| `worker/` | Wallet & signer (KMS), gas drip, antrean tx per alamat, indexer event |
| `db/` | Skema & migrasi Postgres |

Memakai [`nox-shared`](https://github.com/Nox-QIE/nox-shared) untuk aturan game, crypto-spec, dan config. Bagian dari [Nox](https://github.com/Nox-QIE/nox).
