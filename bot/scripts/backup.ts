/**
 * Consistent snapshot of the bot store (L1-16): VACUUM INTO a timestamped file, keep the newest N.
 * The store holds what only Nox knows (accounts, encrypted game and endpoint secrets, tx ledger);
 * the event index is rebuilt from the chain and needs no backup.
 *   npm run backup        (NOX_BACKUP_DIR, default data/backups; NOX_BACKUP_KEEP, default 14)
 */
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function backup(dbPath: string, dir: string, keep: number, now = new Date()): { file: string; removed: string[] } {
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const file = join(dir, `nox-${stamp}.db`);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.prepare("VACUUM INTO ?").run(file);
  } finally {
    db.close();
  }
  const snapshots = readdirSync(dir).filter((f) => /^nox-\d{8}-\d{6}\.db$/.test(f)).sort();
  const removed = snapshots.slice(0, Math.max(0, snapshots.length - keep));
  for (const f of removed) rmSync(join(dir, f));
  return { file, removed };
}

if (process.argv[1]?.endsWith("backup.ts")) {
  const keep = Number(process.env.NOX_BACKUP_KEEP || 14);
  if (!Number.isInteger(keep) || keep < 1) throw new Error("NOX_BACKUP_KEEP must be a whole number ≥ 1");
  const r = backup(process.env.NOX_DB_PATH || "data/nox.db", process.env.NOX_BACKUP_DIR || "data/backups", keep);
  console.log(`backup written: ${r.file}${r.removed.length ? ` (removed ${r.removed.length} old snapshot(s))` : ""}`);
}
