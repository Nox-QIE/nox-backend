import { describe, expect, it } from "vitest";
import { suspensionReason, type AgentRecord } from "../src/agents.js";
import { TemplateNarrator, type NarratorReport } from "../src/narrator.js";
import { Registry } from "../src/registry.js";
import { SqliteStore } from "../src/store.js";
import { onAgentGame } from "../src/telegram.js";
import { FakeMessenger, FakeScheduler } from "./fakes.js";

const good: NarratorReport = { persona: 5, nox: 0, template: 0, rejected: 0, demoted: false };
const demoted: NarratorReport = { persona: 1, nox: 4, template: 0, rejected: 3, demoted: true };
const outage: NarratorReport = { persona: 0, nox: 0, template: 5, rejected: 0, demoted: false };
const persona = { name: "Noir", tagline: "", style: "x".repeat(50), examples: [], langs: ["en" as const] };

describe("agent health rule (F18-S11)", () => {
  it("suspends after the persona was set aside in 3 of the last 10 games", () => {
    expect(suspensionReason([demoted, demoted, good, good])).toBeNull();
    expect(suspensionReason([demoted, good, demoted, demoted])).toMatch(/set aside in 3 of the last 4 games/);
    // Older than the window does not count.
    expect(suspensionReason([...Array(10).fill(good), demoted, demoted, demoted])).toBeNull();
  });

  it("suspends when the persona writes under half the lines over 5+ games, ignoring provider outages", () => {
    const weak: NarratorReport = { persona: 2, nox: 3, template: 0, rejected: 1, demoted: false };
    expect(suspensionReason([weak, weak, weak, weak])).toBeNull(); // too few games to judge
    expect(suspensionReason([weak, weak, weak, weak, weak])).toMatch(/persona wrote 40% of the lines/);
    expect(suspensionReason([outage, outage, outage, outage, outage, good])).toBeNull();
  });
});

describe("automatic suspension and moderation log (F18-S11, F18-D06)", () => {
  it("records each game, suspends once, notes why and tells the operator", () => {
    const store = new SqliteStore(":memory:");
    const id = store.addAgent("0x00000000000000000000000000000000000a9e01", persona);
    const messenger = new FakeMessenger();
    const logs: Record<string, unknown>[] = [];
    const done = onAgentGame({ store, messenger, operatorChatId: 7, log: (l) => logs.push(l) });
    done(id, demoted);
    done(id, good);
    expect(store.getAgent(id)!.status).toBe("active");
    done(id, demoted);
    done(id, demoted);
    expect(store.getAgent(id)!.status).toBe("suspended");
    expect(store.moderationLog(id)).toEqual([expect.objectContaining({ decision: "suspended", by: "auto", reason: expect.stringMatching(/set aside in 3 of the last 4/) })]);
    expect(messenger.dms(7)[0]!.html).toContain('Agent #1 "Noir" suspended automatically');
    expect(logs).toContainEqual(expect.objectContaining({ event: "agent_suspended", agentId: id }));
    done(id, demoted); // already suspended: no second decision
    expect(store.moderationLog(id)).toHaveLength(1);
    expect(store.agentGames(id, 10)).toHaveLength(5);
  });
});

describe("room → agent report", () => {
  async function playToEnd(agentId: number, agents: AgentRecord[]) {
    const messenger = new FakeMessenger();
    const scheduler = new FakeScheduler();
    const reports: [number, NarratorReport][] = [];
    const registry = new Registry({
      messenger,
      scheduler,
      timings: { lobbyMs: 1000, nightMs: 1000, discussionMs: 1000, voteMs: 1000 },
      randomInt: () => 0,
      botUsername: "nox_test_bot",
      // A narrator that reports a fixed persona record when the game ends.
      narratorFor: (lang) => Object.assign(new TemplateNarrator(lang), { finish: () => good }),
      agents: () => agents,
      onAgentGame: (id, r) => reports.push([id, r]),
    });
    const users = [11, 22, 33, 44, 55];
    for (const u of users) registry.startedUsers.add(u);
    await registry.create(-1, 11, "Ava", "en");
    const room = registry.roomOfChat(-1)!;
    for (const u of users.slice(1)) await registry.join(room.id, u, `P${u}`);
    await room.pickAgent(11, agentId);
    await room.start(11);
    const role = (r: string) => users.filter((u) => room.roleOf(u) === r);
    const [wolf] = role("werewolf");
    await room.nightAction(wolf!, 1, String(role("villager")[0]));
    await room.nightAction(role("seer")[0]!, 1, String(wolf));
    await room.nightAction(role("doctor")[0]!, 1, String(role("doctor")[0]));
    await scheduler.advance(1000);
    for (const u of users.filter((u) => room.isAlive(u))) await room.vote(u, 1, String(wolf));
    expect(room.status).toBe("ended");
    return reports;
  }

  it("reports a Marketplace agent's game, but not a Nox theme's", async () => {
    const agent: AgentRecord = { id: 5, owner: "0xabc", persona, status: "active", chainAgentId: null };
    expect(await playToEnd(5, [agent])).toEqual([[5, good]]);
    const theme: AgentRecord = { id: -1, owner: "", persona, status: "active", chainAgentId: null };
    expect(await playToEnd(-1, [theme])).toEqual([]);
  });
});
