import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadGmConfig } from "../src/config.js";
import { costUsd, createGmModel } from "../src/gm/model.js";

let seen: { url: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
let reply: Record<string, unknown> = {};
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    seen.push({ url: req.url ?? "", headers: req.headers, body: JSON.parse(raw || "{}") });
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
  });
});
let base = "";
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => void server.close());

const message = (text: string, stop = "end_turn") => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [{ type: "text", text }],
  stop_reason: stop,
  usage: { input_tokens: 300, output_tokens: 40 },
});

describe("Oxion provider", () => {
  it("posts a plain Anthropic Messages request with a Bearer key and no Anthropic API key", async () => {
    seen = [];
    reply = message(" Night whispers. ");
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-leak";
    try {
      const m = createGmModel({ provider: "oxion", model: "claude-opus-5-5", baseURL: base, authToken: "cc_test" });
      const r = await m.complete("sys", "user", 2000);
      expect(r.text).toBe("Night whispers.");
      expect(r.usage.inputTokens).toBe(300);
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
    const req = seen[0]!;
    expect(req.url).toBe("/v1/messages");
    expect(req.headers.authorization).toBe("Bearer cc_test");
    expect(req.headers["x-api-key"]).toBeUndefined();
    expect(req.headers["anthropic-beta"]).toBeUndefined();
    expect(Object.keys(req.body).sort()).toEqual(["max_tokens", "messages", "model", "system"]);
  });

  it("accepts a base URL ending in /v1, as Oxion's docs write it", async () => {
    seen = [];
    reply = message("ok");
    const m = createGmModel({ provider: "oxion", model: "claude-opus-5.5", baseURL: `${base}/v1/`, authToken: "cc_test" });
    await m.complete("sys", "user", 2000);
    expect(seen[0]!.url).toBe("/v1/messages");
  });

  it("treats a refusal as a failure so the narrator falls back", async () => {
    reply = message("", "refusal");
    const m = createGmModel({ provider: "oxion", model: "claude-opus-5-5", baseURL: base, authToken: "cc_test" });
    await expect(m.complete("sys", "user", 2000)).rejects.toThrow("refusal");
  });
});

describe("pricing", () => {
  it("prices dotted gateway model IDs like the Claude API ones", () => {
    const u = { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(costUsd("claude-opus-5.5", u)).toBe(24);
  });
});

describe("GM config", () => {
  it("defaults to templates and Claude Opus 5.5", () => {
    const c = loadGmConfig({});
    expect(c.mode).toBe("template");
    expect(c.provider).toBe("anthropic");
    expect(c.model).toBe("claude-opus-5-5");
  });

  it("requires OXION_API_KEY for the Oxion LLM mode and parses a price override", () => {
    expect(() => loadGmConfig({ NOX_GM: "llm", NOX_GM_PROVIDER: "oxion" })).toThrow("OXION_API_KEY");
    const c = loadGmConfig({ NOX_GM: "llm", NOX_GM_PROVIDER: "oxion", OXION_API_KEY: "cc_x", NOX_GM_PRICE_PER_M: "1.5,6" });
    expect(c.authToken).toBe("cc_x");
    expect(c.price).toEqual([1.5, 6]);
  });
});
