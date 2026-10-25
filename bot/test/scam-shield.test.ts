import { describe, expect, it } from "vitest";
import { checkPersona } from "../src/agents.js";
import { TemplateNarrator } from "../src/narrator.js";
import { Registry } from "../src/registry.js";
import { scenarioFrom, TASK_SCAM } from "../src/scenarios.js";
import { THEME_AGENTS } from "../src/themes.js";
import { FakeMessenger, FakeScheduler } from "./fakes.js";

describe("Scam Shield content", () => {
  it("is complete in both languages and points to verified report channels", () => {
    for (const lang of ["id", "en"] as const) {
      const t = TASK_SCAM.text[lang];
      expect(t.hints.length).toBeGreaterThanOrEqual(7);
      expect(checkPersona(t.persona)).toEqual([]);
      expect(t.debrief).toContain("iasc.ojk.go.id");
      expect(Object.keys(t.roles).sort()).toEqual(["doctor", "seer", "villager", "werewolf"]);
    }
    expect(TASK_SCAM.text.id.debrief).toContain("cekrekening.id");
  });

  it("is started by its keywords only", () => {
    expect(scenarioFrom("scamshield")?.key).toBe("task-scam");
    expect(scenarioFrom("antipenipuan")?.key).toBe("task-scam");
    expect(scenarioFrom("horor")).toBeNull();
  });
});

describe("a Scam Shield game", () => {
  it("re-skins roles and facts, posts a warning sign each morning, ends with a debrief and Scam Spotter badges", async () => {
    const messenger = new FakeMessenger();
    const scheduler = new FakeScheduler();
    const registry = new Registry({
      messenger,
      scheduler,
      timings: { lobbyMs: 1000, nightMs: 1000, discussionMs: 1000, voteMs: 1000 },
      randomInt: () => 0,
      botUsername: "nox_test_bot",
      narratorFor: (lang, _persona, wording) => new TemplateNarrator(lang, wording),
      agents: () => THEME_AGENTS,
    });
    const users = [11, 22, 33, 44, 55];
    users.forEach((u) => registry.markStarted(u));
    await registry.create(-1, 11, "Ava", "id", { scenario: TASK_SCAM });
    const room = registry.roomOfChat(-1)!;
    expect(messenger.sent[0]!.html).toContain("Scam Shield: Misi Berbayar");
    expect(messenger.sent[0]!.keyboard).toHaveLength(1); // no Game Master picker

    for (const u of users.slice(1)) await registry.join(room.id, u, `P${u}`);
    await room.start(11);
    const role = (r: string) => users.filter((u) => room.roleOf(u) === r);
    const wolf = role("werewolf")[0]!;
    expect(messenger.dms(wolf)[0]!.html).toContain("Penipu");
    expect(messenger.group().some((h) => h.includes("Cuan Harian"))).toBe(true);

    // Night 1: the scammer gets a target; the others act too so the night ends.
    const target = role("villager")[0]!;
    await room.nightAction(wolf, 1, String(target));
    await room.nightAction(role("seer")[0]!, 1, String(wolf));
    await room.nightAction(role("doctor")[0]!, 1, String(role("doctor")[0]!));
    expect(messenger.group().some((h) => h.includes("kena tipu semalam"))).toBe(true);
    expect(messenger.group().some((h) => h.startsWith("🚩 Tanda bahaya: tawaran kerja"))).toBe(true);

    await scheduler.advance(1000); // discussion → vote
    for (const u of users.filter((u) => room.isAlive(u))) await room.vote(u, 1, String(wolf));
    expect(room.status).toBe("ended");
    const group = messenger.group();
    expect(group.some((h) => h.includes("Pemenang: <b>Grup yang waspada</b>"))).toBe(true);
    expect(group.at(-1)).toContain("Kartu Scam Shield");
    for (const u of users.filter((u) => u !== wolf)) expect(messenger.dms(u).at(-1)!.html).toContain("Scam Spotter");
    expect(messenger.dms(wolf).some((d) => d.html.includes("Scam Spotter"))).toBe(false);
  });
});
