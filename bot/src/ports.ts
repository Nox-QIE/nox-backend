/** Thin interfaces so the game room can run against Telegram or a test double. */

export interface Button {
  text: string;
  data: string;
}

export type Keyboard = Button[][];

export interface Messenger {
  /** Send a message to a group chat. Returns the message id. */
  sendGroup(chatId: number, html: string, keyboard?: Keyboard): Promise<number>;
  /** Edit an earlier group message; resolves false if editing failed. */
  editGroup(chatId: number, messageId: number, html: string, keyboard?: Keyboard): Promise<boolean>;
  /** DM a user. Resolves false when the user never pressed Start (bot cannot DM them). */
  sendDM(userId: number, html: string, keyboard?: Keyboard): Promise<boolean>;
}

export interface Scheduler {
  /** Run `fn` after `ms`. Returns a cancel function. */
  schedule(ms: number, fn: () => void): () => void;
}

export const realScheduler: Scheduler = {
  schedule(ms, fn) {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};

export interface Timings {
  lobbyMs: number;
  nightMs: number;
  discussionMs: number;
  voteMs: number;
}

export const DEFAULT_TIMINGS: Timings = {
  lobbyMs: 120_000,
  nightMs: 60_000,
  discussionMs: 90_000,
  voteMs: 45_000,
};
