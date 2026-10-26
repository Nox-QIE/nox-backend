import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { checkEndpointUrl, EndpointModel, httpsPost, isPublicAddress, safeLookup, signRequest, type Post } from "../src/gm/endpoint.js";
import { LlmNarrator } from "../src/gm/llm-narrator.js";
import type { GmCompletion, GmModel } from "../src/gm/model.js";
import { userPrompt } from "../src/gm/prompt.js";
import { SqliteStore } from "../src/store.js";
import { tempDbPath } from "./fakes.js";

describe("SSRF guard (F18-D03)", () => {
  it("only public unicast addresses are allowed", () => {
    for (const ip of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.20.0.1", "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fd00::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::10.0.0.1", "2002:c0a8:0101::1", "2001:db8::1", "not-an-ip"]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPublicAddress(ip), ip).toBe(true);
  });

  it("checks the URL before it is stored", () => {
    expect(checkEndpointUrl("https://agent.example.com/nox?x=1").toString()).toBe("https://agent.example.com/nox?x=1");
    expect(checkEndpointUrl("https://8.8.8.8/gm").hostname).toBe("8.8.8.8");
    for (const [url, why] of [
      ["http://agent.example.com", /https/],
      ["https://user:pw@agent.example.com", /credentials/],
      ["https://agent.example.com:8443", /443/],
      ["https://localhost/gm", /public domain/],
      ["https://printer.local/", /public domain/],
      ["https://intranet/", /public domain/],
      ["https://10.0.0.5/", /not public/],
      ["https://[::1]/", /not public/],
      ["https://169.254.169.254/latest/meta-data", /not public/],
      ["not a url", /valid URL/],
    ] as const) {
      expect(() => checkEndpointUrl(url), url).toThrow(why);
    }
  });

  const fakeDns = (map: Record<string, string[]>) =>
    ((host: string, _o: unknown, cb: (e: Error | null, a: { address: string; family: number }[]) => void) =>
      cb(null, (map[host] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 })))) as never;

  it("refuses to connect when any resolved address is private (DNS rebinding included)", async () => {
    const lookup = safeLookup(fakeDns({ "good.example": ["93.184.216.34"], "evil.example": ["93.184.216.34", "10.0.0.7"], "none.example": [] }));
    const ask = (host: string, all: boolean) =>
      new Promise<unknown>((resolve, reject) => lookup(host, { all }, (err, address) => (err ? reject(err) : resolve(address))));
    expect(await ask("good.example", false)).toBe("93.184.216.34");
    expect(await ask("good.example", true)).toEqual([{ address: "93.184.216.34", family: 4 }]);
    await expect(ask("evil.example", false)).rejects.toThrow(/non-public/);
    await expect(ask("none.example", false)).rejects.toThrow(/non-public/);
  });

  it("the real client refuses a name that resolves to this machine", async () => {
    await expect(httpsPost(new URL("https://localhost/gm"), {}, "{}", 2000)).rejects.toMatchObject({ code: "ENDPOINT_NOT_PUBLIC" });
  });
});

describe("endpoint requests (F18-S10)", () => {
  const secret = "ab".repeat(32);
  const beat = { kind: "morning" as const, round: 2, eliminated: "Ben", revealedRole: "seer" as const, alive: 4 };

  it("sends only the public facts, signed with the agent's secret", async () => {
    let seen: { url: URL; headers: Record<string, string>; body: string } | undefined;
    const post: Post = async (url, headers, body) => {
      seen = { url, headers, body };
      return { status: 200, contentType: "application/json; charset=utf-8", body: JSON.stringify({ text: "The bell tolls." }) };
    };
    const m = new EndpointModel({ agentId: 9, url: "https://agent.example.com/gm", secret, lang: "en", post, now: () => 1_792_000_000_000 });
    const r = await m.complete("SYSTEM PROMPT: never name a living player", userPrompt(beat), 5000);
    expect(r).toMatchObject({ text: "The bell tolls.", model: "endpoint:9" });
    expect(JSON.parse(seen!.body)).toEqual({ v: 1, agentId: 9, lang: "en", facts: beat });
    expect(seen!.body).not.toContain("SYSTEM PROMPT"); // Nox's instructions never leave
    expect(seen!.headers["x-nox-timestamp"]).toBe("1792000000");
    expect(seen!.headers["x-nox-signature"]).toBe(signRequest(secret, "1792000000", seen!.body));
    expect(seen!.headers["x-nox-signature"]).not.toBe(signRequest("other", "1792000000", seen!.body));
  });

  it("rejects answers that are not 200 JSON with a text field, or too large", async () => {
    const answer = (status: number, contentType: string, body: string): Post => async () => ({ status, contentType, body });
    const m = (post: Post) => new EndpointModel({ agentId: 9, url: "https://agent.example.com/gm", secret, lang: "en", post });
    await expect(m(answer(500, "application/json", "{}")).complete("", userPrompt(beat), 1000)).rejects.toThrow(/HTTP 500/);
    await expect(m(answer(302, "text/html", "")).complete("", userPrompt(beat), 1000)).rejects.toThrow(/HTTP 302/); // no redirects
    await expect(m(answer(200, "text/plain", "hi")).complete("", userPrompt(beat), 1000)).rejects.toThrow(/JSON/);
    await expect(m(answer(200, "application/json", '{"msg":"hi"}')).complete("", userPrompt(beat), 1000)).rejects.toThrow(/text/);
    await expect(m(answer(200, "application/json", JSON.stringify({ text: "a".repeat(5000) }))).complete("", userPrompt(beat), 1000)).rejects.toThrow(/too large/);
  });
});

