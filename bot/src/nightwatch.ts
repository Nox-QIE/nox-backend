import { createHash } from "node:crypto";
import type { Lang } from "./i18n.js";
import type { Keyboard } from "./ports.js";

/**
 * Daily Night Watch (10.07 #7): a one-minute puzzle in a private chat, the same for everyone on a UTC
 * day. Four villagers spent the night somewhere, carrying something, with or without mud on their
 * boots; three clues, each true of the werewolf, leave exactly one suspect. Built from templates (no
 * LLM, no cost) and seeded by the date, so anyone can rebuild a day's puzzle. One answer per person
 * per day; right answers on consecutive days make a Night Watch streak. It gives no credits: those
 * are minted on chain by finished games only.
 */
export const NAMES = ["Arka", "Bayu", "Citra", "Dimas", "Elok", "Fajar", "Gita", "Hana"];
const PLACES = ["well", "mill", "forest", "market"] as const;
const ITEMS = ["lantern", "rope"] as const;
type Place = (typeof PLACES)[number];
type Item = (typeof ITEMS)[number];

export interface Suspect {
  name: string;
  place: Place;
  item: Item;
  mud: boolean;
}

type Clue = { kind: "notAt"; place: Place } | { kind: "carried"; item: Item } | { kind: "mud"; mud: boolean };

export interface Puzzle {
  day: string;
  suspects: Suspect[];
  clues: Clue[];
  /** Index of the werewolf in `suspects`. */
  answer: number;
}

const holds = (s: Suspect, c: Clue) =>
  c.kind === "notAt" ? s.place !== c.place : c.kind === "carried" ? s.item === c.item : s.mud === c.mud;

/** The puzzle of a UTC day ("2026-10-27"); deterministic, with exactly one suspect fitting all clues. */
export function puzzleOf(day: string): Puzzle {
  let n = 0;
  const rand = (max: number) => {
    const h = createHash("sha256").update(`nox-nightwatch:${day}:${n++}`).digest();
    return h.readUInt32BE(0) % max;
  };
  for (;;) {
    // Four different names and places; items and mud vary freely.
    const pick: string[] = [];
    while (pick.length < 4) {
      const name = NAMES[rand(NAMES.length)]!;
      if (!pick.includes(name)) pick.push(name);
    }
    const places = [...PLACES];
    const suspects = pick.map((name) => ({ name, place: places.splice(rand(places.length), 1)[0]!, item: ITEMS[rand(2)]!, mud: rand(2) === 1 }));
    const answer = rand(4);
    const w = suspects[answer]!;
    const pool: Clue[] = [
      { kind: "carried", item: w.item },
      { kind: "mud", mud: w.mud },
      ...PLACES.filter((p) => p !== w.place).map((place) => ({ kind: "notAt" as const, place })),
    ];
    // Three clues, true of the werewolf, that together rule out everyone else.
    for (let tries = 0; tries < 40; tries++) {
      const clues: Clue[] = [];
      while (clues.length < 3) {
        const c = pool[rand(pool.length)]!;
        if (!clues.includes(c)) clues.push(c);
      }
      // Places alone would make it a counting game: at least one clue is about the item or the boots.
      if (clues.every((c) => c.kind === "notAt")) continue;
      const fit = suspects.filter((s) => clues.every((c) => holds(s, c)));
      if (fit.length === 1) return { day, suspects, clues, answer };
    }
  }
}

