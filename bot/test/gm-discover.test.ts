import { describe, expect, it } from "vitest";
import { familyOf, finalizePool, rankCandidates, setEnvLine, versionOf, type ProbeResult } from "../src/gm/discover.js";

// GET https://oxionai.com/v1/models, 25 Oct 2026.
const OXION = [
  "gpt-5.6-terra", "deepseek-v4-flash-0731", "qwen3.7-max", "gemma-2-2b", "gemini-3.7-flash", "gpt-5.5", "glm-5.2",
  "kimi-k2.6", "seed-2.1-turbo", "deepseek-v4-pro-max", "muse-spark-1.1", "gpt-5.6-sol", "claude-mythos-preview",
  "glm-5.3", "claude-sonnet-5", "grok-4.5", "claude-opus-5.5", "claude-fable-5", "deepseek-v4-pro-0813",
  "claude-opus-4.6", "claude-opus-4.7", "gemini-3.6-flash", "claude-opus-5", "claude-opus-4.8", "qwen3.8-27b",
  "claude-fable-5.1", "gemini-3.1-pro", "qwen3.8-max", "gpt-5.6-luna", "gpt-5.5-pro", "grok-4.6", "seed-2.1-pro", "kimi-k3",
];
const ANTHROPIC = ["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-sonnet-5", "claude-haiku-5-5", "claude-haiku-4-5", "claude-opus-4-8"];

const label = (c: { provider: string; id: string }) => `${c.provider}:${c.id}`;

describe("model discovery", () => {
  it("parses families and versions", () => {
    expect(familyOf("qwen3.8-max")).toBe("qwen");
    expect(familyOf("claude-opus-5.5")).toBe("claude-opus");
    expect(versionOf("kimi-k3")).toEqual([3]);
    expect(versionOf("claude-opus-5-5")).toEqual([5, 5]);
    expect(versionOf("claude-opus-5")).toEqual([5, 0]);
  });

  it("picks 3 Claude API tiers then one newest model per gateway family, 10 total", () => {
    const top10 = rankCandidates(ANTHROPIC, OXION).slice(0, 10).map(label);
    expect(top10).toEqual([
      "anthropic:claude-opus-5-5",
      "anthropic:claude-sonnet-5-5",
      "anthropic:claude-haiku-5-5",
      "oxion:gpt-5.6-luna",
      "oxion:gemini-3.7-flash",
      "oxion:deepseek-v4-flash-0731",
      "oxion:qwen3.8-27b",
      "oxion:kimi-k3",
      "oxion:glm-5.3",
      "oxion:grok-4.6",
    ]);
  });

  it("never offers excluded models and keeps backups after the first choices", () => {
    const all = rankCandidates(ANTHROPIC, OXION).map(label);
    for (const bad of ["gemma", "mythos", "fable", "preview"]) expect(all.some((l) => l.includes(bad))).toBe(false);
    expect(all.indexOf("oxion:claude-opus-5.5")).toBeGreaterThan(all.indexOf("oxion:muse-spark-1.1"));
    expect(all).toContain("oxion:gpt-5.6-sol"); // backup within the gpt family
    expect(new Set(all).size).toBe(all.length);
  });

  it("works with only one provider", () => {
    expect(rankCandidates([], OXION)[0]!.provider).toBe("oxion");
    expect(rankCandidates(ANTHROPIC, []).map(label).slice(0, 3)).toEqual([
      "anthropic:claude-opus-5-5",
      "anthropic:claude-sonnet-5-5",
      "anthropic:claude-haiku-5-5",
    ]);
  });

  it("rewrites only the NOX_GM_MODELS line", () => {
    const env = "OXION_API_KEY=cc_secret\nNOX_GM_MODELS=old\nBOT_TOKEN=x\n";
    expect(setEnvLine(env, "NOX_GM_MODELS", "a,b")).toBe("OXION_API_KEY=cc_secret\nNOX_GM_MODELS=a,b\nBOT_TOKEN=x\n");
    expect(setEnvLine("A=1", "NOX_GM_MODELS", "a")).toBe("A=1\nNOX_GM_MODELS=a\n");
  });
});

describe("finalizePool", () => {
  const ranked = rankCandidates(ANTHROPIC, OXION);
  const all = (r: ProbeResult, provider?: string) =>
    new Map(ranked.filter((c) => !provider || c.provider === provider).map((c) => [label(c), r] as [string, ProbeResult]));

  it("keeps 3 Claude API + 7 gateway models when everything answers", () => {
    const { picked, unverified } = finalizePool(ranked, all("ok"), 10, 3);
    expect(picked.filter((c) => c.provider === "anthropic")).toHaveLength(3);
    expect(picked).toHaveLength(10);
    expect(unverified).toHaveLength(0);
  });

  it("keeps the gateway's share, unverified, while it is down", () => {
    const results = new Map([...all("ok", "anthropic"), ...all("outage", "oxion")]);
    const { picked, unverified } = finalizePool(ranked, results, 10, 3);
    expect(picked.filter((c) => c.provider === "anthropic").map(label)).toEqual([
      "anthropic:claude-opus-5-5",
      "anthropic:claude-sonnet-5-5",
      "anthropic:claude-haiku-5-5",
    ]);
    expect(unverified.map(label).slice(0, 2)).toEqual(["oxion:gpt-5.6-luna", "oxion:gemini-3.7-flash"]);
    expect(picked).toHaveLength(10);
    expect(new Set(unverified.map((c) => familyOf(c.id))).size).toBe(unverified.length); // one per family
  });

  it("still treats the gateway as down when a few probes return a stray 401", () => {
    const results = new Map([...all("ok", "anthropic"), ...all("outage", "oxion"), ["oxion:kimi-k3", "fail" as ProbeResult]]);
    const { picked, unverified } = finalizePool(ranked, results, 10, 3);
    expect(picked).toHaveLength(10);
    expect(unverified.map(label)).not.toContain("oxion:kimi-k3");
  });

  it("does not keep a provider whose probes all fail with client errors", () => {
    const results = new Map([...all("ok", "anthropic"), ...all("fail", "oxion")]);
    expect(finalizePool(ranked, results, 10, 3).picked).toHaveLength(3);
  });

  it("drops models that fail with a client error instead of keeping them", () => {
    const results = new Map([...all("ok"), ["oxion:gpt-5.6-luna", "fail" as ProbeResult]]);
    expect(finalizePool(ranked, results, 10, 3).picked.map(label)).not.toContain("oxion:gpt-5.6-luna");
  });
});