describe("red-team: malicious endpoints (F18-S13)", () => {
  /** Nox's own LLM, behaving. */
  const nox: GmModel = { model: "claude-opus-5-5", complete: async (): Promise<GmCompletion> => ({ text: "Mist hangs over the square.", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-opus-5-5" }) };
  const persona = { name: "Rogue", tagline: "", style: "external endpoint, hosted by its owner", examples: [], langs: ["en" as const] };
  const view = { phase: "day" as const, round: 1, alive: ["1", "2", "3", "4"], eliminated: [], votesCast: 0, winner: null };
  const names = ["Ava", "Ben", "Cy", "Dee", "Eli"];

  const attacks: [string, (body: string) => ReturnType<Post>, string[]][] = [
    ["phishing link", async () => ({ status: 200, contentType: "application/json", body: JSON.stringify({ text: "Claim your prize at nox-gift.click" }) }), ["nox-gift"]],
    ["names a living player as the wolf", async () => ({ status: 200, contentType: "application/json", body: JSON.stringify({ text: "Ben is the werewolf." }) }), ["ben is the werewolf"]],
    ["HTML injection", async () => ({ status: 200, contentType: "application/json", body: JSON.stringify({ text: '<a href="https://evil.example">win</a>' }) }), ["<a ", "evil.example"]],
    ["asks for money", async () => ({ status: 200, contentType: "application/json", body: JSON.stringify({ text: "Send 0.1 QIE to 0x1111111111111111111111111111111111111111" }) }), ["0x1111", "send 0.1"]],
    ["fake admin mention", async () => ({ status: 200, contentType: "application/json", body: JSON.stringify({ text: "DM @NoxSupport to cash out" }) }), ["@noxsupport"]],
    ["flood", async () => ({ status: 200, contentType: "application/json", body: JSON.stringify({ text: "A".repeat(3000) }) }), ["A".repeat(40)]],
    ["hangs", () => Promise.reject(new Error("endpoint timed out")), []],
    ["redirects to an internal host", async () => ({ status: 307, contentType: "text/html", body: "" }), []],
    ["answers garbage", async () => ({ status: 200, contentType: "application/json", body: "{not json" }), []],
  ];

  for (const [name, answer, forbidden] of attacks) {
    it(`blocks an endpoint that ${name}`, async () => {
      const bodies: string[] = [];
      const post: Post = (_u, _h, body) => (bodies.push(body), answer(body));
      const n = new LlmNarrator({ model: nox, lang: "en", timeoutMs: 1000, persona, personaModel: new EndpointModel({ agentId: 3, url: "https://rogue.example.com/gm", secret: "s".repeat(64), lang: "en", post }) });
      const out = [
        await n.intro(view, names),
        await n.nightFalls(view),
        await n.morning(view, "Eli", "villager"),
        await n.dayResult(view, null, null),
        await n.gameOver("village", names.map((nm, i) => ({ name: nm, role: i === 0 ? "werewolf" : "villager" }))),
      ].join("\n").toLowerCase();
      for (const f of forbidden) expect(out).not.toContain(f.toLowerCase());
      expect(out).toContain("mist hangs"); // Nox's own voice took over
      // The endpoint only ever saw public facts: no roles of living players, no ids, no instructions.
      for (const b of bodies) {
        expect(b).not.toMatch(/never name|data typed by players/i);
        expect(Object.keys(JSON.parse(b))).toEqual(["v", "agentId", "lang", "facts"]);
      }
      // A werewolf's role only ever appears in the game-over roster, when every role is public.
      for (const b of bodies) if ((JSON.parse(b) as { facts: { kind: string } }).facts.kind !== "gameOver") expect(b).not.toContain("werewolf");
      // Content the guard rejects sets the endpoint aside for the game; errors only fall back per beat.
      expect(n.stats.personaDemoted).toBe(forbidden.length > 0);
    });
  }
});

describe("endpoint agents in the store (F18-D01)", () => {
  const persona = { name: "Rogue", tagline: "", style: "x".repeat(50), examples: [], langs: ["en" as const] };

  it("keeps the signing secret encrypted", () => {
    const path = tempDbPath("ep");
    const store = new SqliteStore(path, Buffer.alloc(32, 9));
    const secret = "cd".repeat(32);
    const id = store.addEndpointAgent("0x00000000000000000000000000000000000a9e01", persona, "https://agent.example.com/gm", secret);
    expect(store.getAgent(id)).toMatchObject({ mode: "endpoint", endpoint: "https://agent.example.com/gm", status: "active" });
    expect(store.agentSecret(id)).toBe(secret);
    store.close();
    const raw = new DatabaseSync(path).prepare("SELECT secret FROM agents WHERE id = ?").get(id) as { secret: Uint8Array };
    expect(Buffer.from(raw.secret).toString("utf8")).not.toContain(secret);
    expect(Buffer.from(raw.secret).toString("hex")).not.toContain(secret);
  });

  it("upgrades a database created before endpoint agents", () => {
    const path = tempDbPath("old");
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE agents (id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, persona TEXT NOT NULL, status TEXT NOT NULL, chain_agent_id INTEGER, created_at INTEGER NOT NULL)");
    old.prepare("INSERT INTO agents (owner, persona, status, created_at) VALUES (?, ?, 'active', 0)").run("0xabc", JSON.stringify(persona));
    old.close();
    const store = new SqliteStore(path);
    expect(store.getAgent(1)).toMatchObject({ mode: "persona", endpoint: null, persona: { name: "Rogue" } });
  });
});
