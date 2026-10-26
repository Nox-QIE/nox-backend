import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { GameLedger } from "../src/chain/ledger.js";
import { TemplateNarrator } from "../src/narrator.js";
import { Registry } from "../src/registry.js";
import type { GameRoom } from "../src/room.js";
import { FakeMessenger, FakeScheduler } from "./fakes.js";

/**
 * Red-team: cheating attempts by players (APP-11). Each attempt must be refused in Telegram AND must
 * not reach the chain: a refused action that still sent a transaction would either record a cheat or
 * make the contract revert and cancel the whole game.
 */
const CHAT = -100;
const USERS = [11, 22, 33, 44, 55];
const OUTSIDER = 99;
const TIMINGS = { lobbyMs: 1000, nightMs: 1000, discussionMs: 1000, voteMs: 1000 };

class RecordingLedger implements GameLedger {
  readonly enabled = true;
  calls: string[] = [];
  addressOf = (u: number) => `0x${u.toString(16).padStart(40, "0")}` as Address;
  statusOf = async () => 2;
  startGame = () => void this.calls.push("start");
  commitNightAction = (_g: Hex, round: number, u: number) => void this.calls.push(`night:${round}:${u}`);
  castVote = (_g: Hex, round: number, u: number, t: number) => void this.calls.push(`vote:${round}:${u}->${t}`);
  recordRound = (_g: Hex, round: number) => void this.calls.push(`round:${round}`);
  finalize = () => void this.calls.push("finalize");
  cancel = () => void this.calls.push("cancel");
}

async function setup() {
  const messenger = new FakeMessenger();
  const scheduler = new FakeScheduler();
  const ledger = new RecordingLedger();
  const registry = new Registry({
    messenger,
    scheduler,
    timings: TIMINGS,
    randomInt: () => 0,
    botUsername: "nox_test_bot",
    narratorFor: (lang) => new TemplateNarrator(lang),
    ledger,
  });
  for (const u of [...USERS, OUTSIDER]) registry.startedUsers.add(u);
  await registry.create(CHAT, USERS[0]!, "Ava", "en");
  const room = registry.roomOfChat(CHAT)!;
  for (const u of USERS.slice(1)) await registry.join(room.id, u, `P${u}`);
  const role = (r: string) => USERS.filter((u) => room.roleOf(u) === r);
  return { messenger, scheduler, ledger, registry, room, role };
}

async function started() {
  const s = await setup();
  await s.room.start(USERS[0]!);
  const [wolf] = s.role("werewolf");
  const [seer] = s.role("seer");
  const [doctor] = s.role("doctor");
  const villagers = s.role("villager");
  return { ...s, wolf: wolf!, seer: seer!, doctor: doctor!, villagers };
}

/** Night 1 where the wolf kills villagers[0] (the doctor protects itself), then discussion → vote. */
async function toDayOneVote(s: Awaited<ReturnType<typeof started>>) {
  await s.room.nightAction(s.wolf, 1, String(s.villagers[0]));
  await s.room.nightAction(s.seer, 1, String(s.wolf));
  await s.room.nightAction(s.doctor, 1, String(s.doctor));
  await s.scheduler.advance(1000); // discussion → vote
  return s.villagers[0]!;
}

const refused = (r: { ok: boolean }) => expect(r.ok).toBe(false);