const T = {
  id: {
    place: { well: "di sumur", mill: "di penggilingan", forest: "di hutan", market: "di pasar" },
    item: { lantern: "lentera", rope: "tali" },
    title: (day: string) => `🌙 <b>Night Watch</b> · ${day}\nSemalam ada yang menyerang ternak. Satu dari mereka werewolf:`,
    suspect: (s: Suspect, p: string, i: string) => `• <b>${s.name}</b>: semalam ${p}, membawa ${i}, sepatu ${s.mud ? "berlumpur" : "bersih"}`,
    clue: (c: Clue, place: Record<Place, string>, item: Record<Item, string>) =>
      c.kind === "notAt" ? `Werewolf tidak ${place[c.place]}.` : c.kind === "carried" ? `Werewolf membawa ${item[c.item]}.` : `Sepatu werewolf ${c.mud ? "berlumpur" : "bersih"}.`,
    clues: "Petunjuk:",
    ask: "Siapa werewolf-nya? Satu jawaban per hari.",
    right: (streak: number) => `✅ Betul! Streak Night Watch kamu: <b>${streak} hari</b>. Kembali besok untuk teka-teki baru.`,
    wrong: (name: string) => `❌ Bukan. Werewolf-nya <b>${name}</b>. Streak Night Watch kembali ke 0; coba lagi besok.`,
    done: "Kamu sudah menjawab Night Watch hari ini. Kembali besok!",
    stale: "Teka-teki itu sudah lewat. Ketik /nightwatch untuk teka-teki hari ini.",
  },
  en: {
    place: { well: "at the well", mill: "at the mill", forest: "in the forest", market: "at the market" },
    item: { lantern: "a lantern", rope: "a rope" },
    title: (day: string) => `🌙 <b>Night Watch</b> · ${day}\nLast night something attacked the livestock. One of them is the werewolf:`,
    suspect: (s: Suspect, p: string, i: string) => `• <b>${s.name}</b>: was ${p} last night, carried ${i}, ${s.mud ? "muddy" : "clean"} boots`,
    clue: (c: Clue, place: Record<Place, string>, item: Record<Item, string>) =>
      c.kind === "notAt" ? `The werewolf was not ${place[c.place]}.` : c.kind === "carried" ? `The werewolf carried ${item[c.item]}.` : `The werewolf's boots were ${c.mud ? "muddy" : "clean"}.`,
    clues: "Clues:",
    ask: "Who is the werewolf? One answer per day.",
    right: (streak: number) => `✅ Right! Your Night Watch streak: <b>${streak} day${streak === 1 ? "" : "s"}</b>. Come back tomorrow for a new puzzle.`,
    wrong: (name: string) => `❌ No. The werewolf was <b>${name}</b>. Your Night Watch streak is back to 0; try again tomorrow.`,
    done: "You already answered today's Night Watch. Come back tomorrow!",
    stale: "That puzzle is over. Send /nightwatch for today's.",
  },
};

/** The puzzle as a message, with one button per suspect: callback "w:<day>:<index>". */
export function puzzleMessage(p: Puzzle, lang: Lang): { text: string; keyboard: Keyboard } {
  const t = T[lang];
  const text = [
    t.title(p.day),
    ...p.suspects.map((s) => t.suspect(s, t.place[s.place], t.item[s.item])),
    "",
    t.clues,
    ...p.clues.map((c, i) => `${i + 1}. ${t.clue(c, t.place, t.item)}`),
    "",
    t.ask,
  ].join("\n");
  return { text, keyboard: [p.suspects.map((s, i) => ({ text: s.name, data: `w:${p.day}:${i}` }))] };
}

export interface NightWatchStore {
  nightWatchAnswer(userId: number, day: string): { correct: boolean } | null;
  recordNightWatch(userId: number, day: string, correct: boolean): void;
  /** Consecutive correct days ending on `day`. */
  nightWatchStreak(userId: number, day: string): number;
}

export const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

export function startNightWatch(store: NightWatchStore, userId: number, lang: Lang, now = Date.now()): { text: string; keyboard?: Keyboard } {
  const day = today(now);
  if (store.nightWatchAnswer(userId, day)) return { text: T[lang].done };
  return puzzleMessage(puzzleOf(day), lang);
}

/** A tapped answer: the reply text (right with the streak, wrong with the answer, or why it is refused). */
export function answerNightWatch(store: NightWatchStore, userId: number, day: string, choice: number, lang: Lang, now = Date.now()): string {
  if (day !== today(now)) return T[lang].stale;
  if (store.nightWatchAnswer(userId, day)) return T[lang].done;
  const p = puzzleOf(day);
  const correct = choice === p.answer;
  store.recordNightWatch(userId, day, correct);
  return correct ? T[lang].right(store.nightWatchStreak(userId, day)) : T[lang].wrong(p.suspects[p.answer]!.name);
}
