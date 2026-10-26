import { randomBytes } from "node:crypto";
import { esc, T, type Lang } from "./i18n.js";
import { GameRoom, type Reply, type RoomDeps } from "./room.js";
import { safeName } from "./names.js";
import type { Scenario } from "./scenarios.js";

type Deps = Omit<RoomDeps, "onClosed">;

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

  /** Forget a player (not while they are in a game). Returns false when they are mid-game. */
  forgetUser(userId: number): boolean {
    if (this.byUser.has(userId)) return false;
    this.startedUsers.delete(userId);
    this.deps.store?.forgetUser(userId);
    return true;
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

  /**
   * `agentId` (e.g. a theme from "/newgame horor") is preselected in the lobby when available;
   * `scenario` starts a Scam Shield game ("/newgame scamshield").
   */
  async create(chatId: number, hostId: number, hostName: string, lang: Lang, opts: { agentId?: number; scenario?: Scenario } = {}): Promise<Reply> {
    const t = T[lang];
    if (this.byChat.has(chatId)) return { ok: false, text: t.gameExists };
    if (this.byUser.has(hostId)) return { ok: false, text: t.inOtherGame };
    // This reply goes to the group, so it must not echo a raw display name.
    if (!this.startedUsers.has(hostId)) return { ok: false, text: t.needStart(esc(safeName(hostName, 1, lang)), this.deps.botUsername) };
    // A theme picked with /newgame is a premium Game Master too.
    if (opts.agentId !== undefined && this.deps.hostPass && !(await this.deps.hostPass(hostId))) return { ok: false, text: t.passNeeded };
    const room = new GameRoom(
      this.newId(),
      chatId,
      hostId,
      hostName,
      lang,
      { ...this.deps, onClosed: (r) => this.forget(r) },
      opts.scenario ?? null,
    );
    this.rooms.set(room.id, room);
    this.byChat.set(chatId, room.id);
    this.byUser.set(hostId, room.id);
    await room.open();
    if (opts.agentId !== undefined) await room.pickAgent(hostId, opts.agentId);
    return { ok: true };
  }

  async join(roomId: string, userId: number, name: string): Promise<Reply> {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, text: T.en.stale };
    const t = T[room.lang];
    if (!this.startedUsers.has(userId)) return { ok: false, text: t.needStart(esc(safeName(name, room.players.size + 1, room.lang)), this.deps.botUsername) };
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
