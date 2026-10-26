import { describe, expect, it } from "vitest";
import { NATIVE, newBookingId, type Booking } from "../src/bookings.js";
import { checkClientTheme, CLIENT_THEME_BASE, clientThemeAgents, type ClientTheme } from "../src/client-themes.js";
import { gmRef } from "../src/content.js";
import { GameNights } from "../src/gamenight.js";
import { TemplateNarrator } from "../src/narrator.js";
import { Registry } from "../src/registry.js";
import { SqliteStore } from "../src/store.js";
import { THEME_AGENTS } from "../src/themes.js";
import { FakeMessenger, FakeScheduler } from "./fakes.js";

const theme: Omit<ClientTheme, "version"> = {
  key: "qie-night",
  client: "Komunitas QIE",
  text: {
    id: {
      name: "Malam QIE",
      tagline: "Validator vs penyusup",
      style: "Narasikan seperti malam di ruang server QIE: lampu berkedip, kipas berdengung, dan bisik-bisik di kanal.",
      examples: ["Lampu server berkedip dua kali."],
      roles: { werewolf: "🕵️ Penyusup", villager: "🧑‍💻 Validator" },
    },
  },
};

describe("client themes (F04-S05, F04-D03)", () => {
  it("checks the text, allows the client's own brand, and versions saves", () => {
    expect(checkClientTheme(theme)).toEqual([]);
    const bad = checkClientTheme({ ...theme, key: "Bad Key", text: { id: { ...theme.text.id!, style: "Visit qie.example now and see the night", roles: { werewolf: "x".repeat(30), mayor: "Mayor" } as never } } });
    expect(bad.join("\n")).toMatch(/key must be/);
    expect(bad.join("\n")).toMatch(/id: style: no link/);
    expect(bad.join("\n")).toMatch(/role werewolf must be 1–24/);
    expect(bad.join("\n")).toMatch(/unknown role mayor/);
    const store = new SqliteStore(":memory:");
    expect(store.saveClientTheme(theme).version).toBe(1);
    const again = store.saveClientTheme({ ...theme, text: { id: { ...theme.text.id!, tagline: "Edisi 2" } } });
    expect(again.version).toBe(2);
    expect(store.saveClientTheme({ ...theme, text: { id: { ...theme.text.id!, tagline: "Edisi 2" } } }).version).toBe(2); // unchanged text
    expect(store.listClientThemes()).toEqual([expect.objectContaining({ key: "qie-night", version: 2, rowId: again.rowId })]);
    const [agent] = clientThemeAgents(store.getClientTheme("qie-night")!, again.rowId);
    expect(agent!.id).toBe(CLIENT_THEME_BASE - again.rowId);
    expect(gmRef(agent)).toEqual({ id: "client-theme:qie-night", version: 2, hash: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
  });

  it("appears only in the client's booked lobby, and renames the roles there", async () => {
    const store = new SqliteStore(":memory:");
    store.saveClientTheme(theme);
    const start = Date.parse("2026-11-07T12:00Z");
    const b: Booking = {
      id: newBookingId(),
      client: "Komunitas QIE",
      contact: null,
      chatId: -1001,
      startsAt: start,
      lang: "id",
      theme: "client:qie-night",
      agentId: null,
      chainAgentId: 0,
      token: NATIVE,
      price: 1n,
      decimals: 18,
      fiat: null,
      receiptHash: null,
      status: "paid",
      paidTx: null,
      note: null,
      createdAt: 0,
    };
    store.addBooking(b);
    const messenger = new FakeMessenger();
    const scheduler = new FakeScheduler();
    const registry = new Registry({
      messenger,
      scheduler,
      timings: { lobbyMs: 1000, nightMs: 1000, discussionMs: 1000, voteMs: 1000 },
      randomInt: () => 0,
      botUsername: "nox_test_bot",
      narratorFor: (lang, _persona, wording) => new TemplateNarrator(lang, wording),
      agents: () => THEME_AGENTS,
      store,
      hostPass: async () => false,
    });
    const users = [11, 22, 33, 44, 55, 66];
    users.forEach((u) => registry.markStarted(u));
    const nights = new GameNights({ store, messenger, botUsername: "nox_test_bot", llm: false, now: () => start + 60_000 });
    expect(await nights.claim(registry, b.id.slice(2, 34), -1001, 11, "Ava")).toEqual({ ok: true });
    const lobbyButtons = messenger.sent.at(-1)!.keyboard!.flat().map((x) => x.text);
    expect(lobbyButtons).toContain("✓ 🎨 Malam QIE");

    // Another group's ordinary lobby never offers it.
    await registry.create(-2002, 66, "Fay", "id");
    expect(messenger.sent.at(-1)!.keyboard!.flat().map((x) => x.text).join(" ")).not.toContain("Malam QIE");

    const room = registry.roomOfChat(-1001)!;
    for (const u of users.slice(1, 5)) await registry.join(room.id, u, `P${u}`);
    const before = messenger.sent.length;
    await room.start(11);
    const dms = messenger.sent.slice(before).filter((m) => m.to === "dm").map((m) => m.html).join("\n");
    expect(dms).toContain("Penyusup");
    expect(dms).toContain("Validator");
  });
});
