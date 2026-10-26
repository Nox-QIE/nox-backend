import type { Lang } from "./i18n.js";
import { SMALL } from "./report.js";
import type { ScenarioGame } from "./store.js";

/**
 * Scam Shield sponsor report (F10-S07, F10-D04): what a sponsored season reached, in aggregate.
 * - games: finished Scam Shield games in the period, per scenario (key@version);
 * - seats: players across those games (one person in 3 games counts 3 times);
 * - groups: distinct Telegram groups that played;
 * - scams spotted: games the village won, i.e. the group voted out every scammer;
 * - Scam Spotter badges: awarded on chain (NoxBadges), when the event index is available;
 * - practice: 3-minute quizzes started and finished in a private chat (they store no one).
 * Counts only: no names, Telegram ids, group ids or wallets; a count from 1 to SMALL - 1 is shown
 * as "<3", as in the Game Night report.
 */
export interface SponsorReport {
  sponsor: string;
  period: { from: string; to: string };
  games: number;
  seats: number | null;
  groups: number | null;
  spotted: number;
  /** Percent of games where the scam was spotted, or null without games. */
  spottedRate: number | null;
  /** Scam Spotter badges (null when 1–2), and whether the event index was there to count them. */
  badges: number | null;
  badgesAvailable: boolean;
  byScenario: { scenario: string; games: number; seats: number | null; spotted: number }[];
  practice: { started: number; finished: number; completion: number | null };
}

const hide = (n: number) => (n > 0 && n < SMALL ? null : n);

export function buildSponsorReport(o: {
  sponsor: string;
  from: string;
  to: string;
  games: ScenarioGame[];
  practice: { started: number; finished: number }[];
  /** Scam Spotter badges from the event index; omit when it is not available. */
  badges?: number;
}): SponsorReport {
  const g = o.games;
  const spotted = g.filter((x) => x.winner === "village").length;
  const scenarios = [...new Set(g.map((x) => x.scenario))].sort();
  const started = o.practice.reduce((n, p) => n + p.started, 0);
  const finished = o.practice.reduce((n, p) => n + p.finished, 0);
  return {
    sponsor: o.sponsor,
    period: { from: o.from, to: o.to },
    games: g.length,
    seats: hide(g.reduce((n, x) => n + x.players, 0)),
    groups: hide(new Set(g.filter((x) => x.chatId !== null).map((x) => x.chatId)).size),
    spotted,
    spottedRate: g.length ? Math.round((100 * spotted) / g.length) : null,
    badges: o.badges === undefined ? null : hide(o.badges),
    badgesAvailable: o.badges !== undefined,
    byScenario: scenarios.map((s) => {
      const mine = g.filter((x) => x.scenario === s);
      return { scenario: s, games: mine.length, seats: hide(mine.reduce((n, x) => n + x.players, 0)), spotted: mine.filter((x) => x.winner === "village").length };
    }),
    practice: { started, finished, completion: started ? Math.round((100 * finished) / started) : null },
  };
}

const L = {
  id: {
    title: "Laporan musim Scam Shield",
    support: (s: string) => `Didukung oleh ${s}`,
    period: "Periode",
    games: "Game Scam Shield selesai",
    seats: "Kursi terisi",
    groups: "Grup Telegram yang bermain",
    spotted: "Game saat penipu berhasil dikenali (desa menang)",
    badges: "Lencana Scam Spotter (tercatat di blockchain QIE)",
    na: "belum tersedia",
    scenario: "Skenario",
    practice: "Latihan 3 menit (chat pribadi)",
    started: "dimulai",
    finished: "selesai",
    privacy: `Laporan ini hanya berisi angka gabungan: tanpa nama, ID Telegram, ID grup, atau alamat wallet. Angka 1–${SMALL - 1} ditampilkan sebagai "<${SMALL}".`,
  },
  en: {
    title: "Scam Shield season report",
    support: (s: string) => `Supported by ${s}`,
    period: "Period",
    games: "Finished Scam Shield games",
    seats: "Seats filled",
    groups: "Telegram groups that played",
    spotted: "Games where the scammers were spotted (village won)",
    badges: "Scam Spotter badges (recorded on the QIE blockchain)",
    na: "not available",
    scenario: "Scenario",
    practice: "3-minute practice (private chat)",
    started: "started",
    finished: "finished",
    privacy: `This report holds aggregate numbers only: no names, Telegram ids, group ids or wallet addresses. Counts from 1 to ${SMALL - 1} are shown as "<${SMALL}".`,
  },
} as const;

export function sponsorMarkdown(r: SponsorReport, lang: Lang): string {
  const t = L[lang];
  const cell = (v: number | null) => (v === null ? `<${SMALL}` : String(v));
  return [
    `# ${t.title}`,
    "",
    `_${t.support(r.sponsor)}_`,
    "",
    `${t.period}: ${r.period.from} – ${r.period.to}`,
    "",
    "| | |",
    "|---|---|",
    `| ${t.games} | ${r.games} |`,
    `| ${t.seats} | ${cell(r.seats)} |`,
    `| ${t.groups} | ${cell(r.groups)} |`,
    `| ${t.spotted} | ${r.spotted}${r.spottedRate === null ? "" : ` (${r.spottedRate}%)`} |`,
    `| ${t.badges} | ${r.badgesAvailable ? cell(r.badges) : t.na} |`,
    `| ${t.practice} | ${r.practice.finished} ${t.finished} / ${r.practice.started} ${t.started}${r.practice.completion === null ? "" : ` (${r.practice.completion}%)`} |`,
    "",
    `| ${t.scenario} | Game | ${t.seats} | ${t.spotted} |`,
    "|---|---|---|---|",
    ...r.byScenario.map((s) => `| ${s.scenario} | ${s.games} | ${cell(s.seats)} | ${s.spotted} |`),
    "",
    `_${t.privacy}_`,
    "",
  ].join("\n");
}
