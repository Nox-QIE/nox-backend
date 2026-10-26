# backend/db

Desain awal memakai Postgres untuk data store D1–D16. MVP menyimpannya di SQLite (`node:sqlite`): store bot `data/nox.db` dan indeks event `data/index.db`, kolom baru ditambahkan saat dibuka (tanpa file migrasi terpisah). Peta lengkap store, field, proteksi, dan retensi: [docs/data-model.md](../docs/data-model.md).
