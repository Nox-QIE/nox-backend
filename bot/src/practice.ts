import type { Lang } from "./i18n.js";
import type { Keyboard } from "./ports.js";
import { TASK_SCAM } from "./scenarios.js";

/**
 * Scam Shield practice (F10-S06, F10-D05): a three-minute quiz in a private chat, opened with a link
 * anyone can share (t.me/<bot>?start=latihan), for people who will never join a game, such as parents
 * who get "paid task" offers. It needs no game wallet and stores nothing about the person: answers
 * live in memory for the quiz only; the store keeps daily counts of quizzes started and finished.
 * Content teaches warning signs and what to do, never how to scam (F10-S08).
 */
export interface PracticeItem {
  text: string;
  scam: boolean;
  why: string;
}

export const PRACTICE: Record<Lang, { intro: string; scamBtn: string; safeBtn: string; right: string; wrong: string; items: PracticeItem[]; end: (score: number, total: number, link: string) => string; groupLink: (link: string) => string }> = {
  id: {
    intro: "🛡️ <b>Latihan Scam Shield</b> (3 menit)\nBaca tiap pesan, lalu pilih: penipuan atau aman? Tidak ada data kamu yang disimpan.",
    scamBtn: "🚩 Penipuan",
    safeBtn: "✅ Aman",
    right: "Betul.",
    wrong: "Kurang tepat.",
    items: [
      { text: "Pesan dari nomor tak dikenal: \"Kak, mau kerja paruh waktu? Cukup like video, dibayar Rp 50 ribu per tugas.\"", scam: true, why: "Tawaran kerja yang datang sendiri, bayaran besar untuk tugas sepele." },
      { text: "Setelah tiga tugas kamu benar-benar dibayar Rp 150 ribu. Admin: \"Sekarang misi premium, komisi 3x lipat. Setor Rp 500 ribu dulu ya.\"", scam: true, why: "Bayaran kecil di awal adalah umpan. Diminta setor untuk membuka misi = pola misi berbayar." },
      { text: "Teman lama mengajak main game tebak peran di grup. Botnya tidak pernah minta uang, OTP, atau seed phrase.", scam: false, why: "Tidak ada permintaan uang atau kode. Tetap waspada, tapi ini bukan pola penipuan." },
      { text: "Grup \"Cuan Harian\" penuh tangkapan layar bukti transfer dan anggota yang bilang \"sudah cair!\".", scam: true, why: "Testimoni dan bukti transfer di grup seperti ini sering dari akun palsu." },
      { text: "Komisi kamu Rp 2 juta, tapi baru bisa ditarik setelah bayar \"pajak penarikan\" 10%.", scam: true, why: "Uang yang tidak bisa ditarik kecuali bayar biaya dulu adalah ciri penipuan." },
      { text: "\"Admin\" minta kode OTP yang masuk ke HP kamu supaya akun bisa \"diverifikasi\".", scam: true, why: "Jangan pernah membagikan OTP atau PIN kepada siapa pun." },
    ],
    end: (score, total, link) =>
      `Skor kamu: <b>${score}/${total}</b>\n\n${TASK_SCAM.text.id.debrief}\n\nKirim latihan ini ke keluarga: ${link}`,
    groupLink: (link) => `🛡️ Latihan Scam Shield 3 menit, bisa dikirim ke keluarga lewat WA: ${link}`,
  },
  en: {
    intro: "🛡️ <b>Scam Shield practice</b> (3 minutes)\nRead each message, then choose: scam or safe? Nothing about you is stored.",
    scamBtn: "🚩 Scam",
    safeBtn: "✅ Safe",
    right: "Right.",
    wrong: "Not quite.",
    items: [
      { text: "A message from an unknown number: \"Want a part-time job? Just like videos, paid 50k per task.\"", scam: true, why: "A job offer you never applied for, with big pay for a trivial task." },
      { text: "After three tasks you really were paid 150k. The admin: \"Now a premium mission, triple commission. Deposit 500k first.\"", scam: true, why: "Small early payouts are bait. A deposit to unlock missions is the paid-task scam pattern." },
      { text: "An old friend invites you to a role-guessing game in a group. The bot never asks for money, codes or a seed phrase.", scam: false, why: "No request for money or codes. Stay alert, but this is not a scam pattern." },
      { text: "A \"Daily Profit\" group is full of payment screenshots and members saying \"I got paid!\".", scam: true, why: "Testimonials and payment screenshots in such groups often come from fake accounts." },
      { text: "Your commission is 2 million, but you can only withdraw it after paying a 10% \"withdrawal tax\".", scam: true, why: "Money you can only withdraw after paying a fee first is a sign of a scam." },
      { text: "An \"admin\" asks for the one-time code sent to your phone to \"verify\" your account.", scam: true, why: "Never share one-time codes or PINs with anyone." },
    ],
    end: (score, total, link) => `Your score: <b>${score}/${total}</b>\n\n${TASK_SCAM.text.en.debrief}\n\nSend this practice to your family: ${link}`,
    groupLink: (link) => `🛡️ A 3-minute Scam Shield practice you can forward to family: ${link}`,
  },
};

