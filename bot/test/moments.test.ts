import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { GameLedger } from "../src/chain/ledger.js";
import { rareMoments } from "../src/moments.js";
import { TemplateNarrator } from "../src/narrator.js";
import { Registry } from "../src/registry.js";
import { FakeMessenger, FakeScheduler } from "./fakes.js";

describe("rare moments (10.07 #4)", () => {
  const roles = { a: "werewolf", b: "seer", c: "doctor", d: "villager", e: "villager" } as const;
  const alive = { a: false, b: true, c: true, d: true, e: true };

  it("finds Perfect Seer, Guardian and Second Life from the revealed night actions", () => {
    const m = rareMoments({
      roles: { ...roles },
      alive,
      winner: "village",
      nights: [
        { round: 1, actor: "a", kind: "kill", target: "d" },
        { round: 1, actor: "b", kind: "inspect", target: "a" },
        { round: 1, actor: "c", kind: "protect", target: "d" },
      ],
    });
    expect(Object.fromEntries(m)).toEqual({ PERFECT_SEER: ["b"], GUARDIAN: ["c"], SECOND_LIFE: ["d"] });
  });

  it("gives nothing for a seer who missed once, a protection nobody attacked, or a lone wolf who lost", () => {
    const m = rareMoments({
      roles: { ...roles },
      alive: { ...alive, a: true },
      winner: "village",
      nights: [
        { round: 1, actor: "a", kind: "kill", target: "e" },
        { round: 1, actor: "b", kind: "inspect", target: "a" },
        { round: 2, actor: "b", kind: "inspect", target: "d" },
        { round: 1, actor: "c", kind: "protect", target: "c" },
      ],
    });
    expect(m.size).toBe(0);
  });

  it("names the Last Wolf Standing when the wolves win with one of them alive", () => {
    const m = rareMoments({ roles: { a: "werewolf", f: "werewolf", d: "villager" }, alive: { a: true, f: false, d: false }, winner: "wolves", nights: [] });
    expect(Object.fromEntries(m)).toEqual({ LAST_WOLF_STANDING: ["a"] });
  });

  it("announces the moments in the group and awards them on chain after the game", async () => {
    const awards: string[] = [];
    const ledger: GameLedger = {
      enabled: true,
      addressOf: (u) => `0x${u.toString(16).padStart(40, "0")}` as Address,
      statusOf: async () => 2,
      startGame() {},
      commitNightAction() {},
      castVote() {},
      recordRound() {},
      finalize() {},
      cancel() {},
      awardBadge: (_g: Hex, badge, ids) => void awards.push(`${badge}:${ids.join(",")}`),
    };
    const messenger = new FakeMessenger();
    const scheduler = new FakeScheduler();
    const registry = new Registry({
      messenger,
      scheduler,
      timings: { lobbyMs: 1000, nightMs: 1000, discussionMs: 1000, voteMs: 1000 },
      randomInt: () => 0,
      botUsername: "b",
      narratorFor: (lang) => new TemplateNarrator(lang),
      ledger,
    });
    const users = [11, 22, 33, 44, 55];
    for (const u of users) registry.startedUsers.add(u);
    await registry.create(-1, 11, "Ava", "en");
    const room = registry.roomOfChat(-1)!;
    for (const u of users.slice(1)) await registry.join(room.id, u, `P${u}`);
    await room.start(11);
    const role = (r: string) => users.filter((u) => room.roleOf(u) === r);
    const [wolf] = role("werewolf");
    const [seer] = role("seer");
    const [doctor] = role("doctor");
    const victim = role("villager")[0]!;
    await room.nightAction(wolf!, 1, String(victim));
    await room.nightAction(seer!, 1, String(wolf));
    await room.nightAction(doctor!, 1, String(victim));
    await scheduler.advance(1000); // discussion → vote
    const alive = users.filter((u) => room.isAlive(u));
    for (const u of alive) await room.vote(u, 1, String(u === wolf ? alive.find((x) => x !== wolf) : wolf));
    expect(room.status).toBe("ended");
    const moments = messenger.group().find((h) => h.includes("Rare moments"))!;
    expect(moments).toContain("<b>Perfect Seer</b>");
    expect(moments).toContain("<b>Guardian</b>");
    expect(moments).toContain("<b>Second Life</b>");
    expect(awards.sort()).toEqual([`GUARDIAN:${doctor}`, `PERFECT_SEER:${seer}`, `SECOND_LIFE:${victim}`].sort());
  });
});
