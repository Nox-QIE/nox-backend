import type { PublicView, Role, Team } from "@nox/shared/engine";
import { roleName, teamName, type Lang } from "./i18n.js";

/**
 * The narrator only ever receives public information. The LLM-backed Game Master (F09)
 * will implement this same interface; the template version is the fallback.
 */
export interface Narrator {
  intro(view: PublicView, names: string[]): Promise<string>;
  nightFalls(view: PublicView): Promise<string>;
  morning(view: PublicView, eliminated: string | null, revealedRole: Role | null): Promise<string>;
  dayResult(view: PublicView, eliminated: string | null, revealedRole: Role | null): Promise<string>;
  gameOver(winner: Team, roster: { name: string; role: Role }[]): Promise<string>;
  /** Called once when the game ends or is cancelled (e.g. to report LLM usage). */
  finish?(): void;
}

export class TemplateNarrator implements Narrator {
  constructor(private readonly lang: Lang) {}

  async intro(_view: PublicView, names: string[]) {
    return this.lang === "id"
      ? `🌕 Desa yang tenang… sampai malam ini.\n${names.length} warga berkumpul: ${names.join(", ")}.\nDi antara kalian, ada yang bukan manusia. Peran rahasia sudah dikirim lewat DM.`
      : `🌕 A quiet village… until tonight.\n${names.length} villagers gather: ${names.join(", ")}.\nSomeone among you is not human. Secret roles have been sent by DM.`;
  }

  async nightFalls(view: PublicView) {
    return this.lang === "id"
      ? `🌙 Malam ${view.round} turun. Semua menutup mata… peran khusus, cek DM.`
      : `🌙 Night ${view.round} falls. Everyone close your eyes… special roles, check your DMs.`;
  }

  async morning(_view: PublicView, eliminated: string | null, role: Role | null) {
    if (!eliminated) {
      return this.lang === "id" ? "🌅 Pagi tiba. Ajaib, tidak ada yang jadi korban semalam." : "🌅 Morning comes. Miraculously, nobody died last night.";
    }
    const r = role ? ` (${roleName(this.lang, role)})` : "";
    return this.lang === "id" ? `🌅 Pagi tiba. ${eliminated}${r} ditemukan tak bernyawa.` : `🌅 Morning comes. ${eliminated}${r} was found dead.`;
  }

  async dayResult(_view: PublicView, eliminated: string | null, role: Role | null) {
    if (!eliminated) {
      return this.lang === "id" ? "⚖️ Suara terpecah. Tidak ada yang diusir hari ini." : "⚖️ The vote is split. Nobody is exiled today.";
    }
    const r = role ? ` (${roleName(this.lang, role)})` : "";
    return this.lang === "id" ? `⚖️ Desa memutuskan: ${eliminated}${r} diusir.` : `⚖️ The village has decided: ${eliminated}${r} is exiled.`;
  }

  async gameOver(winner: Team, roster: { name: string; role: Role }[]) {
    const lines = roster.map((p) => `• ${p.name}: ${roleName(this.lang, p.role)}`).join("\n");
    return this.lang === "id"
      ? `🏁 Permainan selesai. Pemenang: <b>${teamName(this.lang, winner)}</b>\n\n${lines}`
      : `🏁 Game over. Winners: <b>${teamName(this.lang, winner)}</b>\n\n${lines}`;
  }
}
