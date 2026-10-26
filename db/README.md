# backend/db

The design planned Postgres for data stores D1–D16. The MVP keeps them in SQLite (`node:sqlite`): the bot store `data/nox.db` and the event index `data/index.db`, with columns added on open (no separate migration files). The full map of stores, fields, protection and retention is in [docs/data-model.md](../docs/data-model.md).
