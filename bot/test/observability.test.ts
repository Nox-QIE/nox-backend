import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { opsDays } from "../scripts/ops-report.js";
import { AlertMonitor } from "../src/alerts.js";
import { LlmNarrator } from "../src/gm/llm-narrator.js";
import type { GmCompletion, GmModel } from "../src/gm/model.js";
import { TemplateNarrator, type NarratorReport } from "../src/narrator.js";
import { Registry } from "../src/registry.js";
import { SqliteStore } from "../src/store.js";
import { FakeMessenger, FakeScheduler } from "./fakes.js";

describe("error-rate alerts (APP-08)", () => {
  it("alerts once when a kind of error crosses its threshold, then stays quiet for the cooldown", () => {
    let now = 0;
    const sent: string[] = [];
    const m = new AlertMonitor({ send: (t) => void sent.push(t), now: () => now });
    m.observe({ event: "chain_error" });
    now += 60_000;
    m.observe({ event: "chain_error" });
    m.observe({ event: "gas_drip" }); // not an error kind
    expect(sent).toEqual([]);
    now += 60_000;
    m.observe({ event: "chain_error" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("3 chain errors in 10 min");
    m.observe({ event: "chain_error" }); // within the cooldown
    expect(sent).toHaveLength(1);
    now += 3600_000; // cooldown over, but the old errors left the window
    m.observe({ event: "chain_error" });
    expect(sent).toHaveLength(1);
    m.observe({ event: "chain_error" });
    m.observe({ event: "chain_error" });
    expect(sent).toHaveLength(2);
  });
});

describe("AI cost per game (F09-D05)", () => {
  it("the narrator reports model, tokens and cost", async () => {
    const model: GmModel = {
      model: "claude-opus-5-5",
      complete: async (): Promise<GmCompletion> => ({ text: "Fog.", usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-opus-5-5" }),
    };
    const n = new LlmNarrator({ model, lang: "en", timeoutMs: 1000 });
    await n.nightFalls({ phase: "night", round: 1, alive: ["1", "2"], eliminated: [], votesCast: 0, winner: null });
    const r = n.finish();
    expect(r).toMatchObject({ model: "claude-opus-5-5", inputTokens: 1000, outputTokens: 100, nox: 1, template: 0 });
    expect(r.costUsd).toBeGreaterThan(0);
  });

  it("every finished game is reported and stored, with or without an agent", async () => {
    const store = new SqliteStore(":memory:");
    const scheduler = new FakeScheduler();
    const report: NarratorReport = { persona: 0, nox: 4, template: 1, rejected: 0, demoted: false, model: "claude-opus-5-5", inputTokens: 3000, outputTokens: 400, costUsd: 0.02 };
    const registry = new Registry({
      messenger: new FakeMessenger(),
      scheduler,
      timings: { lobbyMs: 1000, nightMs: 1000, discussionMs: 1000, voteMs: 1000 },
      randomInt: () => 0,
      botUsername: "b",
      narratorFor: (lang) => Object.assign(new TemplateNarrator(lang), { finish: () => report }),
      store,
      onGameReport: (g) => store.recordGmGame(g),
    });
    const users = [11, 22, 33, 44, 55];
    for (const u of users) registry.startedUsers.add(u);
    await registry.create(-1, 11, "Ava", "en");
    const room = registry.roomOfChat(-1)!;
    for (const u of users.slice(1)) await registry.join(room.id, u, `P${u}`);
    await room.start(11);
    const role = (r: string) => users.filter((u) => room.roleOf(u) === r);
    const [wolf] = role("werewolf");
    await room.nightAction(wolf!, 1, String(role("villager")[0]));
    await room.nightAction(role("seer")[0]!, 1, String(wolf));
    await room.nightAction(role("doctor")[0]!, 1, String(role("doctor")[0]));
    await scheduler.advance(1000);
    for (const u of users.filter((u) => room.isAlive(u))) await room.vote(u, 1, String(u === wolf ? users.filter((u) => room.isAlive(u)).find((x) => x !== wolf) : wolf)); // no self-votes
    expect(store.gmGames(0, Date.now() + 1)).toEqual([expect.objectContaining({ agentId: null, players: 5, model: "claude-opus-5-5", inputTokens: 3000, costUsd: 0.02, template: 1 })]);
  });
});

describe("daily ops report (APP-08)", () => {
  it("adds up games, AI cost, template share, gas, failures and practice per day", () => {
    const store = new SqliteStore(":memory:");
    store.recordFinishedGame({ agentId: null, players: 5, hostId: 1, chainGameId: null });
    store.recordFinishedGame({ agentId: null, players: 7, hostId: 2, chainGameId: null });
    const base = { persona: 0, rejected: 0, demoted: false, inputTokens: 1, outputTokens: 1 };
    store.recordGmGame({ gameId: null, agentId: null, players: 5, report: { ...base, nox: 3, template: 1, model: "claude-opus-5-5", costUsd: 0.02 } });
    store.recordGmGame({ gameId: null, agentId: null, players: 7, report: { ...base, nox: 4, template: 0, model: "oxion:mystery", costUsd: null } });
    const tx = { gameId: ("0x" + "1".repeat(64)) as Hex, step: "castVote", from: "0x01" as Hex, to: "0x02" as Hex, hash: null, gasUsed: 50_000n, feeWei: 56_250_000_000_000n, block: 1n, attempts: 1, error: null };
    store.recordTx({ ...tx, status: "success" });
    store.recordTx({ ...tx, status: "failed", gasUsed: null, feeWei: null, attempts: 3, error: "fetch failed" });
    const drip = { ...tx, step: "gas drip", status: "success" as const, gasUsed: 21_000n, feeWei: 23_625_000_000_000n };
    store.recordTx({ ...drip, reason: "onboarding", valueWei: 10n ** 16n });
    store.recordTx({ ...drip, reason: "top-up", valueWei: 4n * 10n ** 15n });
    store.upsertUser(7, { locale: "id", address: "0x" + "77".repeat(20) });
    store.practiceStarted();
    store.practiceStarted();
    store.practiceFinished();
    const [d] = opsDays(store, Date.now() - 86_400_000, Date.now() + 1);
    expect(d).toMatchObject({ games: 2, seats: 12, aiUsd: 0.02, unpriced: 1, templateShare: 1 / 8, failedTxs: 1, practiceStarted: 2, practiceFinished: 1 });
    expect(d).toMatchObject({ gasFeeWei: 56_250_000_000_000n + 2n * 23_625_000_000_000n, newWallets: 1, dripWei: 14n * 10n ** 15n, onboardingDripWei: 10n ** 16n });
  });
});
