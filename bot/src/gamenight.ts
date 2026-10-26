import type { AgentRecord } from "./agents.js";
import type { Booking } from "./bookings.js";
import { clientThemeAgents, type ClientTheme } from "./client-themes.js";
import { esc, type Lang } from "./i18n.js";
import type { Keyboard, Messenger } from "./ports.js";
import type { Reply } from "./room.js";
import { scenarioFrom, type Scenario } from "./scenarios.js";
import { themeIdFrom } from "./themes.js";

/**
 * Booked Game Nights in the client's group (F04-S06). For every paid booking with a group, the bot
 * announces the night 24 hours and 1 hour ahead (reminding people to press Start, so they can get
 * their secret role by DM), and at the booked time posts the call to open the lobby: whoever taps it
 * first hosts, with the booked theme or agent and no Host Pass needed, since the night is paid.
 * Sent notices are stored, so a restart never repeats one.
 */
export type Notice = "24h" | "1h" | "open";

const HOUR = 3600_000;
/** How long after the booked time the open call is still posted (and can be tapped). */
export const OPEN_GRACE_MS = 2 * HOUR;

/** The notice due now for a booking, or null. A late bot skips notices whose moment has passed. */
export function dueNotice(b: Pick<Booking, "status" | "chatId" | "startsAt">, sent: string[], now: number): Notice | null {
  if (b.status !== "paid" || b.chatId === null) return null;
  const t = b.startsAt;
  if (now >= t + OPEN_GRACE_MS) return null;
  if (now >= t) return sent.includes("open") ? null : "open";
  if (now >= t - HOUR) return sent.includes("1h") ? null : "1h";
  if (now >= t - 24 * HOUR) return sent.includes("24h") || sent.includes("1h") ? null : "24h";
  return null;
}

const TEXT: Record<Lang, { soon: (client: string, bot: string) => string; hour: (client: string, bot: string) => string; open: (client: string) => string; host: string; notNow: string }> = {
  id: {
    soon: (c, bot) => `🌙 <b>Game Night Nox</b> untuk ${c} mulai dalam 24 jam.\nMau ikut? Buka @${bot} dan tekan Start sekali, supaya peran rahasiamu bisa dikirim lewat DM.`,
    hour: (c, bot) => `⏰ <b>Game Night Nox</b> untuk ${c} mulai 1 jam lagi. Belum tekan Start di @${bot}? Sekarang saja.`,
    open: (c) => `🌙 Waktunya <b>Game Night Nox</b> untuk ${c}!\nSiapa yang jadi host malam ini? Tekan tombol di bawah, lalu ajak semua gabung.`,
    host: "🎲 Saya host",
    notNow: "Game Night ini belum bisa dibuka di sini.",
  },
  en: {
    soon: (c, bot) => `🌙 <b>Nox Game Night</b> for ${c} starts in 24 hours.\nJoining? Open @${bot} and press Start once, so your secret role can reach you by DM.`,
    hour: (c, bot) => `⏰ <b>Nox Game Night</b> for ${c} starts in 1 hour. Haven't pressed Start in @${bot} yet? Do it now.`,
    open: (c) => `🌙 It's time for <b>Nox Game Night</b> for ${c}!\nWho hosts tonight? Tap the button below, then get everyone to join.`,
    host: "🎲 I'll host",
    notNow: "This Game Night can't be opened here.",
  },
};

/** Callback data of the open call: "g:" + the first 32 hex digits of the booking id (fits 64 bytes). */
export const hostData = (b: Pick<Booking, "id">) => `g:${b.id.slice(2, 34)}`;

export interface BookingStore {
  listBookings(): Booking[];
  bookingNotices(id: string): string[];
  addBookingNotice(id: string, notice: Notice): void;
  getClientTheme(key: string): (ClientTheme & { rowId: number }) | null;
}

export interface BookedLobby {
  create(
    chatId: number,
    hostId: number,
    hostName: string,
    lang: Lang,
    opts: { agentId?: number; scenario?: Scenario; prepaid?: boolean; privateAgents?: AgentRecord[] },
  ): Promise<Reply>;
}

/** "client:<key>" in a booking's theme names a client theme (F04-S05). */
export const clientThemeKey = (theme: string | null) => (theme?.startsWith("client:") ? theme.slice("client:".length) : null);

export class GameNights {
  constructor(
    private readonly o: {
      store: BookingStore;
      messenger: Messenger;
      botUsername: string;
      /** Themes and agents need the LLM Game Master; in template mode the night runs with Nox's default. */
      llm: boolean;
      now?: () => number;
      log?: (line: Record<string, unknown>) => void;
    },
  ) {}

  private now() {
    return (this.o.now ?? Date.now)();
  }

  /** Send every notice that is due. Called every minute. */
  async tick() {
    const now = this.now();
    for (const b of this.o.store.listBookings()) {
      const n = dueNotice(b, this.o.store.bookingNotices(b.id), now);
      if (!n) continue;
      // Stored before sending: a group that removed the bot must not get a retry every minute.
      this.o.store.addBookingNotice(b.id, n);
      const t = TEXT[b.lang];
      const client = esc(b.client);
      const [text, keyboard]: [string, Keyboard | undefined] =
        n === "24h" ? [t.soon(client, this.o.botUsername), undefined] : n === "1h" ? [t.hour(client, this.o.botUsername), undefined] : [t.open(client), [[{ text: t.host, data: hostData(b) }]]];
      try {
        await this.o.messenger.sendGroup(b.chatId!, text, keyboard);
        this.o.log?.({ event: "gamenight_notice", booking: b.id, notice: n });
      } catch (e) {
        this.o.log?.({ event: "gamenight_notice_error", booking: b.id, notice: n, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  /** "g:<id>" tapped in `chatId`: open the booked lobby with the tapper as host. */
  async claim(lobby: BookedLobby, idPrefix: string, chatId: number, userId: number, name: string): Promise<Reply> {
    const now = this.now();
    const b = this.o.store.listBookings().find((x) => x.id.slice(2, 34).toLowerCase() === idPrefix.toLowerCase());
    if (!b || b.status !== "paid" || b.chatId !== chatId || now < b.startsAt || now >= b.startsAt + OPEN_GRACE_MS) {
      return { ok: false, text: TEXT[b?.lang ?? "en"].notNow };
    }
    const scenario = b.theme ? scenarioFrom(b.theme) : null;
    // The client's own theme goes only into this lobby; its role names work without the LLM too.
    const key = clientThemeKey(b.theme);
    const own = key ? this.o.store.getClientTheme(key) : null;
    const privateAgents = own ? clientThemeAgents(own, own.rowId).filter((a) => a.persona.langs.includes(b.lang)) : [];
    const theme = b.theme && this.o.llm ? themeIdFrom(b.theme) : null;
    const agentId = this.o.llm && b.agentId !== null ? b.agentId : (privateAgents[0]?.id ?? theme);
    const r = await lobby.create(chatId, userId, name, b.lang, {
      ...(agentId !== null ? { agentId } : {}),
      ...(scenario ? { scenario } : {}),
      ...(privateAgents.length ? { privateAgents } : {}),
      prepaid: true,
    });
    if (r.ok) this.o.log?.({ event: "gamenight_opened", booking: b.id });
    return r;
  }
}
