import type { Role, Team } from "@nox/shared/engine";

export type Lang = "id" | "en";

export const langFrom = (code: string | undefined): Lang => (code?.toLowerCase().startsWith("id") ? "id" : "en");

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const ROLE: Record<Lang, Record<Role, string>> = {
  id: { werewolf: "🐺 Werewolf", seer: "🔮 Seer", doctor: "🩺 Doctor", villager: "🧑‍🌾 Warga", hunter: "🏹 Hunter", witch: "🧪 Witch" },
  en: { werewolf: "🐺 Werewolf", seer: "🔮 Seer", doctor: "🩺 Doctor", villager: "🧑‍🌾 Villager", hunter: "🏹 Hunter", witch: "🧪 Witch" },
};

const TEAM: Record<Lang, Record<Team, string>> = {
  id: { wolves: "Werewolf", village: "Warga" },
  en: { wolves: "Werewolves", village: "Village" },
};

export const roleName = (l: Lang, r: Role) => ROLE[l][r];
export const teamName = (l: Lang, t: Team) => TEAM[l][t];

/** The few public stats shown when a player comes back (from the indexer's D7 mirror). */
export interface PlayerStatsLite {
  credits: number;
  games: number;
  wins: number;
  streakDays: number;
  rank: number;
}

type Dict = {
  welcome: string;
  welcomeBack: (s: PlayerStatsLite | null) => string;
  joinBtn: string;
  startBtn: string;
  lobby: (host: string, names: string[], min: number, max: number, secs: number) => string;
  needStart: (name: string, bot: string) => string;
  joined: (name: string) => string;
  alreadyIn: string;
  inOtherGame: string;
  lobbyFull: string;
  passNeeded: string;
  passForMore: (max: number) => string;
  passStatus: (p: { wallet: string; active: boolean; until: string | null; price: string | null; periodDays: number | null; payments: string; explorer: string }) => string;
  /** Paying the pass in QUSDC (F14-S04): approve, then buyPassFor with the token. */
  passQusdc: (p: { wallet: string; price: string; token: string; payments: string }) => string;
  /** Rupiah rail (F14-D04): pay by invoice; the operator records the pass on chain. */
  passRupiah: (wallet: string, contact: string | null) => string;
  countrySet: (country: string, rupiah: boolean) => string;
  countryUsage: string;
  /** /web (NOX-APP-14): a one-time login link to the web app. */
  webLogin: (link: string, minutes: number) => string;
  webOff: string;
  notLobby: string;
  onlyHost: string;
  needMore: (min: number) => string;
  cancelled: (min: number) => string;
  gameExists: string;
  groupOnly: string;
  yourRole: (role: string, wolves: string[]) => string;
  roleProof: (salt: string) => string;
  restartCancelled: string;
  disputed: (url: string | null) => string;
  privacy: (url: string | null) => string;
  forgetAsk: string;
  forgetBtn: string;
  forgetDone: string;
  forgetBusy: string;
  gmLine: (name: string) => string;
  gmDefault: string;
  gmPicked: (name: string) => string;
  verifyLink: (url: string) => string;
  rewardDm: (r: { base: number; role: number; vote: number; streak: number; scamShield?: number; total: number; streakDays: number }) => string;
  pickKill: string;
  pickInspect: string;
  pickProtect: string;
  actionOk: (target: string) => string;
  inspection: (target: string, isWolf: boolean) => string;
  wolfMsg: (from: string, text: string) => string;
  discussion: (secs: number) => string;
  voteOpen: (secs: number) => string;
  noSelfVote: string;
  // Extended role set (10.07 #5): hunter and witch.
  rolesLine: (extended: boolean) => string;
  rolesBtn: (extended: boolean) => string;
  rolesPicked: (extended: boolean) => string;
  roleHelp: { hunter: string; witch: string };
  pickPoison: string;
  witchVictim: (name: string) => string;
  healBtn: (name: string) => string;
  passBtn: string;
  witchPassed: string;
  poisonDeath: (name: string, role: string | null) => string;
  hunterAim: (name: string, secs: number) => string;
  pickShoot: string;
  hunterShot: (hunter: string, target: string, role: string | null) => string;
  hunterPassed: (hunter: string) => string;
  /** Rare moments of the game (10.07 #4), each a badge on chain. */
  rareMoments: (lines: { who: string; badge: string; why: string }[]) => string;
  voteOk: (target: string) => string;
  voted: (voter: string, target: string) => string;
  noPermission: string;
  slowDown: string;
  stale: string;
};

