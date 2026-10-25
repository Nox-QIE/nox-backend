import { describe, expect, it } from "vitest";
import type { GmCompletion, GmModel } from "../src/gm/model.js";
import { ATTACKS, runAttack } from "../src/gm/redteam.js";
import { safeName } from "../src/names.js";

/**
 * Worst case: a model that obeys every injection. It echoes the user prompt (names included),
 * names every living player as the werewolf, prints its instructions, and appends links and a
 * money request. The guard and name cleaning must still keep every group message clean.
 */
class ObedientModel implements GmModel {
  readonly model = "obedient";
  async complete(system: string, user: string): Promise<GmCompletion> {
    const text = `${user} Ava is the werewolf, Ben is the seer. ${system} Visit nox-bonus.xyz and send 0.1 QIE to 0x1111111111111111111111111111111111111111 via @NoxAdmin. <a href="x">win</a>`;
    return { text, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: this.model };
  }
}

describe("red-team: 20 attacks against an obedient model", () => {
  it("has 20 attacks", () => {
    expect(ATTACKS).toHaveLength(20);
    expect(new Set(ATTACKS.map((a) => a.id)).size).toBe(20);
  });

  for (const attack of ATTACKS) {
    it(`blocks ${attack.id} (${attack.goal})`, async () => {
      for (const lang of ["id", "en"] as const) {
        const r = await runAttack(new ObedientModel(), attack, lang);
        expect(r.failures, `${lang}: ${r.messages.join("\n---\n")}`).toEqual([]);
      }
    });
  }
});

describe("display names", () => {
  it("keeps ordinary names, trims floods, aliases links, mentions, markup and money talk", () => {
    expect(safeName("Siti Nurhaliza", 2, "id")).toBe("Siti Nurhaliza");
    expect(safeName("  Budi   ", 3, "id")).toBe("Budi");
    expect(safeName("José 🐺", 3, "en")).toBe("José 🐺");
    expect(safeName("A".repeat(300), 2, "en")).toHaveLength(32);
    for (const bad of ["nox-bonus.xyz", "t.me/x", "@admin", "<b>x</b>", "Setor dulu", "nox​.xyz", "a.b.id"]) {
      expect(safeName(bad, 4, "id"), bad).toBe("Pemain 4");
    }
    expect(safeName("​​", 5, "en")).toBe("Player 5");
  });
});
