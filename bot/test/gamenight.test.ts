import { describe, expect, it } from "vitest";
import { NATIVE, newBookingId, type Booking } from "../src/bookings.js";
import { dueNotice, GameNights, hostData, OPEN_GRACE_MS } from "../src/gamenight.js";
import { TemplateNarrator } from "../src/narrator.js";
import { Registry } from "../src/registry.js";
import { SqliteStore } from "../src/store.js";
import { THEME_AGENTS } from "../src/themes.js";
import { FakeMessenger, FakeScheduler } from "./fakes.js";

const H = 3600_000;
const START = Date.parse("2026-11-07T12:00Z");
const booking = (over: Partial<Booking> = {}): Booking => ({
  id: newBookingId(),
  client: "Komunitas <QIE>",
  contact: null,
  chatId: -1001,
  startsAt: START,
  lang: "id",
  theme: "horor",
  agentId: null,
  chainAgentId: 0,
  token: NATIVE,
  price: 10n ** 18n,
  decimals: 18,
  status: "paid",
  paidTx: "0x01",
  note: null,
  createdAt: 0,
  ...over,
});

describe("booked Game Night schedule (F04-S06)", () => {
  it("knows which notice is due, and skips the ones a late bot missed", () => {
    const b = booking();
    expect(dueNotice(b, [], START - 25 * H)).toBeNull();
    expect(dueNotice(b, [], START - 24 * H)).toBe("24h");
    expect(dueNotice(b, ["24h"], START - 2 * H)).toBeNull();
    expect(dueNotice(b, ["24h"], START - H)).toBe("1h");
    expect(dueNotice(b, [], START - 30 * 60_000)).toBe("1h"); // booked or restarted late: no 24h notice
    expect(dueNotice(b, ["1h"], START - 30 * 60_000)).toBeNull();
    expect(dueNotice(b, ["24h", "1h"], START)).toBe("open");
    expect(dueNotice(b, ["open"], START + 60_000)).toBeNull();
    expect(dueNotice(b, [], START + OPEN_GRACE_MS)).toBeNull();
    expect(dueNotice(booking({ status: "quoted" }), [], START)).toBeNull();
    expect(dueNotice(booking({ chatId: null }), [], START)).toBeNull();
  });

  it("announces once per notice, escaped, and posts the host button at the booked time", async () => {
    const store = new SqliteStore(":memory:");
    const b = booking();
    store.addBooking(b);
    store.addBooking(booking({ status: "quoted", chatId: -2002 }));
    const messenger = new FakeMessenger();
    let now = START - 24 * H;
    const nights = new GameNights({ store, messenger, botUsername: "nox_test_bot", llm: true, now: () => now });
    await nights.tick();
    await nights.tick();
    expect(messenger.sent).toHaveLength(1);
    expect(messenger.sent[0]).toMatchObject({ to: "group", id: -1001 });
    expect(messenger.sent[0]!.html).toContain("Komunitas &lt;QIE&gt; mulai dalam 24 jam");
    expect(messenger.sent[0]!.html).toContain("@nox_test_bot");
    now = START - H;
    await nights.tick();
    now = START;
    await nights.tick();
    await nights.tick();
    expect(messenger.sent.map((m) => m.keyboard?.flat()[0]?.data ?? null)).toEqual([null, null, hostData(b)]);
    expect(hostData(b)).toHaveLength(34);
    expect(store.bookingNotices(b.id)).toEqual(["24h", "1h", "open"]);
  });

  it("opens the booked lobby for whoever taps first, with the booked theme and no Host Pass", async () => {
    const store = new SqliteStore(":memory:");
    const b = booking();
    store.addBooking(b);
    const messenger = new FakeMessenger();
    const registry = new Registry({
      messenger,
      scheduler: new FakeScheduler(),
      timings: { lobbyMs: 1000, nightMs: 1000, discussionMs: 1000, voteMs: 1000 },
      randomInt: () => 0,
      botUsername: "nox_test_bot",
      narratorFor: (lang) => new TemplateNarrator(lang),
      agents: () => THEME_AGENTS,
      store,
      hostPass: async () => false,
    });
    for (const u of [11, 22]) registry.markStarted(u);
    let now = START - 60_000;
    const nights = new GameNights({ store, messenger, botUsername: "nox_test_bot", llm: true, now: () => now });
    const prefix = hostData(b).slice(2);
    expect((await nights.claim(registry, prefix, -1001, 11, "Ava")).ok).toBe(false); // too early
    now = START + 60_000;
    expect((await nights.claim(registry, prefix, -9999, 11, "Ava")).ok).toBe(false); // another group
    expect(await nights.claim(registry, prefix, -1001, 11, "Ava")).toEqual({ ok: true });
    const room = registry.roomOfChat(-1001)!;
    expect(room.hostId).toBe(11);
    expect(messenger.sent.at(-1)!.keyboard!.flat().map((x) => x.text)).toContain("✓ 🎨 Horor Desa");
    // The same group cannot get a second lobby, and an unpaid host still needs a pass elsewhere.
    expect((await nights.claim(registry, prefix, -1001, 22, "Ben")).ok).toBe(false);
    expect((await registry.create(-3003, 22, "Ben", "id", { agentId: THEME_AGENTS[0]!.id })).ok).toBe(false);
  });
});