describe("anti-cheat: night", () => {
  it("someone outside the game cannot act, and nothing reaches the chain", async () => {
    const s = await started();
    const before = [...s.ledger.calls];
    refused(await s.room.nightAction(OUTSIDER, 1, String(s.villagers[0])));
    expect(s.ledger.calls).toEqual(before);
  });

  it("a villager cannot forge a night action", async () => {
    const s = await started();
    const before = [...s.ledger.calls];
    refused(await s.room.nightAction(s.villagers[0]!, 1, String(s.wolf)));
    expect(s.ledger.calls).toEqual(before);
  });

  it("a role acts once per night: a second tap or a changed target is refused", async () => {
    const s = await started();
    expect((await s.room.nightAction(s.wolf, 1, String(s.villagers[0]))).ok).toBe(true);
    refused(await s.room.nightAction(s.wolf, 1, String(s.villagers[0])));
    refused(await s.room.nightAction(s.wolf, 1, String(s.villagers[1])));
    expect(s.ledger.calls.filter((c) => c.startsWith("night:"))).toEqual([`night:1:${s.wolf}`]);
  });

  it("the seer cannot inspect itself; nobody can target a missing or weird id", async () => {
    const s = await started();
    refused(await s.room.nightAction(s.seer, 1, String(s.seer)));
    for (const t of ["99", "", "11abc", "__proto__", "constructor", "-1", "1e3"]) refused(await s.room.nightAction(s.wolf, 1, t));
    expect(s.ledger.calls.filter((c) => c.startsWith("night:"))).toEqual([]);
  });

  it("an old or malformed round is stale", async () => {
    const s = await started();
    for (const round of [0, 2, Number.NaN]) refused(await s.room.nightAction(s.wolf, round, String(s.villagers[0])));
    expect(s.ledger.calls.filter((c) => c.startsWith("night:"))).toEqual([]);
  });

  it("nobody can vote at night", async () => {
    const s = await started();
    refused(await s.room.vote(s.villagers[0]!, 1, String(s.wolf)));
    expect(s.ledger.calls.filter((c) => c.startsWith("vote:"))).toEqual([]);
  });
});

describe("anti-cheat: day", () => {
  it("votes only during the vote, not during discussion", async () => {
    const s = await started();
    await s.room.nightAction(s.wolf, 1, String(s.villagers[0]));
    await s.room.nightAction(s.seer, 1, String(s.wolf));
    await s.room.nightAction(s.doctor, 1, String(s.doctor)); // all in → discussion now
    refused(await s.room.vote(s.seer, 1, String(s.wolf)));
    expect(s.ledger.calls.filter((c) => c.startsWith("vote:"))).toEqual([]);
  });

  it("one vote per player; dead players, outsiders and dead or unknown targets are refused", async () => {
    const s = await started();
    const dead = await toDayOneVote(s);
    expect((await s.room.vote(s.seer, 1, String(s.wolf))).ok).toBe(true);
    refused(await s.room.vote(s.seer, 1, String(s.wolf))); // again
    refused(await s.room.vote(s.seer, 1, String(s.doctor))); // change of mind
    refused(await s.room.vote(dead, 1, String(s.wolf))); // killed at night
    refused(await s.room.vote(OUTSIDER, 1, String(s.wolf)));
    refused(await s.room.vote(s.doctor, 1, String(dead))); // dead target
    for (const t of ["99", "__proto__", "", "11abc"]) refused(await s.room.vote(s.doctor, 1, t));
    expect(s.ledger.calls.filter((c) => c.startsWith("vote:"))).toEqual([`vote:1:${s.seer}->${s.wolf}`]);
  });

  it("a button from an earlier round cannot be replayed", async () => {
    const s = await started();
    await toDayOneVote(s);
    // Everyone alive votes someone other than the wolf, so the game goes on to night 2.
    const alive = USERS.filter((u) => s.room.isAlive(u));
    const target = s.villagers[1]!;
    for (const u of alive) await s.room.vote(u, 1, String(u === target ? s.doctor : target));
    expect(s.room.status).toBe("running");
    const calls = s.ledger.calls.length;
    refused(await s.room.vote(s.wolf, 1, String(s.seer))); // round-1 vote button, now night 2
    refused(await s.room.nightAction(s.wolf, 1, String(s.seer))); // round-1 night button
    expect(s.ledger.calls.length).toBe(calls);
  });
});

