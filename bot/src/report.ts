import type { Address, Hex } from "viem";
import type { Lang } from "./i18n.js";

/**
 * Game Night engagement report for a client group (F04-S07). Metric definitions (F04-D02):
 * - games: games in the group that were finalized on chain in the period;
 * - seats: players across those games (a person playing 3 games counts 3 times);
 * - unique players: distinct player wallets (one per Telegram account; not yet one per human);
 * - verified humans: distinct players verified with QIE ID; not available until QIE ID is live;
 * - weekly active: distinct players with a finalized game in an ISO week (UTC, Monday start);
 * - returning: weekly active players who also played the ISO week right before (0 after a week with no games);
 * - weekly retention: returning ÷ the previous week's active players.
 * Privacy (F04-D05): only counts leave this module, never names, Telegram ids or wallet addresses,
 * and any count of a week's players from 1 to SMALL - 1 is shown as "<3" so nobody can be singled out
 * (0 singles out no one, so it is shown).
 */
export const SMALL = 3;

export interface ReportGame {
  gameId: Hex;
  players: Address[];
  createdTs: number;
  endedTs: number;
  rounds: number;
  credits: number;
}

export interface WeekRow {
  week: string;
  games: number;
  /** null when below SMALL (shown as "<3"). */
  active: number | null;
  /** The first week of the period has no "returning" or "retention". */
  firstWeek: boolean;
  /** null when it, or this week's players, are below SMALL. */
  returning: number | null;
  /** Percent, or null when there is no previous week or it is too small to report. */
  retention: number | null;
}

export interface EngagementReport {
  group: string;
  period: { from: string; to: string };
  games: number;
  seats: number;
  uniquePlayers: number;
  verifiedHumans: null;
  avgPlayers: number;
  avgMinutes: number;
  avgRounds: number;
  credits: number;
  weeks: WeekRow[];
  proofs: string[];
}

/** ISO week of a Unix time, e.g. "2026-W44" (weeks start on Monday; week 1 holds the first Thursday). */
export function isoWeek(ts: number): string {
  const d = new Date(ts * 1000);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7)); // the Thursday of this week
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

const hide = (n: number) => (n > 0 && n < SMALL ? null : n);
const round1 = (n: number) => Math.round(n * 10) / 10;

export function buildReport(o: { group: string; from: string; to: string; games: ReportGame[]; proofUrl?: (gameId: Hex) => string }): EngagementReport {
  const games = [...o.games].sort((a, b) => a.endedTs - b.endedTs);
  const unique = new Set(games.flatMap((g) => g.players.map((p) => p.toLowerCase())));
  const byWeek = new Map<string, { games: number; players: Set<string>; ts: number }>();
  for (const g of games) {
    const w = isoWeek(g.endedTs);
    const row = byWeek.get(w) ?? { games: 0, players: new Set<string>(), ts: g.endedTs };
    row.games++;
    for (const p of g.players) row.players.add(p.toLowerCase());
    byWeek.set(w, row);
  }
  const weeks = [...byWeek.keys()].sort();
  const n = games.length || 1;
  return {
    group: o.group,
    period: { from: o.from, to: o.to },
    games: games.length,
    seats: games.reduce((s, g) => s + g.players.length, 0),
    uniquePlayers: unique.size,
    verifiedHumans: null,
    avgPlayers: round1(games.reduce((s, g) => s + g.players.length, 0) / n),
    avgMinutes: round1(games.reduce((s, g) => s + (g.endedTs - g.createdTs) / 60, 0) / n),
    avgRounds: round1(games.reduce((s, g) => s + g.rounds, 0) / n),
    credits: games.reduce((s, g) => s + g.credits, 0),
    weeks: weeks.map((w, i) => {
      const cur = byWeek.get(w)!;
      // "The week before" is the ISO week right before, which may have had no games at all.
      const prev = i > 0 ? (byWeek.get(isoWeek(cur.ts - 7 * 86_400)) ?? { games: 0, players: new Set<string>(), ts: 0 }) : undefined;
      const returning = prev ? [...cur.players].filter((p) => prev.players.has(p)).length : 0;
      const prevSize = prev ? prev.players.size : 0;
      return {
        week: w,
        games: cur.games,
        active: hide(cur.players.size),
        firstWeek: !prev,
        returning: prev && cur.players.size >= SMALL ? hide(returning) : null,
        retention: prev && prevSize >= SMALL && cur.players.size >= SMALL ? Math.round((100 * returning) / prevSize) : null,
      };
    }),
    proofs: o.proofUrl ? games.map((g) => o.proofUrl!(g.gameId)) : [],
  };
}

