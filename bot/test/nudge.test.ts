import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { LlmNarrator } from "../src/gm/llm-narrator.js";
import type { GmCompletion, GmModel } from "../src/gm/model.js";
import { TemplateNarrator } from "../src/narrator.js";
import { Registry } from "../src/registry.js";
import { FakeMessenger, FakeScheduler } from "./fakes.js";

const USERS = [11, 22, 33, 44, 55];

async function toDiscussion(opts: { nudge?: "quiet" | "always"; canCountMessages?: boolean }) {
  const messenger = new FakeMessenger();
  const scheduler = new FakeScheduler();
  const registry = new Registry({
    messenger,
    scheduler,
    timings: { lobbyMs: 1000, nightMs: 1000, discussionMs: 1000, voteMs: 1000 },
    randomInt: () => 0,
    botUsername: "b",
    narratorFor: (lang) => new TemplateNarrator(lang),
    ...opts,
  });
  for (const u of USERS) registry.startedUsers.add(u);
  await registry.create(-1, 11, "Ava", "en");
  const room = registry.roomOfChat(-1)!;
  for (const u of USERS.slice(1)) await registry.join(room.id, u, `P${u}`);
  await room.start(11);
  const role = (r: string) => USERS.filter((u) => room.roleOf(u) === r);
  await room.nightAction(role("werewolf")[0]!, 1, String(role("villager")[0]));
  await room.nightAction(role("seer")[0]!, 1, String(role("werewolf")[0]));
  await room.nightAction(role("doctor")[0]!, 1, String(role("doctor")[0])); // → discussion
  const nudges = () => messenger.group().filter((m) => m.startsWith("🎙"));
  return { room, scheduler, nudges };
}

describe("GM nudge for a quiet discussion (F07-S02)", () => {
  it("quiet mode: nudges halfway when fewer messages than living players were seen", async () => {
    const { scheduler, nudges } = await toDiscussion({ nudge: "quiet", canCountMessages: true });
    await scheduler.advance(500);
    expect(nudges()).toEqual(["🎙 So quiet. Who is most sure of their pick, and why?"]);
  });

  it("quiet mode: stays out of a lively discussion", async () => {
    const { room, scheduler, nudges } = await toDiscussion({ nudge: "quiet", canCountMessages: true });
    for (let i = 0; i < 4; i++) room.noteGroupMessage(); // 4 living players
    await scheduler.advance(500);
    expect(nudges()).toEqual([]);
  });

  it("quiet mode cannot judge without reading group messages, so it does nothing", async () => {
    const { scheduler, nudges } = await toDiscussion({ nudge: "quiet", canCountMessages: false });
    await scheduler.advance(500);
    expect(nudges()).toEqual([]);
  });

  it("always mode nudges once per discussion, and never after the vote opened", async () => {
    const lively = await toDiscussion({ nudge: "always" });
    for (let i = 0; i < 10; i++) lively.room.noteGroupMessage();
    await lively.scheduler.advance(500);
    expect(lively.nudges()).toHaveLength(1);
    await lively.scheduler.advance(500); // vote opens
    await lively.scheduler.advance(500);
    expect(lively.nudges()).toHaveLength(1);
    const off = await toDiscussion({});
    await off.scheduler.advance(500);
    expect(off.nudges()).toEqual([]);
  });

  it("the LLM nudge never names a player; a bad line falls back to the template", async () => {
    const view = { phase: "day" as const, round: 2, alive: ["1", "2", "3"], eliminated: [], votesCast: 0, winner: null };
    const say = (text: string): GmModel => ({ model: "claude-opus-5-5", complete: async (): Promise<GmCompletion> => ({ text, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-opus-5-5" }) });
    const names = ["Ava", "Ben", "Cy"];
    const good = new LlmNarrator({ model: say("Who spoke least today, and what are they hiding?"), lang: "en", timeoutMs: 1000 });
    await good.intro(view, names);
    expect(await good.nudge(view)).toBe("🎙 <i>Who spoke least today, and what are they hiding?</i>");
    const bad = new LlmNarrator({ model: say("Ben has been very quiet, hasn't he?"), lang: "en", timeoutMs: 1000 });
    await bad.intro(view, names);
    expect(await bad.nudge(view)).toBe("🎙 Anyone suspicious but still silent? Now is the time."); // round 2 template line
  });

  it("NOX_DISCUSSION_NUDGE is checked", () => {
    expect(loadConfig({ BOT_TOKEN: "1:x" }).nudge).toBe("quiet");
    expect(loadConfig({ BOT_TOKEN: "1:x", NOX_DISCUSSION_NUDGE: "off" }).nudge).toBe("off");
    expect(() => loadConfig({ BOT_TOKEN: "1:x", NOX_DISCUSSION_NUDGE: "loud" })).toThrow();
  });
});