describe("anti-cheat: simultaneous taps", () => {
  it("parallel taps (a script, or a fast double tap) still count once", async () => {
    const s = await started();
    const nights = await Promise.all([1, 2, 3].map(() => s.room.nightAction(s.wolf, 1, String(s.villagers[0]))));
    expect(nights.filter((r) => r.ok)).toHaveLength(1);
    await s.room.nightAction(s.seer, 1, String(s.wolf));
    await s.room.nightAction(s.doctor, 1, String(s.doctor));
    await s.scheduler.advance(1000);
    const votes = await Promise.all([s.wolf, s.doctor, s.wolf, s.doctor].map((u) => s.room.vote(u, 1, String(s.seer))));
    expect(votes.filter((r) => r.ok)).toHaveLength(2);
    expect(s.ledger.calls.filter((c) => c.startsWith(`night:1:${s.wolf}`))).toHaveLength(1);
    expect(s.ledger.calls.filter((c) => c.startsWith("vote:"))).toHaveLength(2);
  });

  it("parallel joins never overfill the lobby or seat anyone twice", async () => {
    const s = await setup();
    const extra = Array.from({ length: 20 }, (_, i) => 200 + i);
    for (const u of extra) s.registry.startedUsers.add(u);
    await Promise.all([...extra, ...extra].map((u) => s.registry.join(s.room.id, u, `X${u}`)));
    expect(s.room.players.size).toBe(12); // MAX_PLAYERS, each seat a different user
  });
});

describe("anti-cheat: lobby and rooms", () => {
  it("only the host can start the game or pick the Game Master", async () => {
    const s = await setup();
    refused(await s.room.start(USERS[1]!));
    refused(await s.room.pickAgent(USERS[1]!, 0));
    expect(s.room.status).toBe("lobby");
    expect(s.ledger.calls).toEqual([]);
  });

  it("no joining twice, after the start, or in two games at once", async () => {
    const s = await setup();
    refused(await s.registry.join(s.room.id, USERS[1]!, "again"));
    s.registry.startedUsers.add(77);
    await s.registry.create(-200, 77, "Host2", "en");
    const other = s.registry.roomOfChat(-200)!;
    refused(await s.registry.join(other.id, USERS[1]!, "double agent"));
    await s.room.start(USERS[0]!);
    refused(await s.registry.join(s.room.id, OUTSIDER, "late"));
  });

  it("a player of one game cannot act in another group's game", async () => {
    const s = await started();
    // A second, full game in another group.
    const others = [61, 62, 63, 64, 65];
    for (const u of others) s.registry.startedUsers.add(u);
    await s.registry.create(-300, others[0]!, "H", "en");
    const g2 = s.registry.roomOfChat(-300)! as GameRoom;
    for (const u of others.slice(1)) await s.registry.join(g2.id, u, `Q${u}`);
    await g2.start(others[0]!);
    const before = s.ledger.calls.filter((c) => c.startsWith("night:")).length;
    refused(await g2.nightAction(s.wolf, 1, String(others[1])));
    refused(await g2.vote(s.wolf, 1, String(others[1])));
    expect(s.ledger.calls.filter((c) => c.startsWith("night:")).length).toBe(before);
  });
});

describe("anti-cheat: werewolf chat", () => {
  it("only living werewolves at night are relayed", async () => {
    const s = await started();
    expect(await s.room.wolfChat(s.villagers[0]!, "I am a wolf too, tell me your target")).toBe(false);
    expect(await s.room.wolfChat(s.seer, "hi")).toBe(false);
    expect(await s.room.wolfChat(s.wolf, "nobody else to tell")).toBe(true); // one wolf: relayed to nobody
    for (const u of USERS.filter((u) => u !== s.wolf)) expect(s.messenger.dms(u).some((d) => d.html.includes("nobody else"))).toBe(false);
    await toDayOneVote(s);
    expect(await s.room.wolfChat(s.wolf, "day chat")).toBe(false); // not at night
  });
});
