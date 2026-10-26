import { randomBytes } from "node:crypto";
import { concat, formatUnits, keccak256, toHex, zeroAddress, type Address, type Hex } from "viem";
import type { Lang } from "./i18n.js";

/**
 * Game Night bookings (D10, F04): a client books a Nox night for their group, gets a manual quote
 * (F04-S02) and pays it on chain with NoxPayments.payGameNight (F04-S04). The booking id is the
 * contract's `bookingId`, so the GameNightPaid event says which booking was paid. The contract takes
 * any amount, so a payment only counts when token, amount and agent match the quote.
 * Rupiah bookings (F04-S03) are invoiced by hand for the MVP: once the transfer arrives, the operator
 * records the hash of the receipt on chain with recordFiatGameNight (F04-D04); the receipt itself,
 * which holds bank details, never leaves the operator.
 */
export type BookingStatus = "quoted" | "paid" | "played" | "cancelled";

export interface Booking {
  id: Hex;
  /** Client name as they want it on reports (a community, brand or office). */
  client: string;
  /** How the operator reaches the client (a Telegram handle or e-mail); optional, deleted on request. */
  contact: string | null;
  /** Telegram group the night runs in, once known. */
  chatId: number | null;
  startsAt: number;
  lang: Lang;
  /** Theme key (`horor`, `fantasi`, …) or null for Nox's default. */
  theme: string | null;
  /** Local agent id and its NoxAgentRegistry id (0 = no agent); the owner's share is paid on chain. */
  agentId: number | null;
  chainAgentId: number;
  /** Payment token (zero address = native QIE) and the quoted amount in its smallest unit. */
  token: Address;
  price: bigint;
  decimals: number;
  /** A rupiah price, invoiced by hand (token and price are then unused). */
  fiat: { currency: "IDR"; amount: number } | null;
  /** keccak256 of the payment receipt, recorded on chain for rupiah bookings. */
  receiptHash: Hex | null;
  status: BookingStatus;
  paidTx: Hex | null;
  note: string | null;
  createdAt: number;
}

export const NATIVE: Address = zeroAddress;

export const newBookingId = (): Hex => toHex(randomBytes(32));

/** A GameNightPaid event, as indexed. */
export interface GameNightPayment {
  payer: Address;
  agentId: number;
  token: Address;
  amount: bigint;
  ownerShare: bigint;
  tx: Hex;
  block: number;
  ts: number;
}

/** Whether an indexed payment settles the booking's quote; a reason when it does not. */
export function checkPayment(b: Pick<Booking, "token" | "price" | "chainAgentId" | "decimals">, p: GameNightPayment): { ok: true } | { ok: false; problem: string } {
  if (p.token.toLowerCase() !== b.token.toLowerCase()) return { ok: false, problem: `paid in token ${p.token}, quoted in ${b.token}` };
  if (p.amount < b.price) return { ok: false, problem: `paid ${formatUnits(p.amount, b.decimals)}, quoted ${formatUnits(b.price, b.decimals)}` };
  if (p.agentId !== b.chainAgentId) return { ok: false, problem: `paid for agent #${p.agentId}, quoted for #${b.chainAgentId}` };
  return { ok: true };
}

const unit = (b: Pick<Booking, "token">) => (b.token === NATIVE ? "QIE" : b.token);

/** The hash recorded on chain for a receipt: bound to the booking, so one file cannot serve two. */
export const receiptHash = (bookingId: Hex, receipt: Uint8Array): Hex => keccak256(concat([bookingId, keccak256(receipt)]));

const rupiah = (n: number) => `Rp ${n.toLocaleString("id-ID")}`;

/** What the client needs to pay a quote on chain (sent to them by the operator). */
export function paymentInstructions(b: Booking, payments: Address, lang: Lang): string {
  if (b.fiat) {
    const when = new Date(b.startsAt).toISOString().replace(".000Z", "Z");
    return lang === "id"
      ? `Penawaran Game Night Nox untuk ${b.client}\nWaktu: ${when}\nHarga: ${rupiah(b.fiat.amount)}\n\nPembayaran lewat invoice yang kami kirim terpisah. Cantumkan kode booking ini di berita transfer:\n${b.id}\n\nSetelah dana masuk, bukti pembayarannya kami catat di blockchain QIE sebagai hash (isi bukti tidak dipublikasikan).`
      : `Nox Game Night quote for ${b.client}\nTime: ${when}\nPrice: ${rupiah(b.fiat.amount)}\n\nPay with the invoice we send separately, quoting this booking code in the transfer note:\n${b.id}\n\nOnce the funds arrive, we record the payment on the QIE blockchain as a hash (the receipt itself stays private).`;
  }
  const amount = formatUnits(b.price, b.decimals);
  const when = new Date(b.startsAt).toISOString().replace(".000Z", "Z");
  const call = `payGameNight(${b.id}, ${b.chainAgentId}, ${b.token}, ${b.price})`;
  const value = b.token === NATIVE ? b.price.toString() : "0";
  const approve = b.token === NATIVE ? "" : lang === "id" ? `Sebelumnya, setujui ${b.price} token untuk ${payments} (approve).\n` : `First approve ${b.price} of the token for ${payments}.\n`;
  return lang === "id"
    ? `Penawaran Game Night Nox untuk ${b.client}\nWaktu: ${when}\nHarga: ${amount} ${unit(b)}\n\nBayar di kontrak NoxPayments ${payments}:\n${approve}${call}\nnilai (value) = ${value} wei\n\nPembayaran tercatat di blockchain QIE; kode booking di atas menghubungkannya dengan penawaran ini.`
    : `Nox Game Night quote for ${b.client}\nTime: ${when}\nPrice: ${amount} ${unit(b)}\n\nPay on the NoxPayments contract ${payments}:\n${approve}${call}\nvalue = ${value} wei\n\nThe payment is recorded on the QIE blockchain; the booking code above links it to this quote.`;
}
