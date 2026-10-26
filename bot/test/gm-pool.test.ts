import { describe, expect, it } from "vitest";
import { gmDataPolicyWarning, loadGmConfig, parsePool } from "../src/config.js";
import { LlmNarrator } from "../src/gm/llm-narrator.js";
import type { GmCompletion, GmModel } from "../src/gm/model.js";
import { GmModelPool } from "../src/gm/pool.js";

const USAGE = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 };

class Stub implements GmModel {
  calls = 0;
  constructor(
    readonly model: string,
    public fail = false,
  ) {}
  async complete(): Promise<GmCompletion> {
    this.calls++;
    if (this.fail) throw new Error(`${this.model} down`);
    return { text: `from ${this.model}`, usage: USAGE, model: this.model };
  }
}

function pool(entries: [string, Stub, number][], picks: number[] = [0], clock = { t: 0 }) {
  let i = 0;
  return new GmModelPool(
    entries.map(([label, model, weight]) => ({ label, model, weight })),
    () => picks[i++ % picks.length]!,
    () => clock.t,
    60_000,
  );
}

describe("GmModelPool", () => {
  it("picks the primary per game by weight", async () => {
    const a = new Stub("a");
    const b = new Stub("b");
    // weights 2 + 1 = 3 slots: 0,1 → a, 2 → b
    const p = pool([["oxion:a", a, 2], ["anthropic:b", b, 1]], [0, 1, 2]);
    const primaries = [p.forGame().model, p.forGame().model, p.forGame().model];
    expect(primaries).toEqual(["oxion:a", "oxion:a", "anthropic:b"]);
    expect((await p.forGame().complete("s", "u", 1)).model).toBe("oxion:a");
  });

  it("fails over to the other provider and labels who served", async () => {
    const a = new Stub("a", true);
    const b = new Stub("b");
    const m = pool([["oxion:a", a, 1], ["anthropic:b", b, 1]]).forGame();
    const r = await m.complete("s", "u", 1);
    expect(r.model).toBe("anthropic:b");
    expect(r.text).toBe("from b");
  });

  it("skips a failed entry while it cools down, then tries it again", async () => {
    const clock = { t: 0 };
    const a = new Stub("a", true);
    const b = new Stub("b");
    const p = pool([["oxion:a", a, 1], ["anthropic:b", b, 1]], [0], clock);
    const m = p.forGame();
    await m.complete("s", "u", 1);
    await m.complete("s", "u", 1);
    expect(a.calls).toBe(1); // second call skipped the cooling entry
    clock.t = 61_000;
    a.fail = false;
    expect((await m.complete("s", "u", 1)).model).toBe("oxion:a");
  });

  it("throws only when every entry fails, so the narrator falls back to templates", async () => {
    const m = pool([["oxion:a", new Stub("a", true), 1], ["anthropic:b", new Stub("b", true), 1]]).forGame();
    await expect(m.complete("s", "u", 1)).rejects.toThrow("down");
  });

  it("reports usage and cost per model that served", async () => {
    const lines: Record<string, unknown>[] = [];
    const a = new Stub("a", true);
    const p = pool([["oxion:claude-opus-5.5", a, 1], ["anthropic:claude-opus-5-5", new Stub("b"), 1]]);
    const n = new LlmNarrator({ model: p.forGame(), lang: "en", timeoutMs: 1, log: (l) => lines.push(l) });
    await n.nightFalls({ phase: "night", round: 1, alive: ["1"], eliminated: [], votesCast: 0, winner: null });
    n.finish();
    const usage = lines.find((l) => l.event === "gm_usage")!;
    expect(usage.model).toBe("oxion:claude-opus-5.5");
    expect(Object.keys(usage.byModel as object)).toEqual(["anthropic:claude-opus-5-5"]);
    expect(usage.costUsd).toBeCloseTo((100 * 4 + 10 * 20) / 1e6);
  });
});

describe("NOX_GM_MODELS", () => {
  it("parses provider:model@weight lists", () => {
    expect(parsePool("oxion:claude-opus-5.5@2, anthropic:claude-opus-5-5")).toEqual([
      { provider: "oxion", model: "claude-opus-5.5", weight: 2 },
      { provider: "anthropic", model: "claude-opus-5-5", weight: 1 },
    ]);
  });

  it("rejects bad entries", () => {
    expect(() => parsePool("openai:gpt")).toThrow("anthropic");
    expect(() => parsePool("oxion")).toThrow("provider:model");
    expect(() => parsePool("oxion:x@0")).toThrow("≥ 1");
  });

  it("overrides NOX_GM_PROVIDER/NOX_GM_MODEL and still needs the Oxion key", () => {
    const env = { NOX_GM: "llm", NOX_GM_PROVIDER: "anthropic", NOX_GM_MODELS: "oxion:claude-sonnet-5, anthropic:claude-opus-5-5" };
    expect(() => loadGmConfig(env)).toThrow("OXION_API_KEY");
    expect(loadGmConfig({ ...env, OXION_API_KEY: "cc_x" }).pool).toHaveLength(2);
  });
});

describe("provider data policy (F09-D06)", () => {
  it("warns when a pool sends prompts through a provider with an unverified upstream", () => {
    const pool = loadGmConfig({ NOX_GM: "llm", NOX_GM_MODELS: "oxion:claude-opus-5.5@2, anthropic:claude-opus-5-5", OXION_API_KEY: "cc_x" });
    expect(gmDataPolicyWarning(pool, "testnet")).toMatch(/^GM provider oxion .*Fine for testing/);
    expect(gmDataPolicyWarning(pool, "mainnet")).toMatch(/Do not use it with real players on mainnet/);
    expect(gmDataPolicyWarning(loadGmConfig({ NOX_GM: "llm", NOX_GM_MODELS: "anthropic:claude-opus-5-5" }), "mainnet")).toBeNull();
    expect(gmDataPolicyWarning(loadGmConfig({ NOX_GM: "template", NOX_GM_PROVIDER: "oxion" }), "mainnet")).toBeNull();
  });
});
