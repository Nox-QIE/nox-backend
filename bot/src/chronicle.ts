import type { Role } from "@nox/shared/engine";
import { esc, type Lang } from "./i18n.js";

/**
 * Chronicle (10.07 #2): a group's own history of Nox games, so each game continues a story instead of
 * standing alone. At the end of a game the bot keeps one row per player for that group: the wallet,
 * the display name shown in the group, the role, whether they won, and whether the village voted them
 * out or the wolves took them at night. All of it was public in the group already; roles are public
 * on chain after the reveal. /forget deletes a player's rows.
 */
export interface ChronicleRow {
  chatId: number;
  gameId: string;
  endedAt: number;
  /** The game wallet (or "local:<id>" without a chain, for development). */
  player: string;
  name: string;
  role: Role;
  won: boolean;
  votedOut: boolean;
  killed: boolean;
  /** The game's language, for the group's weekly recap. */
  lang: Lang;
}

const plural = (n: number, en: string) => `${n} ${en}${n === 1 ? "" : "s"}`;

/** Per player over the given rows (latest name wins). */
function tally(rows: ChronicleRow[]) {
  const by = new Map<string, { name: string; games: number; wins: number; wolf: number; wolfWins: number; votedOut: number; killed: number }>();
  for (const r of [...rows].sort((a, b) => a.endedAt - b.endedAt)) {
    const t = by.get(r.player) ?? { name: r.name, games: 0, wins: 0, wolf: 0, wolfWins: 0, votedOut: 0, killed: 0 };
    t.name = r.name;
    t.games++;
    if (r.won) t.wins++;
    if (r.role === "werewolf") t.wolf++;
    if (r.role === "werewolf" && r.won) t.wolfWins++;
    if (r.votedOut) t.votedOut++;
    if (r.killed) t.killed++;
    by.set(r.player, t);
  }
  return by;
}

/** Consecutive wins up to a player's latest game in the group. */
function winStreak(rows: ChronicleRow[], player: string) {
  const mine = rows.filter((r) => r.player === player).sort((a, b) => b.endedAt - a.endedAt);
  let n = 0;
  for (const r of mine) {
    if (!r.won) break;
    n++;
  }
  return n;
}

/**
 * Up to three facts about the players about to play, from the group's past games: how often someone
 * was the werewolf, a winning streak, who the village keeps voting out. Nothing when the group is new.
 */
export function chronicleFacts(history: ChronicleRow[], players: string[], lang: Lang): string[] {
  const games = new Set(history.map((r) => r.gameId)).size;
  if (!games) return [];
  const t = tally(history);
  const here = players.filter((p) => t.has(p));
  const facts: { score: number; text: string }[] = [];
  for (const p of here) {
    const x = t.get(p)!;
    const name = `<b>${esc(x.name)}</b>`;
    const streak = winStreak(history, p);
    if (x.wolf >= 2) facts.push({ score: x.wolf * 2, text: lang === "id" ? `${name} sudah ${x.wolf}× jadi werewolf di grup ini.` : `${name} has been the werewolf ${x.wolf} times in this group.` });
    if (streak >= 2) facts.push({ score: streak * 3, text: lang === "id" ? `${name} menang ${streak} game berturut-turut. Ada yang bisa menghentikannya?` : `${name} has won ${streak} games in a row. Can anyone stop them?` });
    if (x.votedOut >= 2) facts.push({ score: x.votedOut * 2, text: lang === "id" ? `Warga sudah ${x.votedOut}× mengusir ${name}. Kali ini?` : `The village has voted out ${name} ${x.votedOut} times. This time?` });
    if (x.killed >= 2) facts.push({ score: x.killed, text: lang === "id" ? `Werewolf sudah ${x.killed}× mengincar ${name} di malam hari.` : `The wolves have come for ${name} ${x.killed} times at night.` });
  }
  const opening = lang === "id" ? `Ini game ke-${games + 1} grup ini.` : `This is the group's game number ${games + 1}.`;
  return [opening, ...facts.sort((a, b) => b.score - a.score).slice(0, 2).map((f) => f.text)];
}