const L = {
  id: {
    title: "Laporan engagement Game Night",
    period: "Periode",
    games: "Game selesai (tercatat di blockchain QIE)",
    seats: "Kursi terisi",
    unique: "Pemain unik (akun)",
    verified: "Manusia terverifikasi (QIE ID)",
    na: "belum tersedia (QIE ID belum aktif)",
    avgPlayers: "Rata-rata pemain per game",
    avgMinutes: "Rata-rata durasi game (menit)",
    avgRounds: "Rata-rata ronde per game",
    credits: "Nox Credits diberikan",
    weekly: "Per minggu",
    week: "Minggu",
    active: "Pemain aktif",
    returning: "Kembali dari minggu lalu",
    retention: "Retensi",
    proofs: "Bukti tiap game (bisa dicek siapa saja)",
    privacy: `Laporan ini hanya berisi angka gabungan: tanpa nama, ID Telegram, atau alamat wallet. Angka di bawah ${SMALL} ditampilkan sebagai "<${SMALL}".`,
    defs: "Definisi: pemain unik = akun berbeda (satu akun Telegram = satu wallet); retensi = pemain minggu ini yang juga main minggu lalu ÷ pemain minggu lalu.",
  },
  en: {
    title: "Game Night engagement report",
    period: "Period",
    games: "Finished games (recorded on the QIE blockchain)",
    seats: "Seats filled",
    unique: "Unique players (accounts)",
    verified: "Verified humans (QIE ID)",
    na: "not available yet (QIE ID not live)",
    avgPlayers: "Average players per game",
    avgMinutes: "Average game length (minutes)",
    avgRounds: "Average rounds per game",
    credits: "Nox Credits awarded",
    weekly: "By week",
    week: "Week",
    active: "Active players",
    returning: "Back from last week",
    retention: "Retention",
    proofs: "Proof of every game (anyone can check)",
    privacy: `This report holds aggregate numbers only: no names, Telegram ids or wallet addresses. Counts below ${SMALL} are shown as "<${SMALL}".`,
    defs: "Definitions: unique players = distinct accounts (one Telegram account = one wallet); retention = this week's players who also played last week ÷ last week's players.",
  },
} as const;

export function reportMarkdown(r: EngagementReport, lang: Lang): string {
  const t = L[lang];
  const cell = (v: number | null, suffix = "") => (v === null ? `<${SMALL}` : `${v}${suffix}`);
  const lines = [
    `# ${t.title}: ${r.group}`,
    "",
    `${t.period}: ${r.period.from} – ${r.period.to}`,
    "",
    `| | |`,
    `|---|---|`,
    `| ${t.games} | ${r.games} |`,
    `| ${t.seats} | ${r.seats} |`,
    `| ${t.unique} | ${r.uniquePlayers} |`,
    `| ${t.verified} | ${t.na} |`,
    `| ${t.avgPlayers} | ${r.avgPlayers} |`,
    `| ${t.avgMinutes} | ${r.avgMinutes} |`,
    `| ${t.avgRounds} | ${r.avgRounds} |`,
    `| ${t.credits} | ${r.credits} |`,
    "",
    `## ${t.weekly}`,
    "",
    `| ${t.week} | Game | ${t.active} | ${t.returning} | ${t.retention} |`,
    `|---|---|---|---|---|`,
    ...r.weeks.map(
      (w) => `| ${w.week} | ${w.games} | ${cell(w.active)} | ${w.firstWeek ? "–" : cell(w.returning)} | ${w.retention === null ? "–" : `${w.retention}%`} |`,
    ),
    "",
  ];
  if (r.proofs.length) lines.push(`## ${t.proofs}`, "", ...r.proofs.map((p) => `- ${p}`), "");
  lines.push(`_${t.privacy}_`, "", `_${t.defs}_`, "");
  return lines.join("\n");
}
