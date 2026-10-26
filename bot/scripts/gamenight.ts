/**
 * Game Night bookings (F04): quote a night for a client, check its payment on chain, list, cancel.
 * Needs no key: the client pays NoxPayments.payGameNight from their own wallet, and `sync` reads the
 * GameNightPaid event from the event index (`npm run indexer` keeps it current).
 *   npm run gamenight -- quote <chat-id|-> <start, e.g. 2026-11-07T19:00+07:00> <price> "<client>"
 *       [--token 0x… --decimals 6] [--agent <id>] [--theme horor] [--lang id|en] [--contact "@handle"]
 *   npm run gamenight -- list | show <booking> | sync | cancel <booking> "<reason>" | forget-contact <booking>
 */
import { parseUnits, type Address } from "viem";
import { checkPayment, NATIVE, newBookingId, paymentInstructions, type Booking } from "../src/bookings.js";
import { EventStore } from "../src/chain/indexer.js";
import { AGENT_TERMS, isAddress } from "../src/agents.js";
import { SqliteStore } from "../src/store.js";
import { themeIdFrom } from "../src/themes.js";

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const args = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
const [cmd, a, b, c, d] = args;
const store = new SqliteStore(process.env.NOX_DB_PATH || "data/nox.db");
const payments = process.env.NOX_PAYMENTS_ADDRESS as Address | undefined;

const line = (g: Booking) =>
  `${g.id.slice(0, 10)}…  ${g.status.padEnd(9)} ${new Date(g.startsAt).toISOString().slice(0, 16)}Z  ${g.client}${g.chatId ? `  chat ${g.chatId}` : ""}${g.theme ? `  theme ${g.theme}` : ""}${g.chainAgentId ? `  agent #${g.chainAgentId}` : ""}`;

function find(id: string | undefined): Booking {
  // A unique prefix is enough, as `list` prints only the start of each id.
  const all = id ? store.listBookings().filter((g) => g.id.toLowerCase().startsWith(id.toLowerCase())) : [];
  if (all.length !== 1) throw new Error(all.length ? `booking ${id} is ambiguous` : `no booking ${id ?? ""}`);
  return all[0]!;
}

switch (cmd) {
  case "quote": {
    if (!a || !b || !c || !d) throw new Error('usage: quote <chat-id|-> <start ISO time> <price> "<client>" [--token 0x… --decimals N] [--agent id] [--theme key] [--lang id|en] [--contact x]');
    const chatId = a === "-" ? null : Number(a);
    if (chatId !== null && !Number.isInteger(chatId)) throw new Error("chat id must be a whole number (or - when not known yet)");
    const startsAt = Date.parse(b);
    if (!Number.isFinite(startsAt) || !/[zZ]|[+-]\d{2}:?\d{2}$/.test(b)) throw new Error("start must be an ISO time with a time zone, e.g. 2026-11-07T19:00+07:00");
    const token = (flag("token") ?? NATIVE) as Address;
    if (!isAddress(token)) throw new Error("--token must be a token address");
    const decimals = Number(flag("decimals") ?? (token === NATIVE ? 18 : NaN));
    if (!Number.isInteger(decimals)) throw new Error("--decimals is required for a token (QUSDC: 6)");
    const price = parseUnits(c, decimals);
    if (price <= 0n) throw new Error("price must be above 0");
    const theme = flag("theme") ?? null;
    if (theme !== null && themeIdFrom(theme) === null) throw new Error(`unknown theme ${theme}`);
    const lang = flag("lang") ?? "id";
    if (lang !== "id" && lang !== "en") throw new Error("--lang must be id or en");
    let agentId: number | null = null;
    let chainAgentId = 0;
    if (flag("agent")) {
      const agent = store.getAgent(Number(flag("agent")));
      if (!agent || agent.status !== "active" || (agent.termsVersion ?? 0) < AGENT_TERMS.version) throw new Error(`agent ${flag("agent")} is not active with current terms`);
      // The owner's share is paid by NoxPayments, so the agent must be registered on chain.
      if (!agent.chainAgentId) throw new Error(`agent #${agent.id} is not registered on chain yet (agents.ts register ${agent.id})`);
      agentId = agent.id;
      chainAgentId = agent.chainAgentId;
    }
    const booking: Booking = {
      id: newBookingId(),
      client: d.trim(),
      contact: flag("contact") ?? null,
      chatId,
      startsAt,
      lang,
      theme,
      agentId,
      chainAgentId,
      token,
      price,
      decimals,
      status: "quoted",
      paidTx: null,
      note: null,
      createdAt: Date.now(),
    };
    store.addBooking(booking);
    console.log(`Booking ${booking.id} quoted.\n`);
    if (payments) console.log(paymentInstructions(booking, payments, lang));
    else console.log("Set NOX_PAYMENTS_ADDRESS to print the payment instructions for the client.");
    break;
  }
  case "list":
    for (const g of store.listBookings()) console.log(line(g));
    break;
  case "show": {
    const g = find(a);
    console.log(`${line(g)}\n  id ${g.id}\n  price ${g.price} (${g.decimals} decimals) token ${g.token}${g.contact ? `\n  contact ${g.contact}` : ""}${g.paidTx ? `\n  paid in ${g.paidTx}` : ""}${g.note ? `\n  note: ${g.note}` : ""}`);
    if (g.status === "quoted" && payments) console.log(`\n${paymentInstructions(g, payments, g.lang)}`);
    break;
  }
  case "sync": {
    // Quoted bookings become paid once their GameNightPaid event matches the quote.
    const index = new EventStore(process.env.NOX_INDEX_DB_PATH || "data/index.db");
    for (const g of store.listBookings().filter((x) => x.status === "quoted")) {
      const p = index.gameNightPayment(g.id);
      if (!p) continue;
      const ok = checkPayment(g, p);
      if (ok.ok) {
        store.updateBooking(g.id, { status: "paid", paidTx: p.tx });
        console.log(`${line({ ...g, status: "paid" })}  (tx ${p.tx})`);
      } else {
        store.updateBooking(g.id, { note: `payment ${p.tx} does not match: ${ok.problem}` });
        console.log(`${line(g)}  PAYMENT MISMATCH: ${ok.problem} (tx ${p.tx})`);
      }
    }
    index.close();
    break;
  }
  case "cancel": {
    const g = find(a);
    if (!b?.trim()) throw new Error('usage: cancel <booking> "<reason>"');
    store.updateBooking(g.id, { status: "cancelled", note: b.trim() });
    console.log(`${g.id} cancelled: ${b.trim()}${g.status === "paid" ? "\nIt was paid on chain: refund the client from the treasury by hand." : ""}`);
    break;
  }
  case "forget-contact": {
    const g = find(a);
    store.updateBooking(g.id, { contact: null });
    console.log(`${g.id}: contact deleted.`);
    break;
  }
  default:
    console.log("commands: quote | list | show <booking> | sync | cancel <booking> <reason> | forget-contact <booking>");
}
store.close();
