# nox-backend

Backend Nox: bot Telegram, worker on-chain, dan database.

| Folder | Isi |
|---|---|
| `bot/` | Bot Telegram (grammY, webhook) + runtime game engine + AI Game Master |
| `worker/` | Wallet & signer (KMS), gas drip, antrean tx per alamat, indexer event |
| `db/` | Skema & migrasi Postgres |

Memakai [`nox-shared`](https://github.com/Nox-QIE/nox-shared) untuk aturan game, crypto-spec, dan config. Bagian dari [Nox](https://github.com/Nox-QIE).

## Indexer event on-chain

`npm run indexer` menjaga `data/index.db` tetap sama dengan event kontrak Nox (NoxGame, NoxCredits, dan bila diisi NoxAgentRegistry & NoxPayments). Hanya membaca chain, jadi tidak butuh `NOX_OPERATOR_KEY` atau `NOX_WALLET_SECRET`.

- Satu `eth_getLogs` per potongan ≤ 10.000 blok untuk semua kontrak sekaligus (batas QIE).
- Berhenti `NOX_INDEX_CONFIRMATIONS` blok di belakang head (default 2) dan menyimpan hash blok checkpoint; bila hash berubah (reorg), mundur 64 blok dan memindai ulang.
- Event unik per `(tx_hash, log_index)`, jadi menjalankan ulang tidak menggandakan data. Database bisa dihapus dan dibangun ulang dari chain.
- `npm run indexer -- --once` mengejar sekali lalu mencetak statistik.

| Variabel | Default | Arti |
|---|---|---|
| `NOX_INDEX_FROM_BLOCK` | `NOX_PAYMENTS_FROM_BLOCK` | Blok deploy, awal pemindaian |
| `NOX_INDEX_CONFIRMATIONS` | 2 | Jarak aman dari head |
| `NOX_INDEX_POLL_SECONDS` | 10 | Jeda antar putaran |
| `NOX_INDEX_DB_PATH` | `data/index.db` | File SQLite indeks |
