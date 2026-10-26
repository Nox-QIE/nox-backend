# backend/worker

Wallet & signer, gas drip, dan antrean tx per alamat ada di `bot/src/chain/` (ViemLedger, PlayerWallets). Indexer event `eth_getLogs` (maks 10.000 blok) ada di `bot/src/chain/indexer.ts`, dijalankan sebagai layanan terpisah dengan `npm run indexer`. Fitur: F11, F12.
