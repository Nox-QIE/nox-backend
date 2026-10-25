import { replay } from "@nox/shared/engine";
import { describe, expect, it } from "vitest";
import { TemplateNarrator } from "../src/narrator.js";
import type { Keyboard, Messenger, Scheduler } from "../src/ports.js";
import { Registry } from "../src/registry.js";
import type { GameRoom } from "../src/room.js";

interface Sent {
  to: "group" | "dm";
  id: number;
  html: string;
  keyboard?: Keyboard | undefined;
}

class FakeMessenger implements Messenger {
  sent: Sent[] = [];
  blocked = new Set<number>();
  private nextId = 1;
  async sendGroup(chatId: number, html: string, keyboard?: Keyboard) {
    this.sent.push({ to: "group", id: chatId, html, keyboard });
    return this.nextId++;
  }
  async editGroup(chatId: number, _messageId: number, html: string, keyboard?: Keyboard) {
    this.sent.push({ to: "group", id: chatId, html, keyboard });
    return true;
  }
  async sendDM(userId: number, html: string, keyboard?: Keyboard) {
    if (this.blocked.has(userId)) return false;
    this.sent.push({ to: "dm", id: userId, html, keyboard });
    return true;
  }
  dms(userId: number) {
    return this.sent.filter((s) => s.to === "dm" && s.id === userId);
  }
  group() {
    return this.sent.filter((s) => s.to === "group").map((s) => s.html);
  }
}

class FakeScheduler implements Scheduler {
  private timers: { at: number; fn: () => void; live: boolean }[] = [];
  now = 0;
  schedule(ms: number, fn: () => void) {
    const t = { at: this.now + ms, fn, live: true };
    this.timers.push(t);
    return () => void (t.live = false);
  }
  get pending() {
    return this.timers.filter((t) => t.live).length;
  }
  /** Fire every live timer due within `ms`, then let the room's queue drain. */
  async advance(ms: number) {
    this.now += ms;
    for (const t of this.timers) {
      if (t.live && t.at <= this.now) {
        t.live = false;
        t.fn();
      }
    }
    await new Promise((r) => setTimeout(r, 0));
  }
}

const CHAT = -100;
const USERS = [11, 22, 33, 44, 55];
const NAMES: Record<number, string> = { 11: "Ava", 22: "Ben", 33: "Cy", 44: "Dee", 55: "Eli" };
const TIMINGS = { lobbyMs: 1000, nightMs: 1000, discussionMs: 1000, voteMs: 1000 };

function setup() {
  const messenger = new FakeMessenger();
  const scheduler = new FakeScheduler();
  // randomInt(n) = 0 every time → Fisher–Yates yields a fixed, known assignment.
  const registry = new Registry({
    messenger,
    scheduler,
    timings: TIMINGS,
    randomInt: () => 0,
    botUsername: "nox_test_bot",
    narratorFor: (lang) => new TemplateNarrator(lang),
  });
  for (const u of USERS) registry.startedUsers.add(u);
  return { messenger, scheduler, registry };
}

async function lobbyWithAll(registry: Registry) {
  await registry.create(CHAT, USERS[0]!, NAMES[USERS[0]!]!, "en");
  const room = registry.roomOfChat(CHAT)!;
  for (const u of USERS.slice(1)) expect((await registry.join(room.id, u, NAMES[u]!)).ok).toBe(true);
  return room;
}

const byRole = (room: GameRoom, role: string) => USERS.filter((u) => room.roleOf(u) === role);

describe("lobby", () => {
  it("refuses hosts who never pressed Start", async () => {
    const { registry } = setup();
    const r = await registry.create(CHAT, 999, "Zed", "en");
    expect(r.ok).toBe(false);
    expect(r.text).toContain("@nox_test_bot");
  });

  it("allows one game per chat and one game per user", async () => {
    const { registry } = setup();
    await registry.create(CHAT, 11, "Ava", "en");
    expect((await registry.create(CHAT, 22, "Ben", "en")).ok).toBe(false);
    expect((await registry.create(-200, 11, "Ava", "en")).ok).toBe(false);
  });

  it("only the host can start, and only with enough players", async () => {
    const { registry } = setup();
    await registry.create(CHAT, 11, "Ava", "en");
    const room = registry.roomOfChat(CHAT)!;
    await registry.join(room.id, 22, "Ben");
    expect((await room.start(22)).text).toMatch(/host/i);
    expect((await room.start(11)).text).toMatch(/at least 5/);
  });

  it("cancels on timeout with too few players and frees the chat", async () => {
    const { registry, scheduler, messenger } = setup();
    await registry.create(CHAT, 11, "Ava", "en");
    await scheduler.advance(1000);
    expect(messenger.group().at(-1)).toMatch(/Lobby closed/);
    expect(registry.roomOfChat(CHAT)).toBeUndefined();
    expect(registry.roomOfUser(11)).toBeUndefined();
  });

  it("escapes HTML in player names", async () => {
    const { registry, messenger } = setup();
    registry.startedUsers.add(77);
    await registry.create(CHAT, 77, "<b>evil</b>", "en");
    expect(messenger.group()[0]).toContain("&lt;b&gt;evil&lt;/b&gt;");
  });
});

