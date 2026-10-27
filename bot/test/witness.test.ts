import { describe, expect, it } from "vitest";
import { DiscussionTally } from "../src/discussion.js";
import { LlmNarrator } from "../src/gm/llm-narrator.js";
import type { GmCompletion, GmModel } from "../src/gm/model.js";
import { TemplateNarrator } from "../src/narrator.js";
import { Registry } from "../src/registry.js";
import { FakeMessenger, FakeScheduler } from "./fakes.js";

const USERS = [11, 22, 33, 44, 55];
const NAMES: Record<number, string> = { 11: "Ava", 22: "Ben", 33: "Cy", 44: "Dee", 55: "Eli" };

async function toDiscussion(canCountMessages: boolean) {
  const messenger = new FakeMessenger();
  const scheduler = new FakeScheduler();
  const registry = new Registry({
    messenger,
    scheduler,
    timings: { lobbyMs: 1000, nightMs: 1000, discussionMs: 1000, voteMs: 1000 },
    randomInt: () => 0,
    botUsername: "b",
    narratorFor: (lang) => new TemplateNarrator(lang),
    canCountMessages,
  });
  for (const u of USERS) registry.startedUsers.add(u);
  await registry.create(-1, 11, NAMES[11]!, "en");
  const room = registry.roomOfChat(-1)!;
  for (const u of USERS.slice(1)) await registry.join(room.id, u, NAMES[u]!);
  await room.start(11);
  const role = (r: string) => USERS.filter((u) => room.roleOf(u) === r);
  const doctor = role("doctor")[0]!;
  const victim = role("villager")[0]!;
  await room.nightAction(role("werewolf")[0]!, 1, String(victim));
  await room.nightAction(role("seer")[0]!, 1, String(role("werewolf")[0]));
  await room.nightAction(doctor, 1, String(victim)); // saved: everyone is alive in the discussion
  const report = () => messenger.group().filter((m) => m.includes("Witness report"));
  return { room, scheduler, report };
}

describe("witness report (10.07 #1)", () => {
  it("counts speakers and whole-word name mentions, never a self-mention or a non-player", () => {
    const t = new DiscussionTally([
      { id: "1", name: "Ava" },
      { id: "2", name: "Ben" },
      { id: "3", name: "Cy" },
      { id: "4", name: "Dee" },
    ]);
    t.note("1", "I think BEN is lying");
    t.note("1", "ben again, and Cy too");
    t.note("1", "Ava here, trust me"); // self-mention
    t.note("3", "Ava is right about Ben.");
    t.note("2", "bentuknya aneh"); // "ben" inside a word does not count
    t.note("99", "Dee Dee Dee"); // not a living player
    expect(t.messages).toBe(5);
    expect(t.report()).toEqual({
      mentioned: [
        { name: "Ben", count: 3 },
        { name: "Ava", count: 1 }, // ties keep seat order
        { name: "Cy", count: 1 },
      ],
      talkative: "Ava",
      quiet: ["Dee"],
    });
  });

  it("names no talkative player without a clear leader of at least three messages", () => {
    const t = new DiscussionTally([
      { id: "1", name: "Ava" },
      { id: "2", name: "Ben" },
    ]);
    t.note("1", "hi");
    t.note("1", "hello");
    t.note("2", "yo");
    expect(t.report().talkative).toBeNull();
  });

  it("is read out when the vote opens, and only when the bot could read the group", async () => {
    const on = await toDiscussion(true);
    on.room.noteGroupMessage(22, "Cy was weird last night");
    on.room.noteGroupMessage(22, "cy, explain");
    on.room.noteGroupMessage(22, "Ava agrees with me");
    on.room.noteGroupMessage(33, "Ben is pushing too hard");
    await on.scheduler.advance(1000); // vote opens
    expect(on.report()).toEqual(["👁 <b>Witness report</b>\n• Named most: Cy (2×), Ava (1×), Ben (1×)\n• Spoke the most: Ben\n• Silent the whole discussion: Ava, Dee, Eli"]);

    const silent = await toDiscussion(true);
    await silent.scheduler.advance(1000);
    expect(silent.report()).toEqual([]); // nobody spoke: nothing to report

    const blind = await toDiscussion(false);
    blind.room.noteGroupMessage(22, "Cy was weird");
    await blind.scheduler.advance(1000);
    expect(blind.report()).toEqual([]);
  });

  it("ignores messages outside the discussion", async () => {
    const { room, scheduler, report } = await toDiscussion(true);
    room.noteGroupMessage(22, "Cy Cy");
    await scheduler.advance(1000); // vote opens: report out
    room.noteGroupMessage(22, "Cy again during the vote");
    expect(report()).toHaveLength(1);
    expect(report()[0]).toContain("Cy (1×)");
  });

  it("LLM flavor may name the reported players but never next to a role word", async () => {
    const view = { phase: "day" as const, round: 1, alive: ["1", "2", "3"], eliminated: [], votesCast: 0, winner: null };
    const say = (text: string): GmModel => ({ model: "claude-opus-5-5", complete: async (): Promise<GmCompletion> => ({ text, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-opus-5-5" }) });
    const w = { mentioned: [{ name: "Ben", count: 3 }], talkative: "Ava", quiet: [] };
    const good = new LlmNarrator({ model: say("Every tongue in the square kept circling back to Ben."), lang: "en", timeoutMs: 1000 });
    await good.intro(view, ["Ava", "Ben", "Cy"]);
    expect(await good.witness(view, w)).toBe("<i>Every tongue in the square kept circling back to Ben.</i>\n\n👁 <b>Witness report</b>\n• Named most: Ben (3×)\n• Spoke the most: Ava");
    const hint = new LlmNarrator({ model: say("Ben talks like a werewolf."), lang: "en", timeoutMs: 1000 });
    await hint.intro(view, ["Ava", "Ben", "Cy"]);
    expect(await hint.witness(view, w)).toBe("👁 <b>Witness report</b>\n• Named most: Ben (3×)\n• Spoke the most: Ava");
    const other = new LlmNarrator({ model: say("Cy said nothing, as usual."), lang: "en", timeoutMs: 1000 });
    await other.intro(view, ["Ava", "Ben", "Cy"]);
    expect(await other.witness(view, w)).not.toContain("Cy said"); // Cy is alive and not in the report
  });
});
