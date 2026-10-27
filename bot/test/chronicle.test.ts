import { describe, expect, it } from "vitest";
import { chronicleFacts, chronicleSummary, dueRecaps, isoWeekOf, weeklyRecap, type ChronicleRow } from "../src/chronicle.js";
import { TemplateNarrator } from "../src/narrator.js";
import { Registry } from "../src/registry.js";
import { SqliteStore } from "../src/store.js";
import { FakeMessenger, FakeScheduler } from "./fakes.js";

const day = (d: string) => Date.parse(`${d}T12:00:00Z`);
const row = (game: string, at: string, player: string, name: string, role: ChronicleRow["role"], won: boolean, extra: Partial<ChronicleRow> = {}): ChronicleRow => ({
  chatId: -1,
  gameId: game,
  endedAt: day(at),
  player,
  name,
  role,
  won,
  votedOut: false,
  killed: false,
  lang: "en",
  ...extra,
});
// Three games in week 44 of 2026: Ben the wolf twice (won once), Ava on a winning streak, Cy voted out twice.
const history: ChronicleRow[] = [
  row("g1", "2026-10-26", "0xa", "Ava", "seer", true),
  row("g1", "2026-10-26", "0xb", "Ben", "werewolf", false, { votedOut: true }),
  row("g1", "2026-10-26", "0xc", "Cy", "villager", true),
  row("g2", "2026-10-27", "0xa", "Ava", "villager", true),
  row("g2", "2026-10-27", "0xb", "Ben", "werewolf", false),
  row("g2", "2026-10-27", "0xc", "Cy", "villager", true, { votedOut: true }),
  row("g3", "2026-10-28", "0xa", "Ava", "doctor", true),
  row("g3", "2026-10-28", "0xb", "Ben", "villager", true),
  row("g3", "2026-10-28", "0xc", "Cy", "werewolf", false, { votedOut: true }),
];

describe("Chronicle (10.07 #2)", () => {
  it("opens a game with the group's history about the players at the table", () => {
    const f = chronicleFacts(history, ["0xa", "0xb", "0xc"], "en");
    expect(f[0]).toBe("This is the group's game number 4.");
    expect(f).toContain("<b>Ava</b> has won 3 games in a row. Can anyone stop them?");
    expect(f).toHaveLength(3);
    expect(chronicleFacts([], ["0xa"], "en")).toEqual([]);
    expect(chronicleFacts(history, ["0xnew"], "id")).toEqual(["Ini game ke-4 grup ini."]);
  });

  it("summarises the group and recaps a week once", () => {
    const s = chronicleSummary(history, "en");
    expect(s).toContain("3 games so far");
    expect(s).toContain("1. Ava: 3 wins in 3 games");
    expect(weeklyRecap(history, isoWeekOf(day("2026-10-27")), "en")).toContain("🏆 MVP: <b>Ava</b> (3 wins)");
    expect(weeklyRecap(history, "2026-W40", "en")).toBeNull();
    const store = new SqliteStore(":memory:");
    store.recordChronicle(history);
    const monday = Date.parse("2026-11-02T09:00:00Z");
    expect(dueRecaps(store, monday - 86_400_000)).toEqual([]); // Sunday: nothing yet
    const due = dueRecaps(store, monday);
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ chatId: -1 });
    expect(due[0]!.text).toContain("Week 2026-W44 recap");
    expect(dueRecaps(store, monday + 3600_000)).toEqual([]); // once per week
  });

  it("records each finished game, opens the next one with the history, and /forget removes a player", async () => {
    const store = new SqliteStore(":memory:");
    const messenger = new FakeMessenger();
    const scheduler = new FakeScheduler();
    const registry = new Registry({
      messenger,
      scheduler,
      timings: { lobbyMs: 1000, nightMs: 1000, discussionMs: 1000, voteMs: 1000 },
      randomInt: () => 0,
      botUsername: "b",
      narratorFor: (lang) => new TemplateNarrator(lang),
      store,
    });
    const users = [11, 22, 33, 44, 55];
    for (const u of users) registry.markStarted(u);
    const play = async () => {
      await registry.create(-7, 11, "Ava", "en");
      const room = registry.roomOfChat(-7)!;
      for (const u of users.slice(1)) await registry.join(room.id, u, `P${u}`);
      await room.start(11);
      const role = (r: string) => users.filter((u) => room.roleOf(u) === r);
      const wolf = role("werewolf")[0]!;
      await room.nightAction(wolf, 1, String(role("villager")[0]));
      await room.nightAction(role("seer")[0]!, 1, String(wolf));
      await room.nightAction(role("doctor")[0]!, 1, String(role("doctor")[0]));
      await scheduler.advance(1000);
      const alive = users.filter((u) => room.isAlive(u));
      for (const u of alive) await room.vote(u, 1, String(u === wolf ? alive.find((x) => x !== wolf) : wolf));
      expect(room.status).toBe("ended");
      return wolf;
    };
    const wolf = await play();
    expect(messenger.group().some((h) => h.includes("Chronicle"))).toBe(false); // a new group has no history
    expect(store.chronicleOf(-7)).toHaveLength(5);
    expect(store.chronicleOf(-7).find((r) => r.player === `local:${wolf}`)).toMatchObject({ role: "werewolf", won: false, votedOut: true });
    await play();
    expect(messenger.group().find((h) => h.includes("📜 <b>Chronicle</b>"))).toContain("This is the group's game number 2.");
    store.forgetUser(22);
    expect(store.chronicleOf(-7).some((r) => r.player === "local:22")).toBe(false);
  });
});
