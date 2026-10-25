# @nox/bot

Telegram bot Nox (M1, tanpa blockchain). Bot biasa — **tanpa Mini App / Web App button** (lihat Telegram Blockchain Guidelines).

## Jalankan

1. Buat bot di [@BotFather](https://t.me/BotFather), salin token-nya.
2. Salin `.env.example` di root jadi `.env`, isi `BOT_TOKEN`.
3. Dari root repo:

```bash
npm install
node --env-file=.env --import tsx bot/src/main.ts
```

Untuk main cepat saat dev, isi `LOBBY_SECONDS=30 NIGHT_SECONDS=20 DISCUSSION_SECONDS=20 VOTE_SECONDS=20`.

## Alur

- Tiap pemain tekan **Start** di DM bot dulu (Telegram tidak mengizinkan bot DM duluan).
- Di grup: `/newgame` → tombol **Join** / **Start** (host). Min 5, max 12 pemain. Lobby auto-start/cancel saat timer habis.
- Peran dikirim lewat DM. Werewolf saling tahu, dan pesan DM mereka saat malam diteruskan ke sesama werewolf.
- Malam: werewolf, seer, doctor pilih target lewat tombol DM. Resolve lebih cepat kalau semua sudah aksi.
- Siang: diskusi → voting tombol di grup. Resolve lebih cepat kalau semua yang hidup sudah vote.
- Akhir: Narrator umumkan pemenang + semua peran.

Callback data: `j:<room>`, `s:<room>`, `n:<room>:<round>:<target>`, `v:<room>:<round>:<target>`. Round di tombol membuat tombol lama otomatis basi.

## Struktur

| File | Isi |
|---|---|
| `src/room.ts` | `GameRoom`: lobby → malam → siang → selesai, semua mutasi lewat antrean |
| `src/registry.ts` | Room per grup, satu game aktif per user, daftar user yang sudah Start |
| `src/telegram.ts` | Wiring grammY + implementasi `Messenger` |
| `src/narrator.ts` | Interface `Narrator` + `TemplateNarrator` (fallback untuk AI Game Master) |
| `src/gm/` | AI Game Master (F09): `LlmNarrator`, prompt, guard, model Claude (Anthropic SDK; Claude API atau gateway Oxion) |
| `src/ports.ts` | `Messenger`, `Scheduler`, `Timings` — supaya room bisa dites tanpa Telegram |
| `src/i18n.ts` | Teks `id` / `en` (dipilih dari `language_code` host) |

Aturan game sepenuhnya dari [`@nox/shared/engine`](https://github.com/Nox-QIE/nox-shared); `room.log` (assignment + command) bisa di-`replay` untuk audit — ini yang nanti di-commit ke chain.

## AI Game Master (F09)

Default `NOX_GM=template` (tanpa jaringan). Set `NOX_GM=llm` untuk narasi Claude:

| Provider | Env |
|---|---|
| Claude API | `NOX_GM_PROVIDER=anthropic`, kredensial SDK (`ANTHROPIC_API_KEY` atau `ant auth login`) |
| [Oxion AI](https://oxionai.com/docs) | `NOX_GM_PROVIDER=oxion`, `OXION_API_KEY=cc_…`, `NOX_GM_MODEL=<ID dari GET /v1/models>` |

Model default `claude-opus-5-5`. Ganti lewat `NOX_GM_MODEL` setelah ukur biaya.

**Pool model (variasi + cadangan):** `NOX_GM_MODELS=oxion:claude-opus-5.5@2,oxion:claude-sonnet-5,anthropic:claude-opus-5-5`
- Tiap game memilih satu model sesuai bobot (`@2` = 2x lebih sering), jadi gaya narasi beda antar game tapi konsisten dalam satu game.
- Kalau model terpilih gagal, anggota pool lain dicoba berurutan; model yang gagal di-skip 60 detik (cooldown). Semua gagal → template.
- `gm_usage` mencatat `model` (pilihan utama) dan `byModel` (token per model yang benar-benar melayani).
- Isi `OXION_API_KEY` bila ada entri `oxion`, dan kredensial Anthropic bila ada entri `anthropic`.

Desain anti-bocor:
- Tiap beat = 1–3 kalimat **suasana** dari LLM + kalimat **fakta** dari template. Fakta (siapa mati, peran yang terungkap, pemenang) tidak pernah bergantung pada LLM.
- LLM hanya menerima fakta publik dalam JSON `<facts>`; ia tidak pernah tahu peran pemain hidup. Nama pemain diperlakukan sebagai data (anti prompt injection).
- Guard menolak teks yang menyebut nama pemain hidup (kata utuh), link, markup, @mention, atau soal uang/dompet/deposit.
- Gagal/timeout/refusal/ditolak guard → retry sekali → template saja. Game tidak pernah macet karena narasi.
- Di Claude API langsung: `effort: low` dan `fallbacks: "default"` (refusal dialihkan server-side). Di Oxion: request Messages polos.
- Akhir game mencetak baris JSON `gm_usage` (token, gagal, fallback, `costUsd`).

Ukur biaya per game (memakai token sungguhan):

```bash
node --env-file=.env --import tsx bot/scripts/gm-sample.ts
```

## Tes

```bash
npm test
```

Tes memakai `FakeMessenger` + `FakeScheduler` + `FakeModel`, termasuk satu game penuh 5 pemain sampai menang, replay log, guard, fallback, dan server HTTP lokal yang meniru Oxion.

## Belum (M1)

State masih di memori (restart = game hilang, user perlu `/start` ulang). Postgres/Redis dan commit-reveal on-chain menyusul. GM belum membaca chat grup (pancingan diskusi F07-S02) dan belum punya tema (F09-S08).
