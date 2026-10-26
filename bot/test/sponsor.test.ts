import { describe, expect, it } from "vitest";
import { buildSponsorReport, sponsorMarkdown } from "../src/sponsor.js";
import type { ScenarioGame } from "../src/store.js";

const game = (chatId: number, players: number, winner: string, scenario = "task-scam@1"): ScenarioGame => ({ scenario, players, chatId, winner, endedAt: 0 });

describe("Scam Shield sponsor report (F10-S07, F10-D04)", () => {
  it("counts games, seats, groups, spotted scams, badges and practice", () => {
    const r = buildSponsorReport({
      sponsor: "Bank Contoh",
      from: "2026-11-01",
      to: "2026-11-30",
      games: [game(-1, 5, "village"), game(-1, 6, "wolves"), game(-2, 7, "village"), game(-3, 5, "village", "task-scam@2")],
      practice: [
        { started: 10, finished: 7 },
        { started: 4, finished: 4 },
      ],
      badges: 12,
    });
    expect(r).toMatchObject({ games: 4, seats: 23, groups: 3, spotted: 3, spottedRate: 75, badges: 12, badgesAvailable: true, practice: { started: 14, finished: 11, completion: 79 } });
    expect(r.byScenario).toEqual([
      { scenario: "task-scam@1", games: 3, seats: 18, spotted: 2 },
      { scenario: "task-scam@2", games: 1, seats: 5, spotted: 1 },
    ]);
  });

  it("hides counts of 1–2, says when badges could not be counted, and prints no identifiers", () => {
    const r = buildSponsorReport({ sponsor: "Kantor", from: "2026-11-01", to: "2026-11-30", games: [game(-100123, 5, "village"), game(-100123, 5, "wolves")], practice: [] });
    expect(r).toMatchObject({ groups: null, seats: 10, badges: null, badgesAvailable: false, practice: { completion: null } });
    for (const lang of ["id", "en"] as const) {
      const md = sponsorMarkdown(r, lang);
      expect(md).toContain(lang === "id" ? "Didukung oleh Kantor" : "Supported by Kantor");
      expect(md).toContain(lang === "id" ? "| Grup Telegram yang bermain | <3 |" : "| Telegram groups that played | <3 |");
      expect(md).toContain(lang === "id" ? "belum tersedia" : "not available");
      expect(md).not.toContain("100123");
    }
    expect(JSON.stringify(r)).not.toContain("100123");
  });
});
