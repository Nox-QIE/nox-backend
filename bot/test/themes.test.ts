import { describe, expect, it } from "vitest";
import { AGENT_TERMS, checkPersona } from "../src/agents.js";
import { systemPrompt } from "../src/gm/prompt.js";
import { TemplateNarrator } from "../src/narrator.js";
import { Registry } from "../src/registry.js";
import { SqliteStore } from "../src/store.js";
import { THEME_AGENTS, themeIdFrom } from "../src/themes.js";
import { FakeMessenger, FakeScheduler } from "./fakes.js";

describe("Nox themes", () => {
  it("has horror, fantasy and office in both languages, each passing the persona checks", () => {
    expect(THEME_AGENTS).toHaveLength(6);
    for (const t of THEME_AGENTS) {
      expect(checkPersona(t.persona), t.persona.name).toEqual([]);
      expect(t.id).toBeLessThan(0);
      expect(systemPrompt(t.persona.langs[0]!, t.persona)).toContain(t.persona.style.slice(0, 20));
    }
  });

  it("maps /newgame words in either language to a theme", () => {
    expect(themeIdFrom("horor")).toBe(-1);
    expect(themeIdFrom(" Horror ")).toBe(-1);
    expect(themeIdFrom("fantasy")).toBe(-2);
    expect(themeIdFrom("kantor")).toBe(-3);
    expect(themeIdFrom("ranked")).toBeNull();
    expect(themeIdFrom(undefined)).toBeNull();
  });

  it("preselects a theme from /newgame, lists themes before Marketplace agents, and keeps theme games out of revenue", async () => {
    const store = new SqliteStore(":memory:");
    const agentId = store.addAgent("0x" + "11".repeat(20), { name: "Wayang", tagline: "", style: "y".repeat(50), examples: [], langs: ["id"] }, AGENT_TERMS.version);
    const messenger = new FakeMessenger();
    const scheduler = new FakeScheduler();
    const personas: string[] = [];
    const registry = new Registry({
      messenger,
      scheduler,
      timings: { lobbyMs: 1000, nightMs: 1000, discussionMs: 1000, voteMs: 1000 },
      randomInt: () => 0,
      botUsername: "nox_test_bot",
      narratorFor: (lang, p) => (p && personas.push(p.name), new TemplateNarrator(lang)),
      agents: () => [...THEME_AGENTS, ...store.listAgents(true)],
      store,
    });
    const users = [11, 22, 33, 44, 55];
    users.forEach((u) => registry.markStarted(u));
    await registry.create(-1, 11, "Ava", "id", { agentId: themeIdFrom("horor")! });
    const room = registry.roomOfChat(-1)!;

    const buttons = messenger.sent[0]!.keyboard!.flat().map((b) => b.text);
    expect(buttons.slice(2)).toEqual(["✓ 🌙 Nox (bawaan)", "🎨 Horor Desa", "🎨 Fantasi", "🎨 Kantor", `🎭 Wayang`]);
    expect(messenger.sent.at(-1)!.keyboard!.flat().map((b) => b.text)).toContain("✓ 🎨 Horor Desa");
    expect(agentId).toBeGreaterThan(0);

    for (const u of users.slice(1)) await registry.join(room.id, u, `P${u}`);
    await room.start(11);
    expect(personas).toEqual(["Horor Desa"]);

    const wolf = users.find((u) => room.roleOf(u) === "werewolf")!;
    await scheduler.advance(1000);
    await scheduler.advance(1000);
    for (const u of users) await room.vote(u, 1, String(wolf));
    expect(store.finishedGames(0, Date.now() + 1)[0]!.agentId).toBeNull();
  });
});
