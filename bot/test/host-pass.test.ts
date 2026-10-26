import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import type { AgentRecord } from "../src/agents.js";
import { noLedger, type GameLedger } from "../src/chain/ledger.js";
import { PassReader, type PassClient } from "../src/chain/passes.js";
import { loadConfig } from "../src/config.js";
import { TemplateNarrator } from "../src/narrator.js";
import { Registry } from "../src/registry.js";
import { passReply } from "../src/telegram.js";
import { FakeMessenger, FakeScheduler } from "./fakes.js";

const PAYMENTS = "0x691304FD74F9fc06003572Cc2AE9b876Bd05EE18" as Address;

function fakeClient(expiry: Record<string, number>, price = 10n ** 18n) {
  const calls: string[] = [];
  const client: PassClient = {
    readContract: async ({ functionName, args }) => {
      calls.push(functionName);
      if (functionName === "passExpiry") return BigInt(expiry[String(args[0]).toLowerCase()] ?? 0);
      if (functionName === "priceOf") return price;
      if (functionName === "periodOf") return 30n * 86_400n;
      throw new Error(functionName);
    },
  };
  return { client, calls };
}

describe("PassReader (F03-D05, F14-D03)", () => {
  it("reads expiry, caches it briefly, and reports the offer", async () => {
    let now = 1_800_000_000_000;
    const { client, calls } = fakeClient({ "0x00000000000000000000000000000000000000aa": 1_800_100_000, "0x00000000000000000000000000000000000000bb": 1_700_000_000 });
    const r = new PassReader({ client, payments: PAYMENTS, ttlMs: 60_000, now: () => now });
    expect(await r.status("0x00000000000000000000000000000000000000AA")).toEqual({ active: true, expiresAt: 1_800_100_000 });
    expect(await r.status("0x00000000000000000000000000000000000000bb")).toEqual({ active: false, expiresAt: 1_700_000_000 }); // expired
    await r.status("0x00000000000000000000000000000000000000aa");
    expect(calls.filter((c) => c === "passExpiry")).toHaveLength(2); // second read of aa came from the cache
    now += 61_000;
    await r.status("0x00000000000000000000000000000000000000aa");
    expect(calls.filter((c) => c === "passExpiry")).toHaveLength(3);
    expect(await r.offer()).toEqual({ wei: 10n ** 18n, periodDays: 30 });
    expect(await new PassReader({ client: fakeClient({}, 0n).client, payments: PAYMENTS }).offer()).toBeNull();
  });
});

describe("premium lobby features need a Host Pass (F03-S06, F14-S05)", () => {
  const agent: AgentRecord = { id: 5, owner: "0xabc", persona: { name: "Noir", tagline: "", style: "x".repeat(50), examples: [], langs: ["en"] }, status: "active", chainAgentId: null };
  function setup(hasPass: boolean | undefined) {
    const registry = new Registry({
      messenger: new FakeMessenger(),
      scheduler: new FakeScheduler(),
      timings: { lobbyMs: 1000, nightMs: 1000, discussionMs: 1000, voteMs: 1000 },
      randomInt: () => 0,
      botUsername: "nox_test_bot",
      narratorFor: (lang) => new TemplateNarrator(lang),
      agents: () => [agent],
      ...(hasPass === undefined ? {} : { hostPass: async () => hasPass }),
    });
    for (let u = 1; u <= 13; u++) registry.startedUsers.add(u);
    return registry;
  }

  it("without a pass: Nox's own GM and up to 8 players; no theme, agent or bigger lobby", async () => {
    const registry = setup(false);
    expect((await registry.create(-2, 1, "Host", "en", { agentId: -1 })).text).toMatch(/Host Pass/); // /newgame horror
    await registry.create(-1, 1, "Host", "en");
    const room = registry.roomOfChat(-1)!;
    expect((await room.pickAgent(1, 5)).text).toMatch(/need an active Host Pass/);
    expect((await room.pickAgent(1, 0)).ok).toBe(true); // back to Nox's own GM is always fine
    for (let u = 2; u <= 8; u++) expect((await registry.join(room.id, u, `P${u}`)).ok).toBe(true);
    const ninth = await registry.join(room.id, 9, "P9");
    expect(ninth).toMatchObject({ ok: false, text: expect.stringMatching(/up to 8 players/) });
  });

  it("with a pass, or with gating off, everything is open", async () => {
    for (const pass of [true, undefined]) {
      const registry = setup(pass);
      expect((await registry.create(-1, 1, "Host", "en", { agentId: -1 })).ok).toBe(true);
      const room = registry.roomOfChat(-1)!;
      expect((await room.pickAgent(1, 5)).ok).toBe(true);
      for (let u = 2; u <= 12; u++) expect((await registry.join(room.id, u, `P${u}`)).ok).toBe(true);
    }
  });

  it("NOX_HOST_PASS=required needs the chain and the payments contract", () => {
    expect(loadConfig({ BOT_TOKEN: "1:x" }).hostPass).toBe("off");
    expect(() => loadConfig({ BOT_TOKEN: "1:x", NOX_HOST_PASS: "required" })).toThrow(/NOX_PAYMENTS_ADDRESS/);
    expect(() => loadConfig({ BOT_TOKEN: "1:x", NOX_HOST_PASS: "yes" })).toThrow(/off" or "required/);
  });
});

describe("/pass", () => {
  const ledger: GameLedger = { ...noLedger, enabled: true, addressOf: () => "0x00000000000000000000000000000000000000aa" };
  it("shows the game wallet, the pass and how to pay for it", async () => {
    const passes = new PassReader({ client: fakeClient({ "0x00000000000000000000000000000000000000aa": 1_893_456_000 }).client, payments: PAYMENTS, now: () => 1_800_000_000_000 });
    const text = await passReply({ ledger, passes, payments: PAYMENTS, explorer: "https://testnet.qie.digital", userId: 1, lang: "id" });
    expect(text).toContain("aktif sampai 2030-01-01");
    expect(text).toContain("<code>0x00000000000000000000000000000000000000aa</code>");
    expect(text).toContain("Harga: 1 QIE per 30 hari");
    expect(text).toContain(`buyPassFor(0x00000000000000000000000000000000000000aa, 1,`);
    expect(text).toContain(`https://testnet.qie.digital/address/${PAYMENTS}`);
    expect(await passReply({ ledger: noLedger, passes: null, userId: 1, lang: "en" })).toContain("not on sale yet");
    expect(text).not.toContain("rupiah"); // no rail given: on chain only
  });

  it("adds the rupiah invoice route for accounts in Indonesia (F14-D04)", async () => {
    const passes = new PassReader({ client: fakeClient({}).client, payments: PAYMENTS, now: () => 1_800_000_000_000 });
    const id = await passReply({ ledger, passes, payments: PAYMENTS, userId: 1, lang: "id", rail: "rupiah", contact: "@nox_sales" });
    expect(id).toContain("Bayar dengan rupiah: minta invoice ke @nox_sales");
    expect(id).toContain("buyPassFor("); // paying on chain stays possible
    const global = await passReply({ ledger, passes, payments: PAYMENTS, userId: 1, lang: "en", rail: "onchain" });
    expect(global).not.toContain("rupiah");
  });
});
