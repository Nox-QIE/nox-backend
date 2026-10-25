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
| `src/narrator.ts` | Interface `Narrator` + `TemplateNarrator` (fallback untuk AI Game Master F09) |
| `src/ports.ts` | `Messenger`, `Scheduler`, `Timings` — supaya room bisa dites tanpa Telegram |
| `src/i18n.ts` | Teks `id` / `en` (dipilih dari `language_code` host) |

Aturan game sepenuhnya dari [`@nox/shared/engine`](https://github.com/Nox-QIE/nox-shared); `room.log` (assignment + command) bisa di-`replay` untuk audit — ini yang nanti di-commit ke chain.

## Tes

```bash
npm test
```

Tes memakai `FakeMessenger` + `FakeScheduler`, termasuk satu game penuh 5 pemain sampai menang dan replay log.

## Belum (M1)

State masih di memori (restart = game hilang, user perlu `/start` ulang). Postgres/Redis, AI Game Master (LLM), dan commit-reveal on-chain menyusul.
