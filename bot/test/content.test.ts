import { readFileSync } from "node:fs";
import { configHash } from "@nox/shared/crypto-spec";
import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { AgentRecord } from "../src/agents.js";
import { noLedger, type GameLedger } from "../src/chain/ledger.js";
import { contentCatalog, gmRef, scenarioRef } from "../src/content.js";
import { TemplateNarrator } from "../src/narrator.js";
import { Registry } from "../src/registry.js";
import { TASK_SCAM } from "../src/scenarios.js";
import { THEME_AGENTS } from "../src/themes.js";
import { FakeMessenger, FakeScheduler } from "./fakes.js";

const lock = JSON.parse(readFileSync(new URL("../content.lock.json", import.meta.url), "utf8")) as Record<string, { version: number; hash: Hex }>;

describe("versioned content (L1-07, F09-D02, F10-D01)", () => {
  it("every theme and scenario matches content.lock.json: changed text needs a version bump", () => {
    for (const c of contentCatalog()) {
      const locked = lock[c.id];
      expect(locked, `${c.id} is new: run npm run content:lock`).toBeDefined();
      if (locked!.version === c.version) {
        expect(c.hash, `${c.id} text changed without a version bump: raise its version, then npm run content:lock`).toBe(locked!.hash);
      } else {
        expect(locked!.version, `${c.id} version changed: run npm run content:lock`).toBe(c.version);
      }
    }
  });

  it("the hash covers the text, including the scenario's wording functions", () => {
    const base = scenarioRef(TASK_SCAM).hash;
    const edited = { ...TASK_SCAM, text: { ...TASK_SCAM.text, id: { ...TASK_SCAM.text.id, wording: { ...TASK_SCAM.text.id.wording, dayNone: "⚖️ (diubah)" } } } };
    expect(scenarioRef(edited).hash).not.toBe(base);
  });

  it("names the Game Master: Nox, a theme with its version, or an agent with its persona hash", () => {
    expect(gmRef(undefined)).toEqual({ id: "nox" });
    const horror = THEME_AGENTS.find((a) => a.id === -1)!;
    expect(gmRef(horror)).toMatchObject({ id: "theme:horor", version: 1 });
    const agent: AgentRecord = { id: 7, owner: "0xabc", persona: { name: "Noir", tagline: "", style: "x".repeat(50), examples: [], langs: ["en"] }, status: "active", chainAgentId: null };
    const changed = { ...agent, persona: { ...agent.persona, style: "y".repeat(50) } };
    expect(gmRef(agent).id).toBe("agent:7");
    expect(gmRef(agent).hash).not.toBe(gmRef(changed).hash);
  });

  it("the config committed at createGame names the GM and the scenario versions", async () => {
    const committed: Hex[] = [];
    const ledger: GameLedger = { ...noLedger, enabled: true, addressOf: (u) => `0x${u.toString(16).padStart(40, "0")}` as Address, startGame: (_g, cfg) => void committed.push(cfg) };
    const timings = { lobbyMs: 1000, nightMs: 1000, discussionMs: 1000, voteMs: 1000 };
    const registry = new Registry({ messenger: new FakeMessenger(), scheduler: new FakeScheduler(), timings, randomInt: () => 0, botUsername: "b", narratorFor: (l) => new TemplateNarrator(l), ledger });
    for (const u of [1, 2, 3, 4, 5]) registry.startedUsers.add(u);
    await registry.create(-1, 1, "Host", "id", { scenario: TASK_SCAM });
    const room = registry.roomOfChat(-1)!;
    for (const u of [2, 3, 4, 5]) await registry.join(room.id, u, `P${u}`);
    await room.start(1);
    const expected = { players: 5, timings, revealOnDeath: true, lang: "id", gm: { id: "nox" }, scenario: scenarioRef(TASK_SCAM) };
    expect(committed).toEqual([configHash(expected)]);
  });
});
