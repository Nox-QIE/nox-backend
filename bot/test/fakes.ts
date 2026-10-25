import type { Keyboard, Messenger, Scheduler } from "../src/ports.js";

export interface Sent {
  to: "group" | "dm";
  id: number;
  html: string;
  keyboard?: Keyboard | undefined;
}

export class FakeMessenger implements Messenger {
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

export class FakeScheduler implements Scheduler {
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