/** Words accepted after /start (the deep link payload). */
export const PRACTICE_PAYLOADS = ["latihan", "practice"];

export const practiceLink = (botUsername: string, lang: Lang) => `https://t.me/${botUsername}?start=${lang === "id" ? "latihan" : "practice"}`;

export interface PracticeCounts {
  practiceStarted(): void;
  practiceFinished(): void;
}

/** One quiz per user, in memory; it expires after 30 minutes. Callback data: "q:<item>:<s|k>". */
export class Practice {
  private readonly sessions = new Map<number, { lang: Lang; item: number; score: number; at: number }>();

  constructor(private readonly o: { botUsername: string; counts?: PracticeCounts; now?: () => number }) {}

  private keyboard(lang: Lang, item: number): Keyboard {
    const t = PRACTICE[lang];
    return [[{ text: t.scamBtn, data: `q:${item}:s` }, { text: t.safeBtn, data: `q:${item}:k` }]];
  }

  start(userId: number, lang: Lang): { text: string; keyboard: Keyboard } {
    this.prune();
    this.sessions.set(userId, { lang, item: 0, score: 0, at: (this.o.now ?? Date.now)() });
    this.o.counts?.practiceStarted();
    const t = PRACTICE[lang];
    return { text: `${t.intro}\n\n<b>1/${t.items.length}</b> ${t.items[0]!.text}`, keyboard: this.keyboard(lang, 0) };
  }

  /** Returns null for a stale button (old item, or no quiz running). */
  answer(userId: number, item: number, choice: "s" | "k"): { text: string; keyboard?: Keyboard } | null {
    const s = this.sessions.get(userId);
    if (s && (this.o.now ?? Date.now)() - s.at > 30 * 60_000) this.sessions.delete(userId);
    if (!s || !this.sessions.has(userId) || s.item !== item) return null;
    const t = PRACTICE[s.lang];
    const q = t.items[item]!;
    const correct = (choice === "s") === q.scam;
    if (correct) s.score++;
    const feedback = `${correct ? `✅ ${t.right}` : `❌ ${t.wrong}`} ${q.why}`;
    s.item++;
    if (s.item >= t.items.length) {
      this.sessions.delete(userId);
      this.o.counts?.practiceFinished();
      return { text: `${feedback}\n\n${t.end(s.score, t.items.length, practiceLink(this.o.botUsername, s.lang))}` };
    }
    return { text: `${feedback}\n\n<b>${s.item + 1}/${t.items.length}</b> ${t.items[s.item]!.text}`, keyboard: this.keyboard(s.lang, s.item) };
  }

  private prune() {
    const now = (this.o.now ?? Date.now)();
    for (const [k, v] of this.sessions) if (now - v.at > 30 * 60_000) this.sessions.delete(k);
  }
}
