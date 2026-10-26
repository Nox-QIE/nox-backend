import type { Abi } from "viem";
import { describe, expect, it } from "vitest";
import { checkPayment, NATIVE, newBookingId, paymentInstructions, type Booking } from "../src/bookings.js";
import { NoxPaymentsAbi } from "../src/chain/contracts.js";
import { EventIndexer, EventStore } from "../src/chain/indexer.js";
import { SqliteStore } from "../src/store.js";
import { cy, FakeChain, pay, PAYMENTS } from "./chain-fakes.js";

const e18 = 10n ** 18n;
const booking = (over: Partial<Booking> = {}): Booking => ({
  id: newBookingId(),
  client: "Komunitas QIE",
  contact: "@qie_admin",
  chatId: -1001,
  startsAt: Date.parse("2026-11-07T19:00+07:00"),
  lang: "id",
  theme: "horor",
  agentId: 3,
  chainAgentId: 7,
  token: NATIVE,
  price: 5n * e18,
  decimals: 18,
  status: "quoted",
  paidTx: null,
  note: null,
  createdAt: 1,
  ...over,
});

describe("Game Night bookings (F04)", () => {
  it("keeps bookings in the store and updates their status", () => {
    const store = new SqliteStore(":memory:");
    const b = booking();
    store.addBooking(b);
    store.addBooking(booking({ startsAt: b.startsAt - 1, client: "Kantor" }));
    expect(store.getBooking(b.id.toUpperCase().replace("0X", "0x"))).toEqual(b);
    expect(store.listBookings().map((g) => g.client)).toEqual(["Kantor", "Komunitas QIE"]);
    store.updateBooking(b.id, { status: "paid", paidTx: "0xabc", contact: null });
    expect(store.getBooking(b.id)).toMatchObject({ status: "paid", paidTx: "0xabc", contact: null, note: null, chatId: -1001 });
  });

  it("counts a payment only when token, amount and agent match the quote", () => {
    const b = booking();
    const p = { payer: cy, agentId: 7, token: NATIVE, amount: 5n * e18, ownerShare: 15n * 10n ** 17n, tx: "0x01" as const, block: 1, ts: 1 };
    expect(checkPayment(b, p)).toEqual({ ok: true });
    expect(checkPayment(b, { ...p, amount: 6n * e18 })).toEqual({ ok: true });
    expect(checkPayment(b, { ...p, amount: 1n })).toEqual({ ok: false, problem: "paid 0.000000000000000001, quoted 5" });
    expect(checkPayment(b, { ...p, agentId: 0 })).toEqual({ ok: false, problem: "paid for agent #0, quoted for #7" });
    expect(checkPayment(b, { ...p, token: "0x00000000000000000000000000000000000000c5" })).toMatchObject({ ok: false });
  });

  it("finds the GameNightPaid event of a booking in the index", async () => {
    const b = booking();
    const chain = new FakeChain();
    const index = new EventStore(":memory:");
    const indexer = new EventIndexer({ client: chain, store: index, contracts: [{ name: "NoxPayments", address: PAYMENTS, abi: NoxPaymentsAbi as Abi }], fromBlock: 100n, confirmations: 0n });
    chain.logs.push(pay("GameNightPaid", { bookingId: b.id, payer: cy, agentId: 7n, token: NATIVE, amount: 5n * e18, ownerShare: 15n * 10n ** 17n }, 120n));
    chain.head = 150n;
    await indexer.syncOnce();
    const p = index.gameNightPayment(b.id)!;
    expect(p).toMatchObject({ payer: cy, agentId: 7, token: NATIVE, amount: 5n * e18, ownerShare: 15n * 10n ** 17n, block: 120 });
    expect(checkPayment(b, p)).toEqual({ ok: true });
    expect(index.gameNightPayment(newBookingId())).toBeNull();
  });

  it("tells the client exactly what to call", () => {
    const b = booking();
    const text = paymentInstructions(b, PAYMENTS, "id");
    expect(text).toContain(`payGameNight(${b.id}, 7, ${NATIVE}, ${5n * e18})`);
    expect(text).toContain(`nilai (value) = ${5n * e18} wei`);
    expect(text).toContain("Harga: 5 QIE");
    const usdc = paymentInstructions(booking({ token: "0x00000000000000000000000000000000000000c5", price: 200_000_000n, decimals: 6 }), PAYMENTS, "en");
    expect(usdc).toContain("Price: 200 0x00000000000000000000000000000000000000c5");
    expect(usdc).toContain("First approve 200000000");
    expect(usdc).toContain("value = 0 wei");
  });
});
