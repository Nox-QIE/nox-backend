import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { recoverGames } from "../src/recovery.js";
import { noLedger, type GameLedger } from "../src/chain/ledger.js";
import { SqliteStore } from "../src/store.js";
import { alertDispute } from "../src/telegram.js";
import { FakeMessenger } from "./fakes.js";

const gameId = ("0x" + "ab".repeat(32)) as Hex;
const secret = { roles: [], nights: [] };
const newStore = () => new SqliteStore(":memory:", Buffer.alloc(32, 7));

describe("disputed games (F08-S03)", () => {
  it("tells the group in its language and DMs the operator", async () => {
    const store = newStore();
    store.saveGame(gameId, -100, "id", secret);
    const messenger = new FakeMessenger();
    await alertDispute({ messenger, store, gameId, reason: "reveal_mismatch", detail: "BadReveal", webUrl: "https://nox.example/", operatorChatId: 42 });
    expect(messenger.group()[0]).toContain("sengketa");
    expect(messenger.group()[0]).toContain(`https://nox.example/game/?id=${gameId}`);
    const dm = messenger.dms(42)[0]!.html;
    expect(dm).toContain("game disputed");
    expect(dm).toContain(gameId);
    expect(dm).toContain("reveal_mismatch (BadReveal)");
  });

  it("still alerts the operator when the game is not in the store", async () => {
    const messenger = new FakeMessenger();
    await alertDispute({ messenger, store: newStore(), gameId, reason: "reveal_timeout", detail: "x", operatorChatId: 42 });
    expect(messenger.group()).toEqual([]);
    expect(messenger.dms(42)).toHaveLength(1);
  });

  it("keeps a disputed game's secrets as evidence when settled games are purged", () => {
    const store = newStore();
    store.saveGame(gameId, -100, "en", secret);
    store.setStatus(gameId, "disputed");
    expect(store.purgeSettledSecrets(Date.now() + 1)).toBe(0);
    expect(store.gameInfo(gameId)).toEqual({ chatId: -100, lang: "en", status: "disputed" });
  });

  it("on boot, marks a game found Disputed on-chain instead of cancelling it", async () => {
    const store = newStore();
    store.saveGame(gameId, -100, "en", secret);
    const calls: string[] = [];
    const ledger: GameLedger = { ...noLedger, enabled: true, statusOf: async () => 5, cancel: () => void calls.push("cancel"), finalize: () => void calls.push("finalize") };
    const logs: Record<string, unknown>[] = [];
    await recoverGames(store, ledger, new FakeMessenger(), (l) => logs.push(l));
    expect(calls).toEqual([]);
    expect(store.gameInfo(gameId)?.status).toBe("disputed");
    expect(logs).toContainEqual(expect.objectContaining({ event: "game_disputed", reason: "reveal_timeout" }));
  });
});
