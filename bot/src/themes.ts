import type { AgentRecord } from "./agents.js";
import type { Lang } from "./i18n.js";

/**
 * Nox's own narration themes (F09-S08). They use the same persona mechanism as Marketplace agents
 * but have negative ids, no owner and no revenue share. Each theme exists once per language.
 */
/** `version` goes up whenever a theme's text changes (content.lock.json enforces it). */
export const THEMES: { id: number; version: number; keys: string[]; id_: [string, string, string, string[]]; en: [string, string, string, string[]] }[] = [
  {
    id: -1,
    version: 1,
    keys: ["horor", "horror"],
    id_: [
      "Horor Desa",
      "Kabut, kentongan, dan bisik dari kebun pisang",
      "Bercerita seperti dongeng horor kampung yang dituturkan di pos ronda: kabut turun dari bukit, kentongan dipukul jauh, lampu petromaks berkedip, suara langkah di kebun pisang. Seram tapi tanpa darah dan tanpa detail sadis; lebih banyak firasat daripada adegan. Kalimat pendek, nada pelan.",
      ["Kentongan dipukul tiga kali, lalu sunyi lagi.", "Kabut pagi ini tidak mau pergi dari halaman."],
    ],
    en: [
      "Village Horror",
      "Fog, a distant bell, and whispers from the orchard",
      "Tell it like a ghost story whispered at a village night watch: fog rolling down from the hills, a bell struck somewhere far off, a lantern flickering, footsteps in the orchard. Eerie, never gory or graphic; more dread than action. Short sentences, low voice.",
      ["The bell rang three times, then the silence came back.", "This morning the fog would not leave the yard."],
    ],
  },
  {
    id: -2,
    version: 1,
    keys: ["fantasi", "fantasy"],
    id_: [
      "Fantasi",
      "Kerajaan kecil, sihir tua, dan kutukan bulan purnama",
      "Bercerita seperti kisah fantasi epik: kerajaan kecil di tepi hutan tua, menara penyihir, panji-panji, kutukan bulan purnama yang mengubah sebagian penduduk. Bahasa sedikit megah tapi tetap jelas dan cepat dibaca di grup chat. Tanpa kekerasan grafis.",
      ["Panji kerajaan berkibar lesu di bawah bulan yang terlalu terang.", "Para penjaga menyalakan obor, tapi kutukan tidak takut api."],
    ],
    en: [
      "High Fantasy",
      "A small kingdom, old magic, and a full-moon curse",
      "Tell it like an epic fantasy tale: a small kingdom at the edge of an ancient forest, a wizard's tower, banners, a full-moon curse that turns some villagers. Slightly grand language, but clear and quick to read in a group chat. No graphic violence.",
      ["The royal banners hung limp beneath a moon far too bright.", "The guards lit their torches, but the curse does not fear fire."],
    ],
  },
  {
    id: -3,
    version: 1,
    keys: ["kantor", "office"],
    id_: [
      "Kantor",
      "Grup WhatsApp kantor, rapat dadakan, dan kopi yang hilang",
      "Bercerita sebagai komedi kantor: open space, rapat dadakan jam 4 sore, printer yang selalu macet, grup chat kantor yang mendadak sepi. 'Werewolf' adalah rekan kerja yang diam-diam menyabotase proyek; 'korban' resign mendadak atau dimutasi, bukan mati. Lucu, sopan, tanpa menyindir orang sungguhan.",
      ["Pagi ini satu meja kosong. Mug-nya masih hangat.", "Notulen rapat kemarin tiba-tiba hilang dari drive bersama."],
    ],
    en: [
      "Office Politics",
      "The team chat, a surprise 4 pm meeting, and missing coffee",
      "Tell it as an office comedy: an open-plan floor, a surprise 4 pm meeting, a printer that always jams, a team chat that suddenly goes quiet. The 'werewolves' are coworkers quietly sabotaging the project; a 'victim' abruptly quits or gets transferred, never dies. Funny, kind, never mocking real people.",
      ["One desk is empty this morning. The mug is still warm.", "Yesterday's meeting notes have vanished from the shared drive."],
    ],
  },
];

const toAgent = (id: number, lang: Lang, [name, tagline, style, examples]: [string, string, string, string[]]): AgentRecord => ({
  id,
  owner: "",
  persona: { name, tagline, style, examples, langs: [lang] },
  status: "active",
  chainAgentId: null,
});

/** Both language versions of every theme; the lobby keeps only its own language. */
export const THEME_AGENTS: AgentRecord[] = THEMES.flatMap((t) => [toAgent(t.id, "id", t.id_), toAgent(t.id, "en", t.en)]);

/** "/newgame horor" → theme id, or null when the word is not a theme. */
export function themeIdFrom(word: string | undefined): number | null {
  const w = (word ?? "").trim().toLowerCase();
  return THEMES.find((t) => t.keys.includes(w))?.id ?? null;
}

export const isTheme = (agentId: number | null) => agentId !== null && agentId < 0;