export const T: Record<Lang, Dict> = {
  id: {
    welcome:
      "Selamat datang di <b>Nox</b> 🌙\nGame tebak-tebakan peran di grup, dipandu AI Game Master.\n\n<b>Nox Promise</b>\n• Tidak pernah minta setor uang\n• Tidak ada seed phrase\n• Main gratis\n\nTambahkan bot ke grup lalu ketik /newgame.",
    welcomeBack: (s) =>
      s && s.games > 0
        ? `Selamat datang kembali di <b>Nox</b> 🌙\n${s.games} game, ${s.wins} menang, <b>${s.credits} Nox Credits</b>` +
          (s.rank ? `, peringkat #${s.rank}` : "") +
          (s.streakDays > 1 ? `\n🔥 Streak ${s.streakDays} hari, main lagi hari ini supaya tidak putus.` : "") +
          "\n\nKetik /newgame di grup untuk main lagi."
        : "Selamat datang kembali di <b>Nox</b> 🌙\nKetik /newgame di grup untuk main.",
    joinBtn: "🙋 Gabung",
    startBtn: "▶️ Mulai",
    lobby: (host, names, min, max, secs) =>
      `🌙 <b>Nox</b> — lobby dibuka oleh ${host}\nPemain (${names.length}/${max}): ${names.join(", ") || "-"}\nMinimal ${min} pemain. Lobby tutup dalam ${secs} detik.`,
    needStart: (name, bot) => `${name}, tekan Start di @${bot} dulu supaya bisa menerima peran rahasia, lalu gabung lagi.`,
    joined: (name) => `${name} bergabung.`,
    alreadyIn: "Kamu sudah bergabung.",
    inOtherGame: "Kamu sedang ikut game lain.",
    lobbyFull: "Lobby penuh.",
    passNeeded: "Tema dan Game Master Marketplace butuh Host Pass aktif untuk host. Host bisa ketik /pass di chat pribadi dengan bot.",
    passForMore: (max) => `Lobby gratis maksimal ${max} pemain. Host butuh Host Pass untuk lebih banyak (ketik /pass di chat pribadi).`,
    passStatus: (p) =>
      [
        `🎟 <b>Host Pass</b>: ${p.active ? `aktif sampai ${p.until}` : "belum aktif"}`,
        "Host Pass membuka tema & Game Master Marketplace, dan lobby sampai 12 pemain.",
        `Wallet game kamu: <code>${p.wallet}</code>`,
        p.price
          ? `Harga: ${p.price} QIE per ${p.periodDays} hari. Bayar dari wallet kamu sendiri dengan <code>buyPassFor(${p.wallet}, 1, &lt;jumlah periode&gt;, 0x0000000000000000000000000000000000000000)</code> di kontrak NoxPayments <a href="${p.explorer}">${p.payments}</a>, nilai = harga × periode. Pass langsung aktif untuk wallet game kamu.`
          : "Host Pass belum dijual.",
      ].join("\n"),
    passQusdc: (p) =>
      `💵 Atau bayar ${p.price} QUSDC per periode: di kontrak QUSDC <code>${p.token}</code> panggil <code>approve(${p.payments}, harga × periode)</code>, lalu <code>buyPassFor(${p.wallet}, 1, &lt;jumlah periode&gt;, ${p.token})</code> dengan nilai 0.`,
    passRupiah: (wallet, contact) =>
      `🇮🇩 Bayar dengan rupiah: minta invoice ke ${contact ? esc(contact) : "admin Nox"} dan sebutkan wallet game di atas. Setelah dana masuk, pass dicatat di blockchain QIE untuk wallet <code>${wallet}</code>. Bukan di Indonesia? Ketik /negara diikuti kode negara (mis. /negara SG).`,
    countrySet: (c, rupiah) => `Negara disimpan: ${c}. ${rupiah ? "Pass dibayar dengan rupiah lewat invoice." : "Pass dibayar dengan QIE atau QUSDC dari wallet kamu sendiri."} Cek /pass.`,
    countryUsage: "Ketik /negara diikuti kode negara dua huruf, mis. /negara ID atau /negara SG. Dipakai hanya untuk memilih cara bayar.",
    webLogin: (link, m) =>
      `🔑 Masuk ke web Nox: <a href="${link}">buka tautan ini</a>.\nBerlaku ${m} menit dan hanya bisa dipakai sekali. Jangan teruskan ke siapa pun: siapa pun yang membukanya masuk sebagai kamu.`,
    webOff: "Masuk lewat web belum tersedia.",
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
    disputed: (url) =>
      `⚠️ Hasil game ini ditahan. Pemeriksaan akhir di blockchain QIE tidak lolos, jadi game dicatat terbuka sebagai <b>sengketa</b> dan tidak ada yang mendapat credits. Tim Nox sudah diberi tahu dan sedang memeriksanya.` +
      (url ? `\nCatatan publik: ${url}` : ""),
    verifyLink: (url) => `🔍 Cek sendiri bahwa game ini adil (peran & aksi dibuka dan dihitung ulang di browsermu): <a href="${url}">${url}</a>`,
    rewardDm: (r) =>
      [
        `🏅 Kamu dapat <b>${r.total} Nox Credits</b> dari game ini.`,
        `• Ikut main & hasil tim: ${r.base}`,
        r.role ? `• Peran dimainkan dengan baik: +${r.role}` : "",
        r.vote ? `• Vote tepat ke werewolf: +${r.vote}` : "",
        r.streak ? `• Streak harian (${r.streakDays} hari berturut-turut): +${r.streak}` : r.streakDays > 1 ? `• Streak: ${r.streakDays} hari berturut-turut` : "",
        r.scamShield ? `• Bonus Scam Shield (penipu berhasil dikenali): +${r.scamShield}` : "",
        "Credits adalah poin status: tidak bisa dipindah atau diuangkan, dan dicatat di blockchain QIE.",
      ]
        .filter(Boolean)
        .join("\n"),
    gmLine: (n) => `🎙 Game Master: ${n}. Host bisa memilih lewat tombol di bawah.`,
    gmDefault: "🌙 Nox (bawaan)",
    gmPicked: (n) => `Game Master: ${n}`,
    privacy: (url) =>
      `🔒 <b>Privasi di Nox</b>\n• Disimpan: ID Telegram-mu (agar bot bisa mengirim DM), kode negara (hanya untuk memilih cara bayar; ditebak dari bahasa akun, ubah dengan /negara), jawaban Night Watch (benar/salah per hari, untuk streak), dan data game terenkripsi sampai game selesai di blockchain, lalu dihapus dalam 30 hari.\n• Nama tampilanmu dipakai selama game dan disimpan di Chronicle grup (riwayat per grup: peran, menang/kalah, diusir), yang ditampilkan lewat /chronicle dan recap mingguan; nama pemain yang tersingkir dan daftar akhir dikirim ke penyedia AI untuk narasi.\n• Di blockchain QIE (publik & permanen): alamat wallet game-mu, gabung, vote, hash aksi malam, dan peran yang dibuka di akhir.\n• Pesan grup saat diskusi dibaca sekali di memori untuk Laporan Saksi (siapa bicara, siapa disebut), lalu dibuang: teksnya tidak disimpan dan tidak dikirim ke AI, hanya nama dan jumlahnya.\n• Obrolan werewolf diteruskan, tidak disimpan.\n• /lupakan menghapus data off-chain milikmu.` + (url ? `\n\nSelengkapnya: ${url}` : ""),
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
    voteOpen: (s) => `🗳️ Voting dibuka (${s} detik). Siapa yang dicurigai? Kamu tidak bisa memilih dirimu sendiri.`,
    noSelfVote: "Kamu tidak bisa memilih dirimu sendiri.",
    rolesLine: (x) => (x ? "🎭 Peran: <b>Extended</b> (Hunter mulai 6 pemain, Witch mulai 8)" : "🎭 Peran: Classic"),
    rolesBtn: (x) => (x ? "🎭 Peran: Extended ✓" : "🎭 Peran: Classic"),
    rolesPicked: (x) => (x ? "Peran Extended: Hunter dan Witch ikut bermain." : "Peran Classic."),
    roleHelp: {
      hunter: "Bila kamu mati (diserang, diracun, atau diusir), kamu menembak satu pemain sebelum game berlanjut.",
      witch: "Kamu punya dua ramuan, masing-masing sekali per game: obat (menyelamatkan korban werewolf) dan racun (membunuh satu pemain). Satu ramuan per malam. Selama obat masih ada, kamu diberi tahu siapa korban werewolf.",
    },
    pickPoison: "🧪 Racun: pilih pemain yang ingin kamu racuni malam ini, atau tunggu kabar korban werewolf:",
    witchVictim: (n) => `🧪 Werewolf memilih <b>${n}</b> malam ini. Pakai obat untuk menyelamatkannya?`,
    healBtn: (n) => `💊 Selamatkan ${n}`,
    passBtn: "Lewati malam ini",
    witchPassed: "Kamu menyimpan ramuanmu malam ini.",
    poisonDeath: (n, r) => `☠️ ${n} juga ditemukan tak bernyawa pagi ini${r ? `. Ternyata dia ${r}` : ""}.`,
    hunterAim: (n, s) => `🏹 ${n} adalah Hunter! Dengan sisa tenaga, dia membidik… (${s} detik)`,
    pickShoot: "🏹 Kamu tumbang. Pilih satu pemain untuk kamu tembak:",
    hunterShot: (h, t, r) => `🏹 ${h} menembak <b>${t}</b>${r ? `. Ternyata dia ${r}` : ""}.`,
    hunterPassed: (h) => `🏹 ${h} menurunkan busurnya. Tidak ada yang tertembak.`,
    rareMoments: (ls) => `🏅 <b>Momen langka</b>\n${ls.map((l) => `• ${l.who}: <b>${l.badge}</b> (${l.why})`).join("\n")}\nLencana ini dicatat di blockchain QIE.`,
    voteOk: (t) => `Vote tercatat: ${t}.`,
    voted: (v, t) => `${v} memilih ${t}.`,
    noPermission: "Kamu tidak bisa melakukan itu sekarang.",
    slowDown: "Pelan-pelan dulu ya, tunggu beberapa detik.",
    stale: "Tombol ini sudah tidak berlaku.",
  },
  en: {
    welcome:
      "Welcome to <b>Nox</b> 🌙\nA social deduction game for your group, hosted by an AI Game Master.\n\n<b>Nox Promise</b>\n• We never ask you to deposit money\n• No seed phrase\n• Free to play\n\nAdd the bot to a group and type /newgame.",
    welcomeBack: (s) =>
      s && s.games > 0
        ? `Welcome back to <b>Nox</b> 🌙\n${s.games} games, ${s.wins} wins, <b>${s.credits} Nox Credits</b>` +
          (s.rank ? `, rank #${s.rank}` : "") +
          (s.streakDays > 1 ? `\n🔥 ${s.streakDays}-day streak: play today to keep it.` : "") +
          "\n\nType /newgame in a group to play again."
        : "Welcome back to <b>Nox</b> 🌙\nType /newgame in a group to play.",
    joinBtn: "🙋 Join",
    startBtn: "▶️ Start",
    lobby: (host, names, min, max, secs) =>
      `🌙 <b>Nox</b> — lobby opened by ${host}\nPlayers (${names.length}/${max}): ${names.join(", ") || "-"}\nAt least ${min} players. Lobby closes in ${secs}s.`,
    needStart: (name, bot) => `${name}, press Start in @${bot} first so you can receive your secret role, then join again.`,
    joined: (name) => `${name} joined.`,
    alreadyIn: "You already joined.",
    inOtherGame: "You are already in another game.",
    lobbyFull: "Lobby is full.",
    passNeeded: "Themes and Marketplace Game Masters need an active Host Pass for the host. The host can type /pass in a private chat with the bot.",
    passForMore: (max) => `Free lobbies take up to ${max} players. The host needs a Host Pass for more (type /pass in a private chat).`,
    passStatus: (p) =>
      [
        `🎟 <b>Host Pass</b>: ${p.active ? `active until ${p.until}` : "not active"}`,
        "A Host Pass unlocks themes, Marketplace Game Masters, and lobbies of up to 12 players.",
        `Your game wallet: <code>${p.wallet}</code>`,
        p.price
          ? `Price: ${p.price} QIE per ${p.periodDays} days. Pay from your own wallet with <code>buyPassFor(${p.wallet}, 1, &lt;periods&gt;, 0x0000000000000000000000000000000000000000)</code> on the NoxPayments contract <a href="${p.explorer}">${p.payments}</a>, value = price × periods. The pass goes straight to your game wallet.`
          : "Host Passes are not on sale yet.",
      ].join("\n"),
    passQusdc: (p) =>
      `💵 Or pay ${p.price} QUSDC per period: on the QUSDC contract <code>${p.token}</code> call <code>approve(${p.payments}, price × periods)</code>, then <code>buyPassFor(${p.wallet}, 1, &lt;periods&gt;, ${p.token})</code> with value 0.`,
    passRupiah: (wallet, contact) =>
      `🇮🇩 Pay in rupiah: ask ${contact ? esc(contact) : "a Nox admin"} for an invoice and quote the game wallet above. Once the funds arrive, the pass is recorded on the QIE blockchain for <code>${wallet}</code>. Not in Indonesia? Send /country with your country code (e.g. /country SG).`,
    countrySet: (c, rupiah) => `Country saved: ${c}. ${rupiah ? "Passes are paid in rupiah by invoice." : "Passes are paid in QIE or QUSDC from your own wallet."} See /pass.`,
    countryUsage: "Send /country with a two-letter country code, e.g. /country SG or /country ID. It is only used to pick how you pay.",
    webLogin: (link, m) =>
      `🔑 Sign in to the Nox web app: <a href="${link}">open this link</a>.\nIt works for ${m} minutes and only once. Do not forward it: whoever opens it is signed in as you.`,
    webOff: "Web sign-in is not available yet.",
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
    disputed: (url) =>
      `⚠️ The result of this game is on hold. The final check on the QIE blockchain did not pass, so it was recorded publicly as <b>disputed</b> and nobody received credits. The Nox team has been alerted and is looking into it.` +
      (url ? `\nPublic record: ${url}` : ""),
    verifyLink: (url) => `🔍 Check for yourself that this game was fair (roles and actions revealed and recomputed in your browser): <a href="${url}">${url}</a>`,
    rewardDm: (r) =>
      [
        `🏅 You earned <b>${r.total} Nox Credits</b> in this game.`,
        `• Playing & team result: ${r.base}`,
        r.role ? `• Role played well: +${r.role}` : "",
        r.vote ? `• Votes that hit a werewolf: +${r.vote}` : "",
        r.streak ? `• Daily streak (${r.streakDays} days in a row): +${r.streak}` : r.streakDays > 1 ? `• Streak: ${r.streakDays} days in a row` : "",
        r.scamShield ? `• Scam Shield bonus (the scammers were spotted): +${r.scamShield}` : "",
        "Credits are status points: they cannot be transferred or cashed out, and they are recorded on the QIE blockchain.",
      ]
        .filter(Boolean)
        .join("\n"),
    gmLine: (n) => `🎙 Game Master: ${n}. The host can switch with the buttons below.`,
    gmDefault: "🌙 Nox (default)",
    gmPicked: (n) => `Game Master: ${n}`,
    privacy: (url) =>
      `🔒 <b>Privacy at Nox</b>\n• Stored: your Telegram ID (so the bot can DM you), a country code (only to pick how you pay; guessed from your account language, change it with /country), your Night Watch answers (right/wrong per day, for the streak), and encrypted game data until the game is settled on-chain, then deleted within 30 days.\n• Your display name is used during a game and kept in the group's Chronicle (each group's history: role, win/loss, voted out), shown with /chronicle and in weekly recaps; names of eliminated players and the final roster are sent to the AI provider for narration.\n• On the QIE blockchain (public and permanent): your game wallet address, joins, votes, night action hashes, and roles revealed at the end.\n• Group messages during the discussion are read once in memory for the witness report (who spoke, who was named), then dropped: the text is not stored and not sent to the AI, only names and counts.\n• Werewolf chat is relayed, not stored.\n• /forget deletes your off-chain data.` + (url ? `\n\nFull policy: ${url}` : ""),
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
    voteOpen: (s) => `🗳️ Voting is open (${s}s). Who do you suspect? You cannot vote for yourself.`,
    noSelfVote: "You cannot vote for yourself.",
    rolesLine: (x) => (x ? "🎭 Roles: <b>Extended</b> (Hunter from 6 players, Witch from 8)" : "🎭 Roles: Classic"),
    rolesBtn: (x) => (x ? "🎭 Roles: Extended ✓" : "🎭 Roles: Classic"),
    rolesPicked: (x) => (x ? "Extended roles: the Hunter and the Witch join." : "Classic roles."),
    roleHelp: {
      hunter: "When you die (attacked, poisoned or exiled), you shoot one player before the game goes on.",
      witch: "You have two potions, each once per game: a heal (saves the werewolves' victim) and a poison (kills one player). One potion per night. While you still have the heal, you are told who the werewolves chose.",
    },
    pickPoison: "🧪 Poison: choose a player to poison tonight, or wait to hear the werewolves' victim:",
    witchVictim: (n) => `🧪 The werewolves chose <b>${n}</b> tonight. Use your heal to save them?`,
    healBtn: (n) => `💊 Save ${n}`,
    passBtn: "Pass tonight",
    witchPassed: "You keep your potions tonight.",
    poisonDeath: (n, r) => `☠️ ${n} was also found dead this morning${r ? `. They were ${r}` : ""}.`,
    hunterAim: (n, s) => `🏹 ${n} was the Hunter! With their last strength, they take aim… (${s} seconds)`,
    pickShoot: "🏹 You have fallen. Choose one player to shoot:",
    hunterShot: (h, t, r) => `🏹 ${h} shoots <b>${t}</b>${r ? `. They were ${r}` : ""}.`,
    hunterPassed: (h) => `🏹 ${h} lowers the bow. Nobody is shot.`,
    rareMoments: (ls) => `🏅 <b>Rare moments</b>\n${ls.map((l) => `• ${l.who}: <b>${l.badge}</b> (${l.why})`).join("\n")}\nThese badges are recorded on the QIE blockchain.`,
    voteOk: (t) => `Vote recorded: ${t}.`,
    voted: (v, t) => `${v} voted for ${t}.`,
    noPermission: "You can't do that right now.",
    slowDown: "Slow down a little and try again in a few seconds.",
    stale: "This button has expired.",
  },
};
