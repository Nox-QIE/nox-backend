import { randomBytes } from "node:crypto";
import { T, type Lang } from "./i18n.js";
import type { Narrator } from "./narrator.js";
import { GameRoom, type Reply, type RoomDeps } from "./room.js";

type Deps = Omit<RoomDeps, "onClosed" | "narrator"> & { narratorFor: (lang: Lang) => Narrator };

/** Tracks which users can be DMed and which room each chat and user belongs to. */
export class Registry {
  private readonly rooms = new Map<string, GameRoom>();
  private readonly byChat = new Map<number, string>();
  private readonly byUser = new Map<number, string>();
  /** Users who pressed Start (Telegram only lets bots DM them after that). Loaded from the store. */
  readonly startedUsers = new Set<number>();

  constructor(private readonly deps: Deps) {
    for (const id of deps.store?.startedUsers() ?? []) this.startedUsers.add(id);
  }

  markStarted(userId: number) {
    if (this.startedUsers.has(userId)) return;
    this.startedUsers.add(userId);
    this.deps.store?.addStartedUser(userId);
  }

  private newId(): string {
    let id: string;
    do id = randomBytes(4).toString("hex");
    while (this.rooms.has(id));
    return id;
  }

  roomOfChat(chatId: number) {
    const id = this.byChat.get(chatId);
    return id ? this.rooms.get(id) : undefined;
  }

  roomOfUser(userId: number) {
    const id = this.byUser.get(userId);
    return id ? this.rooms.get(id) : undefined;
  }

  get(roomId: string) {
    return this.rooms.get(roomId);
  }

  async create(chatId: number, hostId: number, hostName: string, lang: Lang): Promise<Reply> {
    const t = T[lang];
    if (this.byChat.has(chatId)) return { ok: false, text: t.gameExists };
    if (this.byUser.has(hostId)) return { ok: false, text: t.inOtherGame };
    if (!this.startedUsers.has(hostId)) return { ok: false, text: t.needStart(hostName, this.deps.botUsername) };
    const { narratorFor, ...rest } = this.deps;
    const room = new GameRoom(this.newId(), chatId, hostId, hostName, lang, {
      ...rest,
      narrator: narratorFor(lang),
      onClosed: (r) => this.forget(r),
    });
    this.rooms.set(room.id, room);
    this.byChat.set(chatId, room.id);
    this.byUser.set(hostId, room.id);
    await room.open();
    return { ok: true };
  }

  async join(roomId: string, userId: number, name: string): Promise<Reply> {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, text: T.en.stale };
    const t = T[room.lang];
    if (!this.startedUsers.has(userId)) return { ok: false, text: t.needStart(name, this.deps.botUsername) };
    const other = this.byUser.get(userId);
    if (other && other !== roomId) return { ok: false, text: t.inOtherGame };
    const r = await room.join(userId, name);
    if (r.ok) this.byUser.set(userId, roomId);
    return r;
  }

  private forget(room: GameRoom) {
    this.rooms.delete(room.id);
    if (this.byChat.get(room.chatId) === room.id) this.byChat.delete(room.chatId);
    for (const userId of room.players.keys()) {
      if (this.byUser.get(userId) === room.id) this.byUser.delete(userId);
    }
  }
}
