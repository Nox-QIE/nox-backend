# nox-backend

Backend Nox: bot Telegram, ledger on-chain, indexer event, dan API publik.

| Folder | Isi |
|---|---|
| `bot/src/` | Bot Telegram (grammY, webhook atau long polling), ruang game, AI Game Master, ledger chain (viem: wallet turunan, gas drip, antrean tx per game), indexer event + API publik `/v1/*`, store SQLite (`node:sqlite`) |
| `bot/scripts/` | CLI operator: laporan, booking Game Night, pass, agent, settlement, rekonsiliasi, backup, rotasi kunci, simulasi |
| `bot/test/` | Tes unit + e2e anvil (`vitest`) |
| `docs/` | Arsitektur, model data, kontrak data, metrik, anti-cheat, syarat agent, kebijakan data LLM, ADR |
| `agents/` | Contoh persona untuk `agents.ts add` |
| `worker/`, `db/` | Hanya penunjuk: kode worker ada di `bot/src/chain/`, data ada di SQLite (lihat `docs/data-model.md`) |

Memakai [`nox-shared`](https://github.com/Nox-QIE/nox-shared) untuk aturan game, crypto-spec, dan config. Bagian dari [Nox](https://github.com/Nox-QIE).


Peta arsitektur (komponen, alur satu game, model kepercayaan, data, operasi): [docs/architecture.md](docs/architecture.md).
## Indexer event on-chain

`npm run indexer` menjaga `data/index.db` tetap sama dengan event kontrak Nox (NoxGame, NoxCredits, dan bila diisi NoxAgentRegistry & NoxPayments). Hanya membaca chain, jadi tidak butuh `NOX_OPERATOR_KEY` atau `NOX_WALLET_SECRET`.

- Satu `eth_getLogs` per potongan ≤ 10.000 blok untuk semua kontrak sekaligus (batas QIE).
- Berhenti `NOX_INDEX_CONFIRMATIONS` blok di belakang head (default 2) dan menyimpan hash blok checkpoint; bila hash berubah (reorg), mundur 64 blok dan memindai ulang.
- Event unik per `(tx_hash, log_index)`, jadi menjalankan ulang tidak menggandakan data. Database bisa dihapus dan dibangun ulang dari chain.
- `npm run indexer -- --once` mengejar sekali lalu mencetak statistik.
- Setelah tiap sync yang menyimpan event (dan tiap jam, karena streak bisa putus seiring waktu) tabel `player_stats` (cermin D7: credits, game, menang, streak, rank) dibangun ulang.
- Bila `NOX_PAYMENTS_ADDRESS` diisi, saldo pemilik agent (`ownerBalance`) dan treasury (`treasuryBalance`) juga dicocokkan dengan buku besar dari event (`payments_reconciled` / `payments_mismatch`).
- Tiap `NOX_RECONCILE_MINUTES` credits terindeks dicocokkan dengan `NoxCredits.balanceOf` **di blok terindeks**; selisih atau mint untuk game yang tidak pernah finalize dicatat sebagai `credits_mismatch`.

| Variabel | Default | Arti |
|---|---|---|
| `NOX_INDEX_FROM_BLOCK` | `NOX_PAYMENTS_FROM_BLOCK` | Blok deploy, awal pemindaian |
| `NOX_INDEX_CONFIRMATIONS` | 2 | Jarak aman dari head |
| `NOX_INDEX_POLL_SECONDS` | 10 | Jeda antar putaran |
| `NOX_INDEX_DB_PATH` | `data/index.db` | File SQLite indeks |
| `NOX_RECONCILE_MINUTES` | 60 | Jeda rekonsiliasi credits (`off` untuk mematikan) |

## API publik read-only

`npm run indexer` sekaligus melayani API JSON di atas indeks (default `127.0.0.1:8787`; pasang reverse proxy di depannya untuk publik). Semua datanya sudah publik di chain; API hanya menghemat klien dari memindai log sendiri.

| Endpoint | Isi |
|---|---|
| `GET /v1/health` | Jaringan, chain id, blok terakhir yang terindeks, hasil rekonsiliasi credits terakhir |
| `GET /v1/stats` | Wallet pemain unik, tx yang ditandatangani pemain, game selesai/batal, total credits |
| `GET /v1/leaderboard?limit=50&season=2026-10` | Peringkat dari cermin D7: credits, game, menang, streak, rank (maks 200); `season` = bulan UTC |
| `GET /v1/games?limit=20&before=<blok>` | Game terbaru dulu, dengan status & pemenang (maks 100) |
| `GET /v1/games/<gameId>` | Ringkasan satu game + semua event-nya |
| `GET /v1/players/<address>` | Credits, game, menang, tx ditandatangani, riwayat peran |
| `GET /v1/daily?days=30` | Penanda tangan unik per hari UTC (maks 90) |
| `GET /v1/engagement?weeks=8` | Engagement semua grup dengan definisi yang sama persis dengan laporan Game Night klien (game selesai, kursi, pemain unik, aktif & retensi per minggu ISO; maks 26 minggu) |
| `GET /v1/agents`, `GET /v1/agents/<id>` | Agent Marketplace dari NoxAgentRegistry (D16): pemilik, mode, status, hash persona, share (bps), pendapatan per token |
| `GET /v1/agents/revenue` | Pendapatan agent Marketplace dari event NoxPayments: per agent (Game Night vs pool bulanan) dan per pemilik (dikreditkan, ditarik, terutang); jumlah dalam wei (string) |

Definisi setiap angka (sumber event, aturan waktu UTC, privasi): [docs/metrics.md](docs/metrics.md).

Masuk ke web tanpa password (NOX-APP-14): isi `NOX_LOGIN_SECRET` (`openssl rand -hex 32`, sama di bot dan API) dan `NOX_WEB_URL`. `/web` (`/masuk`) di chat pribadi memberi tautan `<NOX_WEB_URL>/login/#t=<token>` yang berlaku 10 menit dan hanya sekali. Web menukarnya lewat `POST /v1/login` dengan sesi 7 hari, lalu `GET /v1/me` (header `Authorization: Bearer`) memberi alamat wallet game pemain. Tanpa secret, API tetap hanya GET.

API berjalan di **Fastify**. Spesifikasi OpenAPI 3 semua route ada di `GET /v1/openapi.json` (untuk tim FE). GET/HEAD saja, CORS `*`, `ETag` = blok terindeks (304 sampai indeks maju), `Cache-Control: public, max-age=5`, batas `NOX_API_RATE_PER_MINUTE` (default 120) per IP; parameter salah → 400 dengan nama field-nya.

| Variabel | Default | Arti |
|---|---|---|
| `NOX_API_PORT` | 8787 | `off` untuk mematikan API |
| `NOX_API_HOST` | `127.0.0.1` | Alamat bind |
| `NOX_API_TRUST_PROXY` | – | `1` = pakai `X-Forwarded-For` (hanya di belakang proxy) |
| `NOX_API_RATE_PER_MINUTE` | 120 | Batas request per IP per menit |

## Menjalankan bot di server (webhook)

Lokal cukup long polling (`NOX_WEBHOOK_URL` kosong). Di server isi `NOX_WEBHOOK_URL` (URL https publik bot) dan `NOX_WEBHOOK_SECRET` (`openssl rand -hex 32`). Bot mendengarkan di `NOX_WEBHOOK_HOST:NOX_WEBHOOK_PORT` (default `127.0.0.1:8080`) pada path `/telegram/webhook` di belakang reverse proxy https, lalu memanggil `setWebhook` dengan secret itu. Update tanpa header `X-Telegram-Bot-Api-Secret-Token` yang cocok ditolak 401. `GET /healthz` menjawab `ok`. Kembali ke long polling cukup dengan mengosongkan `NOX_WEBHOOK_URL`: webhook dihapus otomatis saat start.

Setiap pengguna dibatasi `NOX_RATE_LIMIT` (default 20 update per 10 detik) untuk perintah, tombol, dan pesan pribadi; obrolan grup biasa tidak dibatasi.

## Agent Marketplace: endpoint sendiri

Selain persona hosted, agent bisa memakai layanan HTTPS milik pemiliknya: `agents.ts add-endpoint <wallet> <persona.json> <https-url> --accept-terms` (URL & DNS dicek, secret penandatanganan dibuat dan ditampilkan sekali, disimpan terenkripsi), `agents.ts ping <id>` untuk uji. Protokol, verifikasi tanda tangan, dan aturan untuk pemilik: [docs/agent-endpoint.md](docs/agent-endpoint.md).


Setiap pemilik agent harus menyetujui syarat & kebijakan konten [docs/agent-terms.md](docs/agent-terms.md) (versi di `AGENT_TERMS`, `bot/src/agents.ts`). `agents.ts add … --accept-terms` mencatat versinya per agent; lobby hanya menawarkan agent yang pemiliknya sudah menyetujui versi terbaru. Bila versi dinaikkan, agent lama tersembunyi sampai `agents.ts accept-terms <id>`. Nama & tagline persona juga tidak boleh menyamar sebagai Nox, QIE, Telegram, admin, atau staf resmi.
## Laporan engagement Game Night (klien B2B)

`npm run report -- <chat-id-grup> <YYYY-MM> [id|en] ["Nama grup"]` menulis laporan Markdown + JSON (`NOX_REPORT_DIR`, default folder saat ini) dari store bot (game mana yang dimainkan di grup itu) dan indeks event (pemain & waktu dari chain). Isinya hanya angka gabungan: game selesai, kursi terisi, pemain unik, rata-rata pemain/durasi/ronde, credits, pemain aktif per minggu, pemain yang kembali, retensi, dan link bukti tiap game. Tanpa nama, ID Telegram, atau alamat wallet; angka di bawah 3 ditampilkan "<3". Definisi metrik ada di `bot/src/report.ts`.

## Data & backup

Di mana tiap data store desain (D1–D16) berada sekarang (store bot, chain, indeks), siapa yang boleh membaca/menulis, retensi, dan migrasi: [docs/data-model.md](docs/data-model.md). Store bot (`data/nox.db`) satu-satunya yang perlu di-backup: `npm run backup` (snapshot konsisten `VACUUM INTO`, simpan 14 terbaru; `NOX_BACKUP_DIR`, `NOX_BACKUP_KEEP`). Indeks dibangun ulang dari chain.

Rotasi kunci enkripsi store (rahasia game, payload finalize, secret endpoint agent): `NOX_STORE_KEYS="2:<64 hex>,1:<64 hex>"` (entri pertama dipakai menyegel; versi 0 tetap dari `NOX_WALLET_SECRET` untuk data lama), lalu `npm run store:rotate -- --apply` menyegel ulang semua blob ke kunci terbaru dan hanya mencetak jumlah per versi. Langkah lengkap: docs/data-model.md.

Payload masuk/keluar untuk setiap entitas eksternal di DFD level 0 (Telegram: perintah & data tombol; LLM: beat & fakta; chain: fungsi & event; operator; pemilik agent; API publik; QIE ID, PSP, kreator yang belum dibangun): [docs/data-contracts.md](docs/data-contracts.md). Tes `data-contracts.test.ts` gagal bila kode menambah tombol, perintah, beat, panggilan kontrak, atau endpoint API yang belum tertulis di sana.

Kebijakan data penyedia LLM (training, retensi; Anthropic `verified`, Oxion `unverified` karena hulunya `cleanapis` tanpa kebijakan publik) dan usulan keputusan: [docs/llm-data-policy.md](docs/llm-data-policy.md). Bot mencatat peringatan `gm_data_policy` saat start bila pool memakai penyedia `unverified`.

## Host Pass

`/pass` di chat pribadi menampilkan wallet game pemain, status Host Pass (dari `NoxPayments.passExpiry`), harga, dan cara bayar: dari wallet sendiri dengan `buyPassFor(<wallet game>, 1, <periode>, 0x0…0)`, sehingga Nox tidak pernah memakai dana pemain. Dengan `NOX_HOST_PASS=required`, tema, Game Master Marketplace, dan lobby lebih dari 8 pemain butuh Host Pass aktif milik host (dibaca on-chain, cache 5 menit; bila RPC gagal host tetap boleh lanjut dan kejadian dicatat). Scam Shield tetap gratis.

## Latihan Scam Shield (untuk keluarga)

`https://t.me/<bot>?start=latihan` (atau `?start=practice`) membuka kuis 3 menit di chat pribadi: 6 pesan bergaya penipuan "misi berbayar" (satu di antaranya aman), pilih penipuan atau aman, tiap jawaban dijelaskan, lalu kartu Scam Shield dan tautan untuk diteruskan. `/latihan` di grup mengirim tautannya. Tidak butuh wallet dan tidak membuat akun; jawaban hanya di memori selama kuis, store menyimpan hitungan harian (dimulai/selesai) saja.

## Observabilitas

- Tiap game selesai mencatat pemakaian AI di `gm_games` (model, token, biaya USD, beat oleh persona / suara Nox / template).
- Lonjakan error memicu DM ke `NOX_OPERATOR_CHAT_ID` (maks sekali per jam per jenis): ≥3 `chain_error` dalam 10 menit, ≥10 `gm_error`, ≥5 `bot_error`. Insiden tunggal (game disputed, saldo operator menipis, agent di-suspend) punya alert sendiri.
- `npm run ops:report [hari]`: per hari game, kursi, biaya AI, porsi template, gas, tx gagal, latihan Scam Shield (selesai/dimulai), wallet baru, QIE yang di-drip (berapa untuk onboarding), aktivitas diskusi (rata-rata pesan per diskusi, diskusi tanpa pesan, jumlah pancingan; hanya angka), dan saldo operator terakhir.
- `npm run wallet:audit -- 0x<alamat>`: riwayat audit satu wallet pemain: kapan dibuat, tiap gas drip beserta alasannya (`onboarding` = gas pertama, `top-up`) dan jumlahnya, dan apakah akunnya dihapus (`/forget`). Hanya alamat: tanpa ID Telegram dan tanpa materi kunci.
- `npm run gamenight -- quote <chat-id|-> <waktu ISO + zona> <harga> "<klien>" [--theme] [--agent] [--token --decimals] [--contact]`: penawaran Game Night B2B + instruksi bayar `payGameNight` untuk klien; `sync` mencocokkan event `GameNightPaid` dari indeks dengan penawaran (token, jumlah ≥ harga, agent) lalu menandai `paid`; `list`, `show`, `cancel`, `forget-contact`. Tanpa kunci: klien membayar dari wallet-nya sendiri. Setelah `paid` (dan grup diisi, `set-chat`), bot yang berjalan mengumumkan malamnya di grup 24 jam & 1 jam sebelumnya lalu memposting tombol "Saya host" tepat waktu: yang pertama menekan jadi host, lobby terbuka dengan tema/skenario/agent sesuai booking tanpa Host Pass; `sync` menandai `played` setelah ada game selesai di grup itu.
- Booking rupiah (MVP, invoice manual): `gamenight quote … <harga Rp> "<klien>" --idr` mencetak penawaran dengan kode booking untuk berita transfer; setelah dana masuk, `gamenight paid-idr <booking> <file bukti> --send` mencatat `recordFiatGameNight` on-chain dengan hash bukti (terikat ke booking) memakai kunci operator, lalu menandai `paid`. Tanpa `--send` hanya menampilkan hash. File bukti tidak pernah dipublikasikan. Bila malam rupiah memakai agent, porsi pemiliknya dalam rupiah ditetapkan saat itu dari `shareOf` on-chain; `gamenight payouts` menampilkan utang per wallet pemilik dan `gamenight paid-out <booking> "<ref transfer>"` mencatat transfer manualnya.
- Host Pass: `npm run pass -- list <0xwallet | tg:<id>>` menampilkan riwayat pembelian (D9: on-chain dengan pembayarnya, atau rupiah dengan hash struk). Pass rupiah (MVP, manual): `npm run pass -- fiat <0xwallet | tg:<id>> <periode> <rupiah> <file bukti> [--send]` mencatat `recordFiatPass` dengan kunci operator; struk yang sama ditolak (kontrak sendiri tidak menolaknya). `/v1/players/<alamat>` kini memuat `passes`.
- Rel bayar per negara akun (F14-D04): akun berbahasa Indonesia dianggap di Indonesia (`ID`), pemain bisa mengubahnya dengan `/negara <kode>` (`/country`). Untuk `ID`, `/pass` menambahkan jalur invoice rupiah dengan kontak dari `NOX_PAYMENT_CONTACT` (mis. `@nox_sales`); negara lain membayar QIE/QUSDC on-chain.
- Bayar Host Pass dengan QUSDC (F14-S04): isi `NOX_QUSDC_ADDRESS` (mainnet `0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5`, 6 desimal; tidak ada di testnet). Bila admin sudah memberi harga QUSDC di NoxPayments (`setTokenAllowed` + `configurePass(1, QUSDC, harga, periode)`), `/pass` menambahkan jalur `approve` lalu `buyPassFor(wallet, 1, periode, QUSDC)`.
- Tema khusus klien: `npm run gamenight -- theme <file.json>` (kunci, klien pemilik, teks per bahasa: nama, tagline, gaya, contoh, nama peran opsional seperti `{"werewolf": "🕵️ Penyusup"}`); menyimpan ulang kunci yang sama menaikkan versinya; `themes` menampilkan daftar. Penawaran untuk klien itu memakai `--theme client:<kunci>`; tema hanya muncul di lobby booking klien tersebut, tidak di grup lain, dan nama perannya dipakai di DM peran dan narasi.
- `npm run sponsor:report -- <YYYY-MM | YYYY-MM-DD..YYYY-MM-DD> "<Sponsor>" [id|en]`: laporan musim Scam Shield untuk sponsor (Markdown + JSON): game Scam Shield selesai per skenario (kunci@versi), kursi, jumlah grup, game saat penipu dikenali (desa menang), lencana Scam Spotter on-chain (bila indeks ada), latihan 3 menit dimulai/selesai. Hanya angka gabungan; 1–2 ditampilkan "<3".
- Bonus Scam Shield (F10-S05): game Scam Shield dibuat dengan `createGameWithMode(…, 1)`; bila desa menang, tiap pemain desa mendapat `scamShieldBonus` credits tambahan (default 5) dari kontrak, tampil di DM reward dan riwayat pemain. NoxGame lama (sebelum nox-contracts#17) tidak punya mode: game tetap jalan sebagai game biasa dan log `game_mode_unsupported`.

## Pancingan diskusi

Saat diskusi sepi, Game Master melempar satu pertanyaan terbuka di tengah waktu diskusi (tanpa menyebut atau mengarah ke siapa pun; guard tetap berlaku, template sebagai cadangan). `NOX_DISCUSSION_NUDGE=quiet` (default) hanya bekerja bila bot bisa membaca pesan grup (BotFather → Group Privacy → Disable): pancingan muncul bila pesan masih lebih sedikit dari jumlah pemain hidup. `always` = sekali tiap diskusi, `off` = mati. Pesan grup hanya dihitung, tidak disimpan atau dibaca lebih jauh.

## Uji di testnet

`npm run sim:game` memainkan satu game 5 pemain lewat GameRoom + ViemLedger asli di chain `.env` (tanpa Telegram) dan mencetak status on-chain, credits per pemain, dan gas per langkah. `npm run sim:game -- --scamshield` memainkan mode Scam Shield; bila grup menang, lencana Scam Spotter diberikan di NoxBadges (`NOX_BADGES_ADDRESS`) dan jumlahnya per pemain dicetak.

## Konten berversi

Tema dan skenario punya `version`; hash isinya (teks, termasuk hasil render kalimat skenario) tercatat di `bot/content.lock.json`. Config yang di-commit on-chain saat `createGame` menyebut Game Master (`nox`, `theme:horor@1` + hash, atau `agent:<id>` + hash persona) dan skenario (`scenario:task-scam@1` + hash), jadi tiap game bisa ditelusuri ke konten persisnya. Mengubah teks tanpa menaikkan versi membuat tes gagal; setelah menaikkan versi jalankan `npm run content:lock`.