/** /chronicle: the group's history so far. */
export function chronicleSummary(history: ChronicleRow[], lang: Lang): string {
  const games = new Set(history.map((r) => r.gameId)).size;
  if (!games) return lang === "id" ? "📜 Chronicle grup ini masih kosong. Mainkan game pertama dengan /newgame!" : "📜 This group's Chronicle is empty. Play the first game with /newgame!";
  const t = [...tally(history).values()];
  const top = t.sort((a, b) => b.wins - a.wins || b.games - a.games).slice(0, 5);
  const wolf = [...t].sort((a, b) => b.wolfWins - a.wolfWins)[0];
  const lines = top.map((x, i) => (lang === "id" ? `${i + 1}. ${esc(x.name)}: ${x.wins} menang dari ${x.games} game` : `${i + 1}. ${esc(x.name)}: ${x.wins} wins in ${plural(x.games, "game")}`));
  return [
    lang === "id" ? `📜 <b>Chronicle</b>: ${games} game sejauh ini` : `📜 <b>Chronicle</b>: ${plural(games, "game")} so far`,
    ...lines,
    wolf && wolf.wolfWins > 0 ? (lang === "id" ? `🐺 Werewolf paling licin: <b>${esc(wolf.name)}</b> (${wolf.wolfWins}× menang sebagai werewolf)` : `🐺 Slyest werewolf: <b>${esc(wolf.name)}</b> (${wolf.wolfWins} wins as the werewolf)`) : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The ISO week ("2026-W44") of a time, Monday start. */
export function isoWeekOf(ms: number): string {
  const d = new Date(ms);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const week = Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** The weekly recap of one group's games in one ISO week, or null without games that week. */
export function weeklyRecap(rows: ChronicleRow[], week: string, lang: Lang): string | null {
  const mine = rows.filter((r) => isoWeekOf(r.endedAt) === week);
  const games = new Set(mine.map((r) => r.gameId)).size;
  if (!games) return null;
  const t = [...tally(mine).values()];
  const mvp = [...t].sort((a, b) => b.wins - a.wins || b.games - a.games)[0]!;
  const wolf = [...t].filter((x) => x.wolfWins > 0).sort((a, b) => b.wolfWins - a.wolfWins)[0];
  const suspect = [...t].filter((x) => x.votedOut > 0).sort((a, b) => b.votedOut - a.votedOut)[0];
  const id = lang === "id";
  return [
    id ? `📜 <b>Recap minggu ${week}</b>: ${games} game dimainkan` : `📜 <b>Week ${week} recap</b>: ${plural(games, "game")} played`,
    id ? `🏆 MVP: <b>${esc(mvp.name)}</b> (${mvp.wins} menang)` : `🏆 MVP: <b>${esc(mvp.name)}</b> (${plural(mvp.wins, "win")})`,
    wolf ? (id ? `🐺 Wolf of the Week: <b>${esc(wolf.name)}</b>` : `🐺 Wolf of the Week: <b>${esc(wolf.name)}</b>`) : "",
    suspect ? (id ? `🗳️ Paling dicurigai: <b>${esc(suspect.name)}</b> (diusir ${suspect.votedOut}×)` : `🗳️ Most suspected: <b>${esc(suspect.name)}</b> (voted out ${suspect.votedOut}×)`) : "",
    id ? "Main lagi minggu ini? /newgame" : "Play again this week? /newgame",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Monday's recaps (UTC): each group that played last ISO week gets one recap, once. */
export function dueRecaps(store: { chronicleChats(fromMs: number, toMs: number): number[]; chronicleOf(chatId: number): ChronicleRow[]; markRecap(chatId: number, week: string): boolean }, now = Date.now()): { chatId: number; text: string }[] {
  const day = Math.floor(now / 86_400_000);
  const monday = (day - ((day + 3) % 7)) * 86_400_000; // 1 Jan 1970 was a Thursday
  if (Math.floor(now / 86_400_000) * 86_400_000 !== monday) return [];
  const lastWeek = isoWeekOf(monday - 86_400_000);
  const out: { chatId: number; text: string }[] = [];
  for (const chatId of store.chronicleChats(monday - 7 * 86_400_000, monday)) {
    const rows = store.chronicleOf(chatId);
    const lang = rows.at(-1)?.lang ?? "id";
    const text = weeklyRecap(rows, lastWeek, lang);
    if (text && store.markRecap(chatId, lastWeek)) out.push({ chatId, text });
  }
  return out;
}
