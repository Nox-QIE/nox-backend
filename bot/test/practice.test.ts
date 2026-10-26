import { describe, expect, it } from "vitest";
import { checkNarration } from "../src/gm/guard.js";
import { Practice, PRACTICE, practiceLink } from "../src/practice.js";
import { SqliteStore } from "../src/store.js";

describe("Scam Shield practice (F10-S06, F10-D05)", () => {
  it("walks through every item, explains each answer and ends with the card and a share link", () => {
    const store = new SqliteStore(":memory:");
    const p = new Practice({ botUsername: "nox_bot", counts: store });
    const first = p.start(7, "id");
    expect(first.text).toContain("Latihan Scam Shield");
    expect(first.text).toContain("1/6");
    expect(first.keyboard[0]!.map((b) => b.data)).toEqual(["q:0:s", "q:0:k"]);
    let last = null as ReturnType<Practice["answer"]>;
    PRACTICE.id.items.forEach((item, i) => {
      last = p.answer(7, i, item.scam ? "s" : "k");
      expect(last!.text).toContain("✅ Betul.");
      expect(last!.text).toContain(item.why);
    });
    expect(last!.keyboard).toBeUndefined();
    expect(last!.text).toContain("Skor kamu: <b>6/6</b>");
    expect(last!.text).toContain("iasc.ojk.go.id"); // the Scam Shield card with report channels
    expect(last!.text).toContain("https://t.me/nox_bot?start=latihan");
    const today = new Date().toISOString().slice(0, 10);
    expect(store.practiceStats(today)).toEqual([{ day: today, started: 1, finished: 1 }]);
    expect(store.startedUsers()).toEqual([]); // no account, no Telegram id kept
  });

  it("counts a wrong answer, and has at least one safe message so it is not always 'scam'", () => {
    const p = new Practice({ botUsername: "nox_bot" });
    const safe = PRACTICE.en.items.findIndex((x) => !x.scam);
    expect(safe).toBeGreaterThanOrEqual(0);
    p.start(1, "en");
    for (let i = 0; i < safe; i++) p.answer(1, i, "s");
    expect(p.answer(1, safe, "s")!.text).toContain("❌ Not quite.");
  });

  it("ignores old buttons, other users and expired quizzes", () => {
    let now = 0;
    const p = new Practice({ botUsername: "nox_bot", now: () => now });
    p.start(1, "en");
    expect(p.answer(1, 0, "s")).not.toBeNull();
    expect(p.answer(1, 0, "s")).toBeNull(); // item 0 again
    expect(p.answer(2, 0, "s")).toBeNull(); // never started
    now += 31 * 60_000;
    expect(p.answer(1, 1, "s")).toBeNull(); // expired
  });

  it("its own messages hold no links or markup a guard would flag, apart from the share link", () => {
    for (const lang of ["id", "en"] as const) {
      for (const item of PRACTICE[lang].items) {
        for (const text of [item.text, item.why]) expect(/https?:|<a |@\w/.test(text), text).toBe(false);
      }
    }
    expect(practiceLink("nox_bot", "en")).toBe("https://t.me/nox_bot?start=practice");
    // The narration guard would refuse these lines: they are fixed teaching content, never model output.
    expect(checkNarration(PRACTICE.id.items[5]!.text, []).ok).toBe(false);
  });
});
