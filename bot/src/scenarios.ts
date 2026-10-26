import type { Role, Team } from "@nox/shared/engine";
import type { Persona } from "./gm/prompt.js";
import type { Lang } from "./i18n.js";
import type { Wording } from "./narrator.js";

/**
 * Scam Shield (F10): the same game rules, re-skinned as a real scam pattern so players learn to
 * spot it. Content describes warning signs and what to do, never how to run a scam (F10-S08).
 * Report channels were checked on 25 Oct 2026; recheck before every season (F10-D06).
 */
export interface ScenarioText {
  title: string;
  roles: Record<Role, string>;
  teams: Record<Team, string>;
  wording: Wording;
  /** One warning sign posted each morning, in order. */
  hints: string[];
  debrief: string;
  spotterBadge: string;
  persona: Persona;
}

export interface Scenario {
  key: string;
  /** Goes up whenever the scenario's text changes (content.lock.json enforces it). */
  version: number;
  /** When the warning signs and report channels were last checked against official sources. */
  checkedAt: string;
  /** Words accepted after /newgame. */
  keywords: string[];
  text: Record<Lang, ScenarioText>;
}

const ID_ROLES: Record<Role, string> = { werewolf: "🕵️ Penipu", seer: "🔎 Analis Fraud", doctor: "🛡️ Teman Waspada", villager: "📱 Calon Korban" };
const EN_ROLES: Record<Role, string> = { werewolf: "🕵️ Scammer", seer: "🔎 Fraud Analyst", doctor: "🛡️ Watchful Friend", villager: "📱 Target" };

