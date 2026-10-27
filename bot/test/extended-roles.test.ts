import { ACTION_CODE } from "@nox/shared/crypto-spec";
import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { noLedger, type GameLedger } from "../src/chain/ledger.js";
import { TemplateNarrator } from "../src/narrator.js";
import { Registry } from "../src/registry.js";
import { FakeMessenger, FakeScheduler } from "./fakes.js";

const USERS = [11, 22, 33, 44, 55, 66, 77, 88];
const nameOf = (u: number | undefined) => (u === 11 ? "Ava" : `P${u}`);

/** An 8-player extended game, night 1 started; the ledger records every call in order. */
async function extendedGame(opts: { players?: number; link?: boolean } = {}) {
  const messenger = new FakeMessenger();
  const scheduler = new FakeScheduler();
  const calls: string[] = [];
  const ledger: GameLedger = {
    ...noLedger,
    enabled: true,
    addressOf: (u) => `0x${u.toString(16).padStart(40, "0")}` as Address,
    commitNightAction: (_g, round, user) => void calls.push(`commit:${round}:${user}`),
    recordRound: (_g, round) => void calls.push(`record:${round}`),
    finalize: (_g, _r, nights) => void calls.push(`finalize:${nights.map((n) => n.action).join(",")}`),
  };
  const registry = new Registry({
    messenger,
    scheduler,
    timings: { lobbyMs: 1000, nightMs: 1000, discussionMs: 1000, voteMs: 1000 },
    randomInt: () => 0,
    botUsername: "b",
    narratorFor: (lang) => new TemplateNarrator(lang),
    ledger,
    extendedRoles: true,
  });
  const users = USERS.slice(0, opts.players ?? 8);
  for (const u of users) registry.startedUsers.add(u);
  await registry.create(-1, 11, "Ava", "en", { extendedRoles: true });
  const room = registry.roomOfChat(-1)!;
  for (const u of users.slice(1)) await registry.join(room.id, u, `P${u}`);
  await room.start(11);
  const role = (r: string) => users.filter((u) => room.roleOf(u) === r && room.isAlive(u));
  // Cupid (7+ players) links to the seer, who survives every scenario below, unless a test links itself.
  if (opts.link !== false && role("cupid").length) await room.nightAction(role("cupid")[0]!, 1, String(role("seer")[0]));
  return { room, messenger, scheduler, calls, role, users };
}

