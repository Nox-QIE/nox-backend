import { describe, expect, it } from "vitest";
import { answerNightWatch, puzzleMessage, puzzleOf, startNightWatch } from "../src/nightwatch.js";
import { SqliteStore } from "../src/store.js";

const at = (day: string) => Date.parse(`${day}T08:00:00Z`);

describe("Daily Night Watch (10.07 #7)", () => {
  it("builds the same puzzle for a day, and every day has exactly one suspect fitting all clues", () => {
    expect(puzzleOf("2026-10-27")).toEqual(puzzleOf("2026-10-27"));
    for (let i = 0; i < 365; i++) {
      const day = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
      const p = puzzleOf(day);
      expect(new Set(p.suspects.map((s) => s.name)).size).toBe(4);
      expect(new Set(p.suspects.map((s) => s.place)).size).toBe(4);
      const fits = p.suspects.filter((s) =>
        p.clues.every((c) => (c.kind === "notAt" ? s.place !== c.place : c.kind === "carried" ? s.item === c.item : s.mud === c.mud)),
      );
      expect(fits).toEqual([p.suspects[p.answer]]);
    }
  });

  it("shows the suspects, three clues and one button each", () => {
    const m = puzzleMessage(puzzleOf("2026-10-27"), "en");
    expect(m.text).toContain("Night Watch");
    expect(m.text.match(/^\d\. /gm)).toHaveLength(3);
    expect(m.keyboard[0]!.map((b) => b.data)).toEqual(["w:2026-10-27:0", "w:2026-10-27:1", "w:2026-10-27:2", "w:2026-10-27:3"]);
  });

  it("takes one answer per day, counts a streak of right days, and resets on a wrong one", () => {
    const store = new SqliteStore(":memory:");
    const right = (day: string) => puzzleOf(day).answer;
    expect(answerNightWatch(store, 7, "2026-10-25", right("2026-10-25"), "en", at("2026-10-25"))).toContain("1 day");
    expect(answerNightWatch(store, 7, "2026-10-26", right("2026-10-26"), "en", at("2026-10-26"))).toContain("2 days");
    expect(answerNightWatch(store, 7, "2026-10-26", 0, "en", at("2026-10-26"))).toContain("already answered");
    expect(startNightWatch(store, 7, "en", at("2026-10-26")).text).toContain("already answered");
    expect(answerNightWatch(store, 7, "2026-10-26", 0, "en", at("2026-10-27"))).toContain("That puzzle is over");
    const wrong = (right("2026-10-27") + 1) % 4;
    expect(answerNightWatch(store, 7, "2026-10-27", wrong, "id", at("2026-10-27"))).toContain(`Werewolf-nya <b>${puzzleOf("2026-10-27").suspects[right("2026-10-27")]!.name}</b>`);
    expect(store.nightWatchStreak(7, "2026-10-27")).toBe(0);
    store.forgetUser(7);
    expect(store.nightWatchAnswer(7, "2026-10-25")).toBeNull();
  });
});
