import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { backup } from "../scripts/backup.js";
import { SqliteStore } from "../src/store.js";

describe("bot store backup (L1-16)", () => {
  it("writes a readable snapshot and keeps only the newest N", () => {
    const dir = mkdtempSync(join(tmpdir(), "nox-backup-"));
    const dbPath = join(dir, "nox.db");
    const store = new SqliteStore(dbPath);
    store.upsertUser(42, { locale: "id", address: "0x00000000000000000000000000000000000000aa" });
    const out = join(dir, "backups");
    const files: string[] = [];
    for (let i = 0; i < 4; i++) files.push(backup(dbPath, out, 3, new Date(Date.UTC(2026, 9, 26, 1, 0, i))).file);
    expect(readdirSync(out).sort()).toEqual(files.slice(1).map((f) => f.split("/").pop()!).sort());
    expect(existsSync(files[0]!)).toBe(false);
    // The snapshot is a working store with the same data.
    expect(new SqliteStore(files[3]!).getUser(42)).toMatchObject({ locale: "id", address: "0x00000000000000000000000000000000000000aa" });
    store.close();
  });
});
