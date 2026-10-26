import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStore, storeKey } from "../src/store.js";

const SECRET = "ab".repeat(32);
const SALT = `0x${"5a".repeat(32)}` as const;
const secret = { roles: [{ userId: 1, role: 2, salt: SALT, proof: [] }], nights: [] };
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "nox-store-"));
  dirs.push(d);
  return join(d, "nox.db");
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("SqliteStore", () => {
  it("keeps started users and game secrets across reopen", () => {
    const path = tmp();
    const a = new SqliteStore(path, storeKey(SECRET));
    a.addStartedUser(7);
    a.addStartedUser(7);
    a.saveGame("0x01", -100, "id", secret);
    a.close();
    const b = new SqliteStore(path, storeKey(SECRET));
    expect(b.startedUsers()).toEqual([7]);
    const [g] = b.unsettledGames();
    expect(g).toMatchObject({ gameId: "0x01", chatId: -100, lang: "id", status: "running", finalize: null });
    expect(g!.secret.roles[0]!.salt).toBe(SALT);
    b.close();
  });

  it("never writes salts in plaintext and rejects a wrong key", () => {
    const path = tmp();
    const a = new SqliteStore(path, storeKey(SECRET));
    a.saveGame("0x01", -100, "en", secret);
    a.close();
    const raw = readFileSync(path).toString("hex") + readFileSync(`${path}-wal`, { flag: "a+" }).toString("hex");
    expect(raw).not.toContain("5a".repeat(32));
    const wrong = new SqliteStore(path, storeKey("cd".repeat(32)));
    expect(() => wrong.unsettledGames()).toThrow();
    wrong.close();
  });

  it("tracks a game from running to ended to settled", () => {
    const s = new SqliteStore(":memory:", storeKey(SECRET));
    s.saveGame("0x01", -1, "en", secret);
    s.markEnded("0x01", { ...secret, resultHash: "0x02", winner: 1 });
    expect(s.unsettledGames()[0]!.finalize?.winner).toBe(1);
    s.setStatus("0x01", "finalized");
    expect(s.unsettledGames()).toEqual([]);
  });

  it("refuses to store game secrets without a key", () => {
    const s = new SqliteStore(":memory:");
    s.addStartedUser(1);
    expect(() => s.saveGame("0x01", -1, "en", secret)).toThrow("encryption key");
  });
});

describe("privacy", () => {
  it("forgets a user and unlinks them as host without losing the per-host count", () => {
    const s = new SqliteStore(":memory:");
    s.addStartedUser(42);
    s.addStartedUser(43);
    s.recordFinishedGame({ agentId: null, players: 5, hostId: 42, chainGameId: null });
    s.recordFinishedGame({ agentId: null, players: 5, hostId: 42, chainGameId: null });
    s.forgetUser(42);
    expect(s.startedUsers()).toEqual([43]);
    const games = s.finishedGames(0, Date.now() + 1);
    expect(games.map((g) => g.hostId)).toEqual([-42, -42]);
  });

  it("purges secrets of games settled before the cutoff, never unsettled ones", () => {
    const s = new SqliteStore(":memory:", storeKey(SECRET));
    s.saveGame("0x01", -1, "en", secret);
    s.saveGame("0x02", -1, "en", secret);
    s.setStatus("0x01", "finalized");
    expect(s.purgeSettledSecrets(Date.now() - 1000)).toBe(0); // settled just now: kept
    expect(s.purgeSettledSecrets(Date.now() + 1000)).toBe(1);
    expect(s.unsettledGames().map((g) => g.gameId)).toEqual(["0x02"]);
  });
});

describe("wallet audit (F01-D04, F01-D05)", () => {
  const addr = "0x" + "Ab".repeat(20);

  it("records creation once, gas drips with their reason, and /forget, by address only", () => {
    const store = new SqliteStore(":memory:");
    store.upsertUser(42, { locale: "id", address: null });
    expect(store.walletAudit(addr)).toEqual([]);
    store.upsertUser(42, { locale: "id", address: addr });
    store.upsertUser(42, { locale: "en", address: addr }); // a later /start creates nothing
    const tx = { gameId: null, step: "gas drip", from: "0x01" as `0x${string}`, to: addr as `0x${string}`, status: "success" as const, gasUsed: 21_000n, feeWei: 1n, block: 5n, attempts: 1, error: null };
    store.recordTx({ ...tx, hash: ("0x" + "e".repeat(64)) as `0x${string}`, reason: "onboarding", valueWei: 10n ** 16n });
    store.recordTx({ ...tx, step: "joinGame", from: addr as `0x${string}`, to: "0x02" as `0x${string}`, hash: null });
    store.forgetUser(42);
    const h = store.walletAudit(addr.toUpperCase().replace("0X", "0x"));
    expect(h.map((e) => e.event)).toEqual(["created", "gas", "forgotten"]);
    expect(h[1]!.detail).toBe(`onboarding 10000000000000000 wei, success 0x${"e".repeat(64)}`);
    expect(store.walletsCreated(Date.now() - 60_000, Date.now() + 1)).toEqual([{ day: new Date().toISOString().slice(0, 10), wallets: 1 }]);
  });

  it("keeps no Telegram id or key material", () => {
    const store = new SqliteStore(":memory:");
    store.upsertUser(987654321, { locale: "id", address: addr });
    const db = (store as unknown as { db: { prepare(s: string): { all(): Record<string, unknown>[] } } }).db;
    expect(db.prepare("PRAGMA table_info(wallet_audit)").all().map((c) => c.name)).toEqual(["id", "address", "event", "detail", "at"]);
    expect(JSON.stringify(db.prepare("SELECT * FROM wallet_audit").all())).not.toContain("987654321");
  });
});

describe("rupiah passes (D9, F14-D01)", () => {
  it("keeps the rupiah amount per receipt, which is not on chain", () => {
    const s = new SqliteStore(":memory:");
    const p = { receiptHash: ("0x" + "ab".repeat(32)) as `0x${string}`, holder: ("0x" + "11".repeat(20)) as `0x${string}`, passType: 1, periods: 2, amount: 150_000, currency: "IDR" as const, tx: "0x01" as `0x${string}`, at: 5 };
    s.addFiatPass(p);
    expect(s.fiatPassByReceipt(p.receiptHash.toUpperCase().replace("0X", "0x"))).toEqual(p);
    expect(() => s.addFiatPass(p)).toThrow(); // one row per receipt
    expect(s.fiatPassByReceipt("0x" + "cd".repeat(32))).toBeNull();
  });
});