export const TASK_SCAM: Scenario = {
  key: "task-scam",
  version: 1,
  checkedAt: "2026-10-25",
  keywords: ["scamshield", "antipenipuan", "tipu", "scam"],
  text: {
    id: {
      title: "Scam Shield: Misi Berbayar",
      roles: ID_ROLES,
      teams: { wolves: "Penipu", village: "Grup yang waspada" },
      wording: {
        role: (r) => ID_ROLES[r],
        team: (t) => (t === "wolves" ? "Penipu" : "Grup yang waspada"),
        intro: (names) =>
          `🛡️ <b>Scam Shield: Misi Berbayar</b>\n${names.length} anggota baru masuk ke grup "Cuan Harian": ${names.join(", ")}.\nKatanya cukup like dan follow, dibayar per tugas. Di antara kalian ada penipu yang menyamar jadi admin dan anggota. Peran rahasia sudah dikirim lewat DM.`,
        nightFalls: (round) => `🌙 Malam ${round}. Grup sepi, tapi DM mulai ramai. Peran khusus, cek DM.`,
        morningVictim: (name, role) => `🌅 Pagi. ${name} (${role}) kena tipu semalam dan keluar dari grup.`,
        morningNone: "🌅 Pagi. Tidak ada yang kena tipu semalam. Seseorang sempat diingatkan tepat waktu.",
        dayOut: (name, role) => `⚖️ Grup sepakat mengeluarkan ${name}. Ternyata ${role}.`,
        dayNone: "⚖️ Suara terpecah. Belum ada yang dikeluarkan.",
      },
      hints: [
        "🚩 Tanda bahaya: tawaran kerja datang dari orang asing lewat chat, padahal kamu tidak pernah melamar.",
        "🚩 Tanda bahaya: bayaran besar untuk tugas sepele seperti like, follow, atau memberi ulasan.",
        "🚩 Tanda bahaya: kamu dibayar kecil di awal. Itu umpan supaya kamu percaya.",
        "🚩 Tanda bahaya: diminta setor uang dulu untuk membuka \"misi premium\" atau komisi lebih besar.",
        "🚩 Tanda bahaya: uang tidak bisa ditarik kecuali bayar \"pajak\", \"biaya admin\", atau menaikkan \"skor kredit\".",
        "🚩 Tanda bahaya: grup penuh anggota yang pamer bukti transfer. Banyak di antaranya akun palsu.",
        "🚩 Tanda bahaya: didesak cepat (\"slot terbatas\", \"hari ini terakhir\") atau diminta kode OTP.",
      ],
      debrief:
        `🛡️ <b>Kartu Scam Shield: penipuan misi berbayar</b>\n` +
        `Polanya: tugas mudah dibayar kecil → kepercayaan tumbuh → diminta setor untuk misi lebih besar → uang tidak bisa ditarik.\n\n` +
        `<b>Yang perlu dilakukan</b>\n` +
        `• Jangan transfer uang untuk "membuka" pekerjaan atau komisi.\n` +
        `• Cek nomor rekening tujuan di cekrekening.id sebelum transfer apa pun.\n` +
        `• Jangan pernah membagikan kode OTP atau PIN.\n` +
        `• Sudah telanjur transfer? Segera hubungi bank-mu dan lapor ke Indonesia Anti-Scam Centre OJK (iasc.ojk.go.id). Makin cepat dilaporkan, makin besar peluang dana diblokir.\n` +
        `• Laporan lain: OJK Kontak 157, patrolisiber.id (Polri).\n\n` +
        `Kirim kartu ini ke keluarga yang sering dapat tawaran kerja lewat chat.`,
      spotterBadge: "🏅 Kamu mendapat lencana <b>Scam Spotter</b>: grupmu berhasil membongkar penipu di Scam Shield.",
      persona: {
        name: "Scam Shield",
        tagline: "Grup kerja paruh waktu yang terlalu indah untuk jadi kenyataan",
        style:
          "Ceritakan permainan sebagai grup chat \"Cuan Harian\" yang menawarkan kerja paruh waktu: like dan follow dibayar per tugas. Para Penipu menyamar jadi admin dan anggota yang pamer tangkapan layar pembayaran. Korban tidak mati: mereka kena tipu dan keluar dari grup. Nada waspada dan sedikit menegangkan. Jangan menyebut nama aplikasi, bank, atau perusahaan sungguhan, jangan menjelaskan cara menipu, dan jangan menulis ajakan atau langkah memindahkan uang.",
        examples: ["Notifikasi grup berbunyi lagi: \"Misi baru! Komisi 3x lipat, slot tinggal sedikit.\"", "Admin mengirim tangkapan layar pembayaran, terlalu rapi untuk dipercaya."],
        langs: ["id"],
      },
    },
    en: {
      title: "Scam Shield: Paid Tasks",
      roles: EN_ROLES,
      teams: { wolves: "Scammers", village: "The alert group" },
      wording: {
        role: (r) => EN_ROLES[r],
        team: (t) => (t === "wolves" ? "Scammers" : "The alert group"),
        intro: (names) =>
          `🛡️ <b>Scam Shield: Paid Tasks</b>\n${names.length} new members join the "Daily Profit" group: ${names.join(", ")}.\nJust like and follow, paid per task, they say. Scammers posing as admins and members are among you. Secret roles have been sent by DM.`,
        nightFalls: (round) => `🌙 Night ${round}. The group goes quiet, but the DMs get busy. Special roles, check your DMs.`,
        morningVictim: (name, role) => `🌅 Morning. ${name} (${role}) got scammed overnight and left the group.`,
        morningNone: "🌅 Morning. Nobody got scammed overnight. Someone was warned just in time.",
        dayOut: (name, role) => `⚖️ The group agrees to remove ${name}. They were a ${role}.`,
        dayNone: "⚖️ The vote is split. Nobody is removed yet.",
      },
      hints: [
        "🚩 Warning sign: a job offer from a stranger in a chat, when you never applied.",
        "🚩 Warning sign: big pay for trivial tasks like likes, follows or reviews.",
        "🚩 Warning sign: a small payout at the start. It is bait to earn your trust.",
        "🚩 Warning sign: you must deposit money to unlock \"premium tasks\" or higher commission.",
        "🚩 Warning sign: you cannot withdraw unless you pay a \"tax\", an \"admin fee\" or raise a \"credit score\".",
        "🚩 Warning sign: the group is full of members showing off payment screenshots. Many are fake accounts.",
        "🚩 Warning sign: pressure to act fast (\"limited slots\", \"last day\") or a request for a one-time code.",
      ],
      debrief:
        `🛡️ <b>Scam Shield card: paid task scams</b>\n` +
        `The pattern: easy tasks with small payouts → trust grows → a deposit for a bigger task → the money cannot be withdrawn.\n\n` +
        `<b>What to do</b>\n` +
        `• Never pay to "unlock" a job or a commission.\n` +
        `• Never share one-time codes or PINs.\n` +
        `• Already paid? Call your bank right away and report to the police cybercrime unit; the faster, the better the chance to freeze the money.\n` +
        `• In Indonesia: Indonesia Anti-Scam Centre (iasc.ojk.go.id), OJK Contact 157, cekrekening.id to check an account first.\n\n` +
        `Share this card with family who get job offers in chats.`,
      spotterBadge: "🏅 You earned the <b>Scam Spotter</b> badge: your group exposed the scammers in Scam Shield.",
      persona: {
        name: "Scam Shield",
        tagline: "A part-time job group that is too good to be true",
        style:
          "Tell the game as a \"Daily Profit\" group chat offering part-time work: likes and follows paid per task. The Scammers pose as admins and members showing off payment screenshots. Victims never die: they get scammed and leave the group. Alert and slightly tense tone. Never name real apps, banks or companies, never explain how to run a scam, and never write a request or steps to move money.",
        examples: ["The group pings again: \"New task! Triple commission, only a few slots left.\"", "The admin posts a payment screenshot, a little too neat to believe."],
        langs: ["en"],
      },
    },
  },
};

export const SCENARIOS: Scenario[] = [TASK_SCAM];

/** "/newgame scamshield" → scenario, or null. */
export function scenarioFrom(word: string | undefined): Scenario | null {
  const w = (word ?? "").trim().toLowerCase();
  return SCENARIOS.find((s) => s.keywords.includes(w)) ?? null;
}
