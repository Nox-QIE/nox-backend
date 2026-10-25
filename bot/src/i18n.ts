import type { Role, Team } from "@nox/shared/engine";

export type Lang = "id" | "en";

export const langFrom = (code: string | undefined): Lang => (code?.toLowerCase().startsWith("id") ? "id" : "en");

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const ROLE: Record<Lang, Record<Role, string>> = {
  id: { werewolf: "🐺 Werewolf", seer: "🔮 Seer", doctor: "🩺 Doctor", villager: "🧑‍🌾 Warga" },
  en: { werewolf: "🐺 Werewolf", seer: "🔮 Seer", doctor: "🩺 Doctor", villager: "🧑‍🌾 Villager" },
};

const TEAM: Record<Lang, Record<Team, string>> = {
  id: { wolves: "Werewolf", village: "Warga" },
  en: { wolves: "Werewolves", village: "Village" },
};

export const roleName = (l: Lang, r: Role) => ROLE[l][r];
export const teamName = (l: Lang, t: Team) => TEAM[l][t];

type Dict = {
  welcome: string;
  joinBtn: string;
  startBtn: string;
  lobby: (host: string, names: string[], min: number, max: number, secs: number) => string;
  needStart: (name: string, bot: string) => string;
  joined: (name: string) => string;
  alreadyIn: string;
  inOtherGame: string;
  lobbyFull: string;
  notLobby: string;
  onlyHost: string;
  needMore: (min: number) => string;
  cancelled: (min: number) => string;
  gameExists: string;
  groupOnly: string;
  yourRole: (role: string, wolves: string[]) => string;
  pickKill: string;
  pickInspect: string;
  pickProtect: string;
  actionOk: (target: string) => string;
  inspection: (target: string, isWolf: boolean) => string;
  wolfMsg: (from: string, text: string) => string;
  discussion: (secs: number) => string;
  voteOpen: (secs: number) => string;
  voteOk: (target: string) => string;
  voted: (voter: string, target: string) => string;
  noPermission: string;
  stale: string;
};

export const T: Record<Lang, Dict> = {
  id: {
    welcome:
      "Selamat datang di <b>Nox</b> 🌙\nGame tebak-tebakan peran di grup, dipandu AI Game Master.\n\n<b>Nox Promise</b>\n• Tidak pernah minta setor uang\n• Tidak ada seed phrase\n• Main gratis\n\nTambahkan bot ke grup lalu ketik /newgame.",
    joinBtn: "🙋 Gabung",
    startBtn: "▶️ Mulai",
    lobby: (host, names, min, max, secs) =>
      `🌙 <b>Nox</b> — lobby dibuka oleh ${host}\nPemain (${names.length}/${max}): ${names.join(", ") || "-"}\nMinimal ${min} pemain. Lobby tutup dalam ${secs} detik.`,
    needStart: (name, bot) => `${name}, tekan Start di @${bot} dulu supaya bisa menerima peran rahasia, lalu gabung lagi.`,
    joined: (name) => `${name} bergabung.`,
    alreadyIn: "Kamu sudah bergabung.",
    inOtherGame: "Kamu sedang ikut game lain.",
    lobbyFull: "Lobby penuh.",
    notLobby: "Lobby sudah ditutup.",
    onlyHost: "Hanya host yang bisa memulai.",
    needMore: (min) => `Butuh minimal ${min} pemain.`,
    cancelled: (min) => `Lobby ditutup: kurang dari ${min} pemain.`,
    gameExists: "Sudah ada game di grup ini.",
    groupOnly: "Perintah ini hanya untuk grup.",
    yourRole: (role, wolves) =>
      `Peranmu: <b>${role}</b>` + (wolves.length ? `\nSesama werewolf: ${wolves.join(", ")}\nPesan yang kamu kirim ke bot saat malam diteruskan ke sesama werewolf.` : ""),
    pickKill: "🌙 Pilih korban malam ini:",
    pickInspect: "🌙 Pilih pemain yang ingin kamu selidiki:",
    pickProtect: "🌙 Pilih pemain yang ingin kamu lindungi:",
    actionOk: (t) => `Tercatat: ${t}.`,
    inspection: (t, w) => `🔮 ${t} ${w ? "<b>adalah werewolf</b>" : "<b>bukan werewolf</b>"}.`,
    wolfMsg: (from, text) => `🐺 ${from}: ${text}`,
    discussion: (s) => `☀️ Diskusi dimulai. ${s} detik sebelum voting.`,
    voteOpen: (s) => `🗳️ Voting dibuka (${s} detik). Siapa yang dicurigai?`,
    voteOk: (t) => `Vote tercatat: ${t}.`,
    voted: (v, t) => `${v} memilih ${t}.`,
    noPermission: "Kamu tidak bisa melakukan itu sekarang.",
    stale: "Tombol ini sudah tidak berlaku.",
  },
  en: {
    welcome:
      "Welcome to <b>Nox</b> 🌙\nA social deduction game for your group, hosted by an AI Game Master.\n\n<b>Nox Promise</b>\n• We never ask you to deposit money\n• No seed phrase\n• Free to play\n\nAdd the bot to a group and type /newgame.",
    joinBtn: "🙋 Join",
    startBtn: "▶️ Start",
    lobby: (host, names, min, max, secs) =>
      `🌙 <b>Nox</b> — lobby opened by ${host}\nPlayers (${names.length}/${max}): ${names.join(", ") || "-"}\nAt least ${min} players. Lobby closes in ${secs}s.`,
    needStart: (name, bot) => `${name}, press Start in @${bot} first so you can receive your secret role, then join again.`,
    joined: (name) => `${name} joined.`,
    alreadyIn: "You already joined.",
    inOtherGame: "You are already in another game.",
    lobbyFull: "Lobby is full.",
    notLobby: "The lobby is closed.",
    onlyHost: "Only the host can start.",
    needMore: (min) => `Need at least ${min} players.`,
    cancelled: (min) => `Lobby closed: fewer than ${min} players.`,
    gameExists: "A game is already running in this group.",
    groupOnly: "This command only works in groups.",
    yourRole: (role, wolves) =>
      `Your role: <b>${role}</b>` + (wolves.length ? `\nFellow werewolves: ${wolves.join(", ")}\nMessages you send to the bot at night are relayed to them.` : ""),
    pickKill: "🌙 Choose tonight's victim:",
    pickInspect: "🌙 Choose a player to investigate:",
    pickProtect: "🌙 Choose a player to protect:",
    actionOk: (t) => `Recorded: ${t}.`,
    inspection: (t, w) => `🔮 ${t} ${w ? "<b>is a werewolf</b>" : "<b>is not a werewolf</b>"}.`,
    wolfMsg: (from, text) => `🐺 ${from}: ${text}`,
    discussion: (s) => `☀️ Discussion starts. Voting in ${s}s.`,
    voteOpen: (s) => `🗳️ Voting is open (${s}s). Who do you suspect?`,
    voteOk: (t) => `Vote recorded: ${t}.`,
    voted: (v, t) => `${v} voted for ${t}.`,
    noPermission: "You can't do that right now.",
    stale: "This button has expired.",
  },
};
