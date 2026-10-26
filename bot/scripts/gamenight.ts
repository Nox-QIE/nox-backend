/**
 * Game Night bookings (F04): quote a night for a client, check its payment on chain, list, cancel.
 * Needs no key: the client pays NoxPayments.payGameNight from their own wallet, and `sync` reads the
 * GameNightPaid event from the event index (`npm run indexer` keeps it current). Once paid, the running
 * bot announces the night in the group and opens it at the booked time (src/gamenight.ts); `sync`
 * marks it played when a game finished in that group around that time.
 *   npm run gamenight -- quote <chat-id|-> <start, e.g. 2026-11-07T19:00+07:00> <price> "<client>"
 *       [--token 0x… --decimals 6 | --idr] [--agent <id>] [--theme horor] [--lang id|en] [--contact "@handle"]
 *   npm run gamenight -- paid-idr <booking> <receipt-file> [--send]   (rupiah invoice paid: receipt hash on chain, operator key)
 *   npm run gamenight -- list | show <booking> | sync | set-chat <booking> <chat-id> | cancel <booking> "<reason>" | forget-contact <booking>
 *   npm run gamenight -- theme <client-theme.json> | themes      (client themes, F04-S05: quote with --theme client:<key>)
 */
import { parseUnits, type Address } from "viem";
import { checkPayment, NATIVE, newBookingId, paymentInstructions, receiptHash, type Booking } from "../src/bookings.js";
import { operatorFrom, recordFiatGameNightOnChain } from "../src/chain/operator.js";
import { loadChainConfig } from "../src/config.js";
import { EventStore } from "../src/chain/indexer.js";
import { AGENT_TERMS, isAddress } from "../src/agents.js";
import { SqliteStore } from "../src/store.js";
import { readFileSync } from "node:fs";
import { checkClientTheme, type ClientTheme } from "../src/client-themes.js";
import { clientThemeKey, OPEN_GRACE_MS } from "../src/gamenight.js";
import { scenarioFrom } from "../src/scenarios.js";
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
    // --idr: a rupiah price, invoiced by hand (F04-S03); otherwise QIE or a token, paid on chain.
    const idr = argv.includes("--idr");
    if (idr && flag("token")) throw new Error("--idr and --token exclude each other");
    const token = (flag("token") ?? NATIVE) as Address;
    if (!isAddress(token)) throw new Error("--token must be a token address");
    const decimals = idr ? 0 : Number(flag("decimals") ?? (token === NATIVE ? 18 : NaN));
    if (!Number.isInteger(decimals)) throw new Error("--decimals is required for a token (QUSDC: 6)");
    if (idr && !/^\d+$/.test(c)) throw new Error("a rupiah price is a whole number, e.g. 1500000");
    const price = idr ? 0n : parseUnits(c, decimals);
    if (!idr && price <= 0n) throw new Error("price must be above 0");
    const theme = flag("theme") ?? null;
    const own = clientThemeKey(theme);
    if (own !== null) {
      // A client theme belongs to one client: only that client's bookings may use it.
      const t = store.getClientTheme(own);
      if (!t) throw new Error(`no client theme ${own} (gamenight theme <file.json>)`);
      if (t.client.trim().toLowerCase() !== d.trim().toLowerCase()) throw new Error(`client theme ${own} belongs to "${t.client}"`);
      if (!t.text[(flag("lang") ?? "id") as "id" | "en"]) throw new Error(`client theme ${own} has no ${flag("lang") ?? "id"} text`);
    } else if (theme !== null && themeIdFrom(theme) === null && !scenarioFrom(theme)) throw new Error(`unknown theme or scenario ${theme}`);
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
      fiat: idr ? { currency: "IDR", amount: Number(c) } : null,
      receiptHash: null,
      status: "quoted",
      paidTx: null,
      note: null,
      createdAt: Date.now(),
    };
    store.addBooking(booking);
    console.log(`Booking ${booking.id} quoted.\n`);
    if (payments || idr) console.log(paymentInstructions(booking, payments ?? NATIVE, lang));
    else console.log("Set NOX_PAYMENTS_ADDRESS to print the payment instructions for the client.");
    break;
  }
  case "list":
    for (const g of store.listBookings()) console.log(line(g));
    break;
  case "show": {
    const g = find(a);
    console.log(`${line(g)}\n  id ${g.id}\n  price ${g.fiat ? `${g.fiat.amount} ${g.fiat.currency}` : `${g.price} (${g.decimals} decimals) token ${g.token}`}${g.receiptHash ? `\n  receipt hash ${g.receiptHash}` : ""}${g.contact ? `\n  contact ${g.contact}` : ""}${g.paidTx ? `\n  paid in ${g.paidTx}` : ""}${store.bookingNotices(g.id).length ? `\n  notices sent: ${store.bookingNotices(g.id).join(", ")}` : ""}${g.note ? `\n  note: ${g.note}` : ""}`);
    if (g.status === "quoted" && (payments || g.fiat)) console.log(`\n${paymentInstructions(g, payments ?? NATIVE, g.lang)}`);
    break;
  }
  case "sync": {
    // Quoted bookings become paid once their GameNightPaid event matches the quote.
    const index = new EventStore(process.env.NOX_INDEX_DB_PATH || "data/index.db");
    for (const g of store.listBookings().filter((x) => x.status === "quoted" && !x.fiat)) {
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
    // Paid nights whose group finished a game between 1 hour before and the end of the open window.
    for (const g of store.listBookings().filter((x) => x.status === "paid" && x.chatId !== null && Date.now() >= x.startsAt)) {
      if (store.finishedGamesOfChat(g.chatId!, g.startsAt - 3600_000, g.startsAt + OPEN_GRACE_MS + 3 * 3600_000).length) {
        store.updateBooking(g.id, { status: "played" });
        console.log(line({ ...g, status: "played" }));
      }
    }
    break;
  }
  case "cancel": {
    const g = find(a);
    if (!b?.trim()) throw new Error('usage: cancel <booking> "<reason>"');
    store.updateBooking(g.id, { status: "cancelled", note: b.trim() });
    console.log(`${g.id} cancelled: ${b.trim()}${g.status === "paid" ? "\nIt was paid on chain: refund the client from the treasury by hand." : ""}`);
    break;
  }
  case "theme": {
    if (!a) throw new Error("usage: theme <client-theme.json>");
    const t = JSON.parse(readFileSync(a, "utf8")) as Omit<ClientTheme, "version">;
    const problems = checkClientTheme(t);
    if (problems.length) {
      console.error(`Client theme rejected:\n- ${problems.join("\n- ")}`);
      process.exit(1);
    }
    const { version } = store.saveClientTheme(t);
    console.log(`Client theme ${t.key} v${version} saved for ${t.client}. Quote with --theme client:${t.key}.`);
    break;
  }
  case "themes":
    for (const t of store.listClientThemes()) console.log(`client:${t.key}  v${t.version}  ${t.client}  [${Object.keys(t.text).join(",")}]`);
    break;
  case "paid-idr": {
    // The transfer arrived: hash the receipt (it stays here) and record it with recordFiatGameNight.
    const g = find(a);
    if (!g.fiat) throw new Error(`${g.id} is not a rupiah booking`);
    if (g.status !== "quoted") throw new Error(`${g.id} is ${g.status}`);
    if (!b) throw new Error("usage: paid-idr <booking> <receipt-file> [--send]");
    const hash = receiptHash(g.id, readFileSync(b));
    console.log(`Receipt hash ${hash}`);
    if (!argv.includes("--send")) {
      console.log(`Dry run. With --send the operator records recordFiatGameNight(${g.id}, ${g.chainAgentId}, ${hash}) on chain.`);
      break;
    }
    const cfg = loadChainConfig();
    if (!cfg.paymentsAddress) throw new Error("set NOX_PAYMENTS_ADDRESS");
    const tx = await recordFiatGameNightOnChain(operatorFrom(cfg), cfg.paymentsAddress, g.id, g.chainAgentId, hash);
    store.updateBooking(g.id, { status: "paid", paidTx: tx, receiptHash: hash });
    console.log(`${line({ ...g, status: "paid" })}  (tx ${tx})`);
    break;
  }
  case "set-chat": {
    const g = find(a);
    if (!b || !Number.isInteger(Number(b))) throw new Error("usage: set-chat <booking> <telegram-chat-id>");
    store.updateBooking(g.id, { chatId: Number(b) });
    console.log(`${g.id}: group ${b}.`);
    break;
  }
  case "forget-contact": {
    const g = find(a);
    store.updateBooking(g.id, { contact: null });
    console.log(`${g.id}: contact deleted.`);
    break;
  }
  default:
    console.log("commands: quote | list | show <booking> | sync | set-chat <booking> <chat-id> | cancel <booking> <reason> | forget-contact <booking> | theme <file.json> | themes | paid-idr <booking> <receipt> [--send]");
}
store.close();
