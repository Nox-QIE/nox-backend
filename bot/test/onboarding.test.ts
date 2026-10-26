import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import type { Abi } from "viem";
import { describe, expect, it } from "vitest";
import { createApi } from "../src/api.js";
import { NoxCreditsAbi, NoxGameAbi } from "../src/chain/contracts.js";
import { EventIndexer, EventStore } from "../src/chain/indexer.js";
import type { GameLedger } from "../src/chain/ledger.js";
import { noLedger } from "../src/chain/ledger.js";
import { TemplateNarrator } from "../src/narrator.js";
import { Registry } from "../src/registry.js";
import { SqliteStore } from "../src/store.js";
import { startReply, statsFromApi } from "../src/telegram.js";
import { ben, CREDITS, FakeChain, GAME, playGame } from "./chain-fakes.js";
import { FakeMessenger, FakeScheduler, tempDbPath } from "./fakes.js";

const ledger: GameLedger = { ...noLedger, enabled: true, addressOf: (u) => `0x${u.toString(16).padStart(40, "0")}` as `0x${string}` };

function setup() {
  const store = new SqliteStore(":memory:");
  const registry = new Registry({
    messenger: new FakeMessenger(),
    scheduler: new FakeScheduler(),
    timings: { lobbyMs: 1000, nightMs: 1000, discussionMs: 1000, voteMs: 1000 },
    randomInt: () => 0,
    botUsername: "nox_test_bot",
    narratorFor: (lang) => new TemplateNarrator(lang),
    store,
  });
  return { store, registry };
}

describe("onboarding (F01-S01, F01-D01, F01-S06, F01-S09)", () => {
  it("creates the account on the first Start and greets returning players without duplicating", async () => {
    const { store, registry } = setup();
    const first = await startReply({ registry, store, ledger, userId: 42, lang: "id" });
    expect(first).toContain("Selamat datang di <b>Nox</b>");
    expect(store.getUser(42)).toMatchObject({ telegramId: 42, locale: "id", address: ledger.addressOf(42), status: "active" });
    expect(registry.startedUsers.has(42)).toBe(true);

    const again = await startReply({ registry, store, ledger, userId: 42, lang: "en" }); // switched app language
    expect(again).toContain("Welcome back to <b>Nox</b>");
    expect(store.getUser(42)!.locale).toBe("en");
    expect(store.startedUsers()).toEqual([42]);
  });

  it("shows a returning player's stats, and still greets when the API is down", async () => {
    const { store, registry } = setup();
    await startReply({ registry, store, ledger, userId: 7, lang: "id" });
    const withStats = await startReply({ registry, store, ledger, userId: 7, lang: "id", statsFor: async () => ({ credits: 185, games: 5, wins: 5, streakDays: 3, rank: 1 }) });
    expect(withStats).toContain("5 game, 5 menang, <b>185 Nox Credits</b>, peringkat #1");
    expect(withStats).toContain("Streak 3 hari");
    const down = await startReply({ registry, store, ledger, userId: 7, lang: "en", statsFor: async () => { throw new Error("ECONNREFUSED"); } });
    expect(down).toBe("Welcome back to <b>Nox</b> 🌙\nType /newgame in a group to play.");
  });

  it("one wallet per account, and /forget starts over", async () => {
    const { store, registry } = setup();
    store.upsertUser(1, { locale: "en", address: "0xabc" });
    expect(() => store.upsertUser(2, { locale: "en", address: "0xabc" })).toThrow();
    await startReply({ registry, store, ledger, userId: 9, lang: "en" });
    expect(registry.forgetUser(9)).toBe(true);
    expect(store.getUser(9)).toBeNull();
    expect(await startReply({ registry, store, ledger, userId: 9, lang: "en" })).toContain("Welcome to <b>Nox</b>");
  });

  it("works without a chain (no address) and upgrades old databases", async () => {
    const path = tempDbPath("users");
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE users (telegram_id INTEGER PRIMARY KEY, started_at INTEGER NOT NULL)");
    old.prepare("INSERT INTO users VALUES (5, 1)").run();
    old.close();
    const store = new SqliteStore(path);
    expect(store.getUser(5)).toMatchObject({ telegramId: 5, locale: null, address: null, startedAt: 1 });
    const registry = new Registry({
      messenger: new FakeMessenger(),
      scheduler: new FakeScheduler(),
      timings: { lobbyMs: 1000, nightMs: 1000, discussionMs: 1000, voteMs: 1000 },
      randomInt: () => 0,
      botUsername: "b",
      narratorFor: (lang) => new TemplateNarrator(lang),
      store,
    });
    expect(await startReply({ registry, store, ledger: noLedger, userId: 5, lang: "id" })).toContain("Selamat datang kembali");
    expect(store.getUser(5)!.locale).toBe("id");
  });

  it("reads stats from the real indexer API", async () => {
    const chain = new FakeChain();
    const index = new EventStore(":memory:");
    playGame(chain, 200n);
    chain.head = 300n;
    await new EventIndexer({ client: chain, store: index, contracts: [{ name: "NoxGame", address: GAME, abi: NoxGameAbi as Abi }, { name: "NoxCredits", address: CREDITS, abi: NoxCreditsAbi as Abi }], fromBlock: 100n, confirmations: 0n }).syncOnce();
    const server = createApi({ store: index, network: "testnet", chainId: 1983 });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const stats = await statsFromApi(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)(ben);
      expect(stats).toMatchObject({ credits: 30, games: 1, wins: 1, rank: 1 });
      expect(await statsFromApi(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)("0x00000000000000000000000000000000000000ff")).toBeNull();
    } finally {
      server.close();
    }
  });
});