describe("extended roles in the bot (10.07 #5)", () => {
  it("the host switches the role set in the lobby; the hunter and the witch learn what they do", async () => {
    const { role, messenger } = await extendedGame();
    expect(role("hunter")).toHaveLength(1);
    expect(role("witch")).toHaveLength(1);
    expect(messenger.dms(role("hunter")[0]!)[0]!.html).toContain("you shoot one player");
    expect(messenger.dms(role("witch")[0]!)[0]!.html).toContain("two potions");
    // The lobby showed the extended set and its toggle button.
    expect(messenger.group().some((m) => m.includes("Roles: <b>Extended</b>"))).toBe(true);
  });

  it("without NOX_EXTENDED_ROLES the lobby has no role toggle and ignores the request", async () => {
    const messenger = new FakeMessenger();
    const registry = new Registry({
      messenger,
      scheduler: new FakeScheduler(),
      timings: { lobbyMs: 1000, nightMs: 1000, discussionMs: 1000, voteMs: 1000 },
      randomInt: () => 0,
      botUsername: "b",
      narratorFor: (lang) => new TemplateNarrator(lang),
    });
    registry.startedUsers.add(11);
    await registry.create(-1, 11, "Ava", "en", { extendedRoles: true });
    const room = registry.roomOfChat(-1)!;
    expect(messenger.sent.flatMap((m) => m.keyboard?.flat() ?? []).some((b) => b.data.startsWith("r:"))).toBe(false);
    expect((await room.setRoles(11, true)).ok).toBe(false);
  });

  it("a classic lobby deals no hunter or witch, and the toggle is host-only", async () => {
    const messenger = new FakeMessenger();
    const registry = new Registry({
      messenger,
      scheduler: new FakeScheduler(),
      timings: { lobbyMs: 1000, nightMs: 1000, discussionMs: 1000, voteMs: 1000 },
      randomInt: () => 0,
      botUsername: "b",
      narratorFor: (lang) => new TemplateNarrator(lang),
      extendedRoles: true,
    });
    for (const u of USERS) registry.startedUsers.add(u);
    await registry.create(-1, 11, "Ava", "en");
    const room = registry.roomOfChat(-1)!;
    expect(messenger.sent[0]!.keyboard!.flat().map((b) => b.data)).toContain(`r:${room.id}`);
    expect((await room.setRoles(22)).ok).toBe(false);
    expect(await room.setRoles(11)).toEqual({ ok: true, text: "Extended roles: the Hunter and the Witch join." });
    expect(await room.setRoles(11)).toEqual({ ok: true, text: "Classic roles." });
    for (const u of USERS.slice(1)) await registry.join(room.id, u, `P${u}`);
    await room.start(11);
    expect(USERS.some((u) => room.roleOf(u) === "hunter" || room.roleOf(u) === "witch")).toBe(false);
  });

  it("the witch hears the victim once the wolves chose, and her heal saves them", async () => {
    const { room, messenger, role } = await extendedGame();
    const [w1, w2] = role("werewolf");
    const witch = role("witch")[0]!;
    const victim = role("villager")[0]!;
    // Night prompt: poison targets plus a pass button.
    const prompt = messenger.dms(witch).at(-1)!;
    expect(prompt.html).toContain("Poison");
    expect(prompt.keyboard!.flat().at(-1)!.data).toBe(`n:${room.id}:1:0:x`);
    await room.nightAction(w1!, 1, String(victim));
    expect(messenger.dms(witch).some((m) => m.html.includes("werewolves chose <b>"))).toBe(false);
    await room.nightAction(w2!, 1, String(victim));
    const told = messenger.dms(witch).at(-1)!;
    expect(told.html).toContain(`werewolves chose <b>${nameOf(victim)}</b>`);
    expect(told.keyboard![0]![0]!.data).toBe(`n:${room.id}:1:${victim}:h`);
    await room.nightAction(witch, 1, String(victim), "h");
    await room.nightAction(role("seer")[0]!, 1, String(w1));
    await room.nightAction(role("doctor")[0]!, 1, String(role("doctor")[0])); // everyone acted: morning
    expect(room.isAlive(victim)).toBe(true);
    expect(messenger.group().some((m) => m.includes("discuss") || m.includes("Discuss"))).toBe(true);
  });

  it("the witch's poison kills and is announced; a pass ends her part of the night", async () => {
    const { room, messenger, role } = await extendedGame();
    const [w1, w2] = role("werewolf");
    const witch = role("witch")[0]!;
    const victim = role("villager")[0]!;
    await room.nightAction(witch, 1, String(w1), "p");
    await room.nightAction(w1!, 1, String(victim));
    await room.nightAction(w2!, 1, String(victim));
    await room.nightAction(role("seer")[0]!, 1, String(w1));
    await room.nightAction(role("doctor")[0]!, 1, String(witch));
    expect(room.isAlive(w1!)).toBe(false);
    expect(room.isAlive(victim)).toBe(false);
    expect(messenger.group().some((m) => m.startsWith(`☠️ ${nameOf(w1)} was also found dead`) && m.includes("Werewolf"))).toBe(true);
    // Night 2: heal only left. Passing counts as her move, so the night ends without the timer.
    const extended = await extendedGame();
    const x = extended.role;
    await extended.room.nightAction(x("witch")[0]!, 1, "0", "x");
    for (const w of x("werewolf")) await extended.room.nightAction(w, 1, String(x("villager")[0]));
    await extended.room.nightAction(x("seer")[0]!, 1, String(x("werewolf")[0]));
    await extended.room.nightAction(x("doctor")[0]!, 1, String(x("doctor")[0]));
    expect(extended.room.isAlive(x("seer")[0]!)).toBe(true);
    expect(extended.messenger.group().some((m) => m.includes("discuss") || m.includes("Discuss"))).toBe(true);
  });

  it("a hunter taken at night shoots before the day; the shot is committed in that round", async () => {
    const { room, messenger, role, calls } = await extendedGame();
    const hunter = role("hunter")[0]!;
    const [w1, w2] = role("werewolf");
    await room.nightAction(role("witch")[0]!, 1, "0", "x");
    await room.nightAction(w1!, 1, String(hunter));
    await room.nightAction(w2!, 1, String(hunter));
    await room.nightAction(role("seer")[0]!, 1, String(w1));
    await room.nightAction(role("doctor")[0]!, 1, String(role("doctor")[0]));
    expect(messenger.group().at(-1)).toContain(`${nameOf(hunter)} was the Hunter`);
    const aim = messenger.dms(hunter).at(-1)!;
    expect(aim.html).toContain("Choose one player to shoot");
    expect(aim.keyboard!.flat().map((b) => b.data)).toContain(`h:${room.id}:1:${w1}`);
    expect((await room.vote(role("seer")[0]!, 1, String(w1))).ok).toBe(false); // no vote before the shot
    expect((await room.shoot(role("seer")[0]!, 1, String(w1))).ok).toBe(false); // only the hunter
    expect((await room.shoot(hunter, 1, String(w1))).ok).toBe(true);
    expect(room.isAlive(w1!)).toBe(false);
    expect(messenger.group().some((m) => m.startsWith(`🏹 ${nameOf(hunter)} shoots <b>${nameOf(w1)}</b>`))).toBe(true);
    expect(messenger.group().at(-1)).toMatch(/discuss/i);
    expect(calls.filter((c) => c.startsWith("commit:1:"))).toHaveLength(6); // 2 wolves, seer, doctor, cupid, the shot
    expect(calls.at(-1)).toBe(`commit:1:${hunter}`);
  });

  it("an exiled hunter who lets the timer run out shoots nobody; the round is closed after the shot", async () => {
    const { room, messenger, scheduler, role, calls } = await extendedGame();
    const hunter = role("hunter")[0]!;
    const wolves = role("werewolf");
    await room.nightAction(role("witch")[0]!, 1, "0", "x");
    for (const w of wolves) await room.nightAction(w, 1, String(role("villager")[0]));
    await room.nightAction(role("seer")[0]!, 1, String(wolves[0]));
    await room.nightAction(role("doctor")[0]!, 1, String(role("villager")[0])); // saved: all 8 alive
    await scheduler.advance(1000); // vote opens
    const alive = USERS.filter((u) => room.isAlive(u));
    for (const u of alive) await room.vote(u, 1, String(u === hunter ? wolves[0] : hunter));
    expect(room.isAlive(hunter)).toBe(false);
    expect(calls.some((c) => c === "record:1")).toBe(false); // waits for the shot
    await scheduler.advance(1000); // the hunter's timer runs out
    expect(messenger.group().some((m) => m.includes(`${nameOf(hunter)} lowers the bow`))).toBe(true);
    expect(calls.at(-1)).toBe("record:1");
    expect(messenger.group().at(-1)).toMatch(/Night 2|night/i);
  });

  it("the hunter's shot can end the game, and the reveal carries the shot", async () => {
    const { room, role, calls } = await extendedGame({ players: 6 }); // 1 wolf, seer, doctor, hunter, 2 villagers
    const hunter = role("hunter")[0]!;
    const wolf = role("werewolf")[0]!;
    await room.nightAction(wolf, 1, String(hunter));
    await room.nightAction(role("seer")[0]!, 1, String(hunter));
    await room.nightAction(role("doctor")[0]!, 1, String(role("doctor")[0]));
    await room.shoot(hunter, 1, String(wolf));
    expect(room.status).toBe("ended");
    expect(calls.at(-1)!.split(":")[1]!.split(",").map(Number).sort()).toEqual([ACTION_CODE.kill, ACTION_CODE.inspect, ACTION_CODE.protect, ACTION_CODE.shoot]);
  });

  it("cupid links on night 1, both lovers learn it, and a broken heart follows a death", async () => {
    const { room, messenger, role } = await extendedGame({ link: false });
    const cupid = role("cupid")[0]!;
    const lover = role("villager")[0]!;
    const [w1, w2] = role("werewolf");
    expect(messenger.dms(cupid).some((m) => m.html.includes("Choose one player to be your lover"))).toBe(true);
    expect((await room.nightAction(cupid, 1, String(cupid))).ok).toBe(false); // not themself
    await room.nightAction(cupid, 1, String(lover));
    await room.nightAction(role("witch")[0]!, 1, "0", "x");
    await room.nightAction(w1!, 1, String(lover));
    await room.nightAction(w2!, 1, String(lover));
    await room.nightAction(role("seer")[0]!, 1, String(w1));
    await room.nightAction(role("doctor")[0]!, 1, String(role("doctor")[0]));
    expect(messenger.dms(cupid).at(-1)!.html).toContain(`You and <b>${nameOf(lover)}</b> are now lovers`);
    expect(messenger.dms(lover).at(-1)!.html).toContain(`You and <b>${nameOf(cupid)}</b> are now lovers`);
    expect(room.isAlive(lover)).toBe(false);
    expect(room.isAlive(cupid)).toBe(false);
    expect(messenger.group().some((m) => m.startsWith(`💔 ${nameOf(cupid)} cannot live without their lover`) && m.includes("Cupid"))).toBe(true);
  });
});