describe("full game", () => {
  it("runs night → day → night until the village wins, and the log replays", async () => {
    const { registry, messenger, scheduler } = setup();
    const room = await lobbyWithAll(registry);
    expect((await room.start(11)).ok).toBe(true);

    // Everyone gets a role DM; nobody learns anyone else's role except wolves.
    for (const u of USERS) expect(messenger.dms(u)[0]!.html).toMatch(/Your role/);
    const [wolf] = byRole(room, "werewolf");
    const [seer] = byRole(room, "seer");
    const [doctor] = byRole(room, "doctor");
    const villagers = byRole(room, "villager");
    expect(wolf && seer && doctor && villagers.length === 2).toBeTruthy();

    // Night 1: wolf kills a villager, doctor protects themself, seer inspects the wolf.
    const victim = villagers[0]!;
    expect((await room.nightAction(wolf!, 1, String(victim))).ok).toBe(true);
    expect((await room.nightAction(doctor!, 1, String(doctor))).ok).toBe(true);
    expect((await room.nightAction(seer!, 1, String(wolf))).ok).toBe(true);

    // All night actions in → night resolves early.
    expect(messenger.dms(seer!).at(-1)!.html).toContain("is a werewolf");
    expect(messenger.group().some((h) => h.includes(`${NAMES[victim]} (🧑‍🌾 Villager) was found dead`))).toBe(true);
    expect(room.isAlive(victim)).toBe(false);

    // A stale night button no longer works.
    expect((await room.nightAction(wolf!, 1, String(seer))).ok).toBe(false);

    // Discussion → vote opens on the timer; vote buttons list alive players only.
    await scheduler.advance(1000);
    const voteMsg = messenger.sent.filter((s) => s.to === "group" && s.keyboard).at(-1)!;
    expect(voteMsg.keyboard!.length).toBe(4);
    expect(voteMsg.keyboard!.flat().every((b) => b.data.startsWith(`v:${room.id}:1:`))).toBe(true);

    // Dead players cannot vote.
    expect((await room.vote(victim, 1, String(wolf))).ok).toBe(false);

    // Every living player votes the wolf → day resolves early → village wins.
    for (const u of USERS.filter((u) => room.isAlive(u))) {
      expect((await room.vote(u, 1, String(wolf))).ok).toBe(true);
    }
    expect(room.status).toBe("ended");
    const last = messenger.group().at(-1)!;
    expect(last).toContain("Winners: <b>Village</b>");
    for (const u of USERS) expect(last).toContain(NAMES[u]!);

    // Registry forgot the room; the command log replays to the same outcome.
    expect(registry.roomOfChat(CHAT)).toBeUndefined();
    expect(scheduler.pending).toBe(0);
    const final = replay(room.log.assignments, room.log.commands);
    expect(final.state.winner).toBe("village");
  });

  it("resolves phases on timers when nobody acts", async () => {
    const { registry, messenger, scheduler } = setup();
    const room = await lobbyWithAll(registry);
    await room.start(11);
    await scheduler.advance(1000); // night ends, no kill
    expect(messenger.group().some((h) => h.includes("nobody died"))).toBe(true);
    await scheduler.advance(1000); // discussion → vote
    await scheduler.advance(1000); // vote ends with no votes
    expect(messenger.group().some((h) => h.includes("Nobody is exiled"))).toBe(true);
    expect(messenger.group().at(-1)).toMatch(/Night 2 falls/);
    expect(room.status).toBe("running");
  });

  it("relays night messages only between living wolves", async () => {
    const { registry, messenger } = setup();
    // 7 players → 2 wolves.
    for (const u of [66, 77]) registry.startedUsers.add(u);
    await registry.create(CHAT, 11, "Ava", "en");
    const room = registry.roomOfChat(CHAT)!;
    for (const u of [22, 33, 44, 55, 66, 77]) await registry.join(room.id, u, `P${u}`);
    await room.start(11);
    const wolves = [...room.players.keys()].filter((u) => room.roleOf(u) === "werewolf");
    const nonWolf = [...room.players.keys()].find((u) => room.roleOf(u) !== "werewolf")!;
    expect(wolves).toHaveLength(2);
    expect(await room.wolfChat(wolves[0]!, "take <the> seer")).toBe(true);
    expect(messenger.dms(wolves[1]!).at(-1)!.html).toContain("take &lt;the&gt; seer");
    expect(await room.wolfChat(nonWolf, "hi")).toBe(false);
  });
});
