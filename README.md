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

## API publik read-only

`npm run indexer` sekaligus melayani API JSON di atas indeks (default `127.0.0.1:8787`; pasang reverse proxy di depannya untuk publik). Semua datanya sudah publik di chain; API hanya menghemat klien dari memindai log sendiri.

| Endpoint | Isi |
|---|---|
| `GET /v1/health` | Jaringan, chain id, blok terakhir yang terindeks |
| `GET /v1/stats` | Wallet pemain unik, tx yang ditandatangani pemain, game selesai/batal, total credits |
| `GET /v1/leaderboard?limit=50` | Peringkat credits + game + menang (maks 200) |
| `GET /v1/games?limit=20&before=<blok>` | Game terbaru dulu, dengan status & pemenang (maks 100) |
| `GET /v1/games/<gameId>` | Ringkasan satu game + semua event-nya |
| `GET /v1/players/<address>` | Credits, game, menang, tx ditandatangani, riwayat peran |
| `GET /v1/daily?days=30` | Penanda tangan unik per hari UTC (maks 90) |

GET/HEAD saja, CORS `*`, `ETag` = blok terindeks (304 sampai indeks maju), `Cache-Control: public, max-age=5`, batas `NOX_API_RATE_PER_MINUTE` (default 120) per IP.

| Variabel | Default | Arti |
|---|---|---|
| `NOX_API_PORT` | 8787 | `off` untuk mematikan API |
| `NOX_API_HOST` | `127.0.0.1` | Alamat bind |
| `NOX_API_TRUST_PROXY` | – | `1` = pakai `X-Forwarded-For` (hanya di belakang proxy) |
| `NOX_API_RATE_PER_MINUTE` | 120 | Batas request per IP per menit |
