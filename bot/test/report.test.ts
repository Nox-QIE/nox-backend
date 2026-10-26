import { DatabaseSync } from "node:sqlite";
import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import { TemplateNarrator } from "../src/narrator.js";
import { Registry } from "../src/registry.js";
import { buildReport, isoWeek, reportMarkdown, type ReportGame } from "../src/report.js";
import { SqliteStore } from "../src/store.js";
import { FakeMessenger, FakeScheduler, tempDbPath } from "./fakes.js";

const ts = (iso: string) => Date.parse(iso) / 1000;
const w = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const game = (i: number, endIso: string, players: number[]): ReportGame => ({
  gameId: `0x${i.toString(16).padStart(64, "0")}` as Hex,
  players: players.map(w),
  createdTs: ts(endIso) - 600,
  endedTs: ts(endIso),
  rounds: 2,
  credits: 30 * players.length,
});

describe("engagement report (F04-S07, F04-D02, F04-D05)", () => {
  it("uses ISO weeks, also across year ends", () => {
    expect(isoWeek(ts("2026-10-26T00:00:00Z"))).toBe("2026-W44"); // a Monday
    expect(isoWeek(ts("2026-11-01T23:59:00Z"))).toBe("2026-W44"); // its Sunday
    expect(isoWeek(ts("2027-01-01T12:00:00Z"))).toBe("2026-W53");
    expect(isoWeek(ts("2024-12-30T12:00:00Z"))).toBe("2025-W01");
  });

  it("counts games, seats, unique players, weekly activity and retention", () => {
    const r = buildReport({
      group: "Komunitas QIE",
      from: "2026-10-01",
      to: "2026-10-31",
      games: [
        game(1, "2026-10-05T19:00:00Z", [1, 2, 3, 4, 5]), // W41
        game(2, "2026-10-07T19:00:00Z", [1, 2, 3, 6, 7]), // W41
        game(3, "2026-10-13T19:00:00Z", [1, 2, 3, 8, 9]), // W42: 1,2,3 return
        game(4, "2026-10-20T19:00:00Z", [10, 11]), // W43: only 2 players
      ],
      proofUrl: (id) => `https://nox.example/game/?id=${id}`,
    });
    expect(r).toMatchObject({ games: 4, seats: 17, uniquePlayers: 11, verifiedHumans: null, avgPlayers: 4.3, avgMinutes: 10, avgRounds: 2, credits: 510 });
    expect(r.weeks).toEqual([
      { week: "2026-W41", games: 2, active: 7, firstWeek: true, returning: null, retention: null },
      { week: "2026-W42", games: 1, active: 5, firstWeek: false, returning: 3, retention: 43 }, // 3 of 7
      { week: "2026-W43", games: 1, active: null, firstWeek: false, returning: null, retention: null }, // fewer than 3: hidden
    ]);
    expect(r.proofs).toHaveLength(4);
  });

  it("compares with the ISO week right before, even when it had no games", () => {
    const r = buildReport({
      group: "Kantor",
      from: "2026-10-01",
      to: "2026-10-31",
      games: [
        game(1, "2026-10-05T19:00:00Z", [1, 2, 3, 4, 5]), // W41
        game(2, "2026-10-19T19:00:00Z", [1, 2, 3, 4, 5]), // W43; W42 had no games
      ],
    });
    expect(r.weeks).toEqual([
      { week: "2026-W41", games: 1, active: 5, firstWeek: true, returning: null, retention: null },
      { week: "2026-W43", games: 1, active: 5, firstWeek: false, returning: 0, retention: null },
    ]);
  });

  it("never prints names, Telegram ids or wallet addresses", () => {
    const r = buildReport({ group: "Kantor", from: "2026-10-01", to: "2026-10-31", games: [game(1, "2026-10-05T19:00:00Z", [1, 2, 3, 4, 5])] });
    for (const lang of ["id", "en"] as const) {
      const md = reportMarkdown(r, lang);
      expect(md).not.toMatch(/0x0{30,}/); // no wallet addresses
      expect(md).toContain(lang === "id" ? "belum tersedia (QIE ID belum aktif)" : "not available yet (QIE ID not live)");
      expect(md).toContain('"<3"');
    }
    expect(JSON.stringify(r)).not.toMatch(/0x0{30,}[0-9a-f]{1,10}"/); // the JSON holds counts and proof links only
  });

  it("an empty month is an empty report, not an error", () => {
    const r = buildReport({ group: "X", from: "2026-10-01", to: "2026-10-31", games: [] });
    expect(r).toMatchObject({ games: 0, uniquePlayers: 0, avgPlayers: 0, weeks: [] });
  });
});

describe("store: games per group", () => {
  it("records the group of each finished game, and upgrades old databases", () => {
    const path = tempDbPath("fg");
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE finished_games (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER, players INTEGER NOT NULL, host_id INTEGER NOT NULL, chain_game_id TEXT, ended_at INTEGER NOT NULL)");
    old.close();
    const store = new SqliteStore(path);
    store.recordFinishedGame({ agentId: null, players: 5, hostId: 1, chainGameId: null, chatId: -100 });
    store.recordFinishedGame({ agentId: null, players: 6, hostId: 2, chainGameId: null, chatId: -200 });
    expect(store.finishedGamesOfChat(-100, 0, Date.now() + 1).map((g) => g.players)).toEqual([5]);
  });

  it("the room records its group when a game ends", async () => {
    const store = new SqliteStore(":memory:");
    const scheduler = new FakeScheduler();
    const registry = new Registry({
      messenger: new FakeMessenger(),
      scheduler,
      timings: { lobbyMs: 1000, nightMs: 1000, discussionMs: 1000, voteMs: 1000 },
      randomInt: () => 0,
      botUsername: "nox_test_bot",
      narratorFor: (lang) => new TemplateNarrator(lang),
      store,
    });
    const users = [11, 22, 33, 44, 55];
    for (const u of users) registry.startedUsers.add(u);
    await registry.create(-777, 11, "Ava", "en");
    const room = registry.roomOfChat(-777)!;
    for (const u of users.slice(1)) await registry.join(room.id, u, `P${u}`);
    await room.start(11);
    const role = (r: string) => users.filter((u) => room.roleOf(u) === r);
    const [wolf] = role("werewolf");
    await room.nightAction(wolf!, 1, String(role("villager")[0]));
    await room.nightAction(role("seer")[0]!, 1, String(wolf));
    await room.nightAction(role("doctor")[0]!, 1, String(role("doctor")[0]));
    await scheduler.advance(1000);
    for (const u of users.filter((u) => room.isAlive(u))) await room.vote(u, 1, String(wolf));
    expect(store.finishedGamesOfChat(-777, 0, Date.now() + 1)).toHaveLength(1);
  });
});
