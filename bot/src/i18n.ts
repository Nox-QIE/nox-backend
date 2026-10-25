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
  roleProof: (salt: string) => string;
  restartCancelled: string;
  privacy: (url: string | null) => string;
  forgetAsk: string;
  forgetBtn: string;
  forgetDone: string;
  forgetBusy: string;
  gmLine: (name: string) => string;
  gmDefault: string;
  gmPicked: (name: string) => string;
  verifyLink: (url: string) => string;
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
    roleProof: (salt) => `🔐 Peranmu sudah dikunci di blockchain QIE sebelum dibagikan. Simpan kode ini untuk membuktikannya di akhir game:\n<code>${salt}</code>`,
    restartCancelled: "⚠️ Server Nox sempat restart, jadi game yang sedang berjalan di grup ini dibatalkan (juga di blockchain). Ketik /newgame untuk main lagi.",
    verifyLink: (url) => `🔍 Cek sendiri bahwa game ini adil (peran & aksi dibuka dan dihitung ulang di browsermu): <a href="${url}">${url}</a>`,
    gmLine: (n) => `🎙 Game Master: ${n}. Host bisa memilih lewat tombol di bawah.`,
    gmDefault: "🌙 Nox (bawaan)",
    gmPicked: (n) => `Game Master: ${n}`,
    privacy: (url) =>
      `🔒 <b>Privasi di Nox</b>\n• Disimpan: ID Telegram-mu (agar bot bisa mengirim DM) dan data game terenkripsi sampai game selesai di blockchain, lalu dihapus dalam 30 hari.\n• Nama tampilanmu hanya dipakai selama game; nama pemain yang tersingkir dan daftar akhir dikirim ke penyedia AI untuk narasi.\n• Di blockchain QIE (publik & permanen): alamat wallet game-mu, gabung, vote, hash aksi malam, dan peran yang dibuka di akhir.\n• Obrolan werewolf diteruskan, tidak disimpan.\n• /lupakan menghapus data off-chain milikmu.` + (url ? `\n\nSelengkapnya: ${url}` : ""),
    forgetAsk: "Hapus data off-chain milikmu dari Nox (ID Telegram dan kaitanmu sebagai host)? Data di blockchain tidak bisa dihapus. Kamu perlu menekan Start lagi untuk bermain.",
    forgetBtn: "Ya, hapus dataku",
    forgetDone: "Data off-chain milikmu sudah dihapus.",
    forgetBusy: "Kamu sedang ikut game. Coba lagi setelah game selesai.",
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
    roleProof: (salt) => `🔐 Your role was locked on the QIE blockchain before it was dealt. Keep this code to verify it after the game:\n<code>${salt}</code>`,
    restartCancelled: "⚠️ The Nox server restarted, so the game running in this group was cancelled (on-chain too). Type /newgame to play again.",
    verifyLink: (url) => `🔍 Check for yourself that this game was fair (roles and actions revealed and recomputed in your browser): <a href="${url}">${url}</a>`,
    gmLine: (n) => `🎙 Game Master: ${n}. The host can switch with the buttons below.`,
    gmDefault: "🌙 Nox (default)",
    gmPicked: (n) => `Game Master: ${n}`,
    privacy: (url) =>
      `🔒 <b>Privacy at Nox</b>\n• Stored: your Telegram ID (so the bot can DM you) and encrypted game data until the game is settled on-chain, then deleted within 30 days.\n• Your display name is only used during a game; names of eliminated players and the final roster are sent to the AI provider for narration.\n• On the QIE blockchain (public and permanent): your game wallet address, joins, votes, night action hashes, and roles revealed at the end.\n• Werewolf chat is relayed, not stored.\n• /forget deletes your off-chain data.` + (url ? `\n\nFull policy: ${url}` : ""),
    forgetAsk: "Delete your off-chain data from Nox (your Telegram ID and your link as a host)? Blockchain data cannot be deleted. You will need to press Start again to play.",
    forgetBtn: "Yes, delete my data",
    forgetDone: "Your off-chain data has been deleted.",
    forgetBusy: "You are in a game. Try again after it ends.",
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
