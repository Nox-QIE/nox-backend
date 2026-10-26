import {
  apply,
  assignRoles,
  createGame,
  GameRuleError,
  MAX_PLAYERS,
  MIN_PLAYERS,
  publicView,
  type Command,
  type GameEvent,
  type GameState,
  type Role,
  type RoleAssignment,
} from "@nox/shared/engine";
import { ACTION_CODE, actionHash, commitRoles, configHash, randomBytes32, resultHash, ROLE_CODE, TEAM_CODE, type NightActionKind } from "@nox/shared/crypto-spec";
import type { Hex } from "viem";
import { noLedger, type GameLedger, type LedgerNightReveal } from "./chain/ledger.js";
import { FREE_MAX_PLAYERS } from "./chain/passes.js";
import { esc, roleName, T, type Lang } from "./i18n.js";
import type { AgentRecord, Persona } from "./agents.js";
import { safeName } from "./names.js";
import type { Narrator, NarratorReport, Wording } from "./narrator.js";
import type { Scenario, ScenarioText } from "./scenarios.js";
import type { Keyboard, Messenger, Scheduler, Timings } from "./ports.js";
import type { Store } from "./store.js";

export type RoomStatus = "lobby" | "running" | "ended" | "cancelled";

export interface RoomDeps {
  messenger: Messenger;
  /** Builds the narrator for a game; a persona comes from the Agent Marketplace. */
  narratorFor: (lang: Lang, persona?: Persona, wording?: Wording, agent?: AgentRecord) => Narrator;
  /** Active Marketplace agents the host can pick in the lobby (none = no picker). */
  agents?: () => AgentRecord[];
  scheduler: Scheduler;
  timings: Timings;
  /** CSPRNG-backed integer in [0, maxExclusive). */
  randomInt: (maxExclusive: number) => number;
  botUsername: string;
  /** Called once the room ends or is cancelled, so the registry can forget it. */
  onClosed: (room: GameRoom) => void;
  /** On-chain record (NoxGame). Defaults to none; gameplay never waits for it. */
  ledger?: GameLedger;
  /** Durable store for game secrets, so a game can still be revealed or cancelled after a restart. */
  store?: Store;
  /** Public dashboard (nox-frontend). When set, the game-over message links to the game's proof page. */
  webUrl?: string;
  /**
   * Whether a host may use premium lobby features (F03-S06, F14-S05): a theme or Marketplace Game
   * Master, more than FREE_MAX_PLAYERS players. Unset = no gating (NOX_HOST_PASS=off).
   */
  hostPass?: (userId: number) => Promise<boolean>;
  /**
   * Nudge a quiet discussion halfway through (F07-S02). "quiet" needs `canCountMessages` (the bot
   * reads group messages only with Telegram privacy mode off); "always" nudges once every discussion.
   */
  nudge?: "quiet" | "always";
  canCountMessages?: boolean;
  /** Every finished game's narrator report (AI cost per game, F09-D05). */
  onGameReport?: (r: { gameId: Hex | null; agentId: number | null; players: number; report: NarratorReport }) => void;
  /** A finished game narrated by a Marketplace agent: how its persona behaved (F18-S11). */
  onAgentGame?: (agentId: number, report: NarratorReport) => void;
}

export interface Reply {
  ok: boolean;
  text?: string;
}

const NIGHT_ROLES: ReadonlySet<Role> = new Set<Role>(["werewolf", "seer", "doctor"]);
const ACTION_OF: Partial<Record<Role, NightActionKind>> = { werewolf: "kill", seer: "inspect", doctor: "protect" };

/** One game in one Telegram group, from lobby to the end. All mutations run through a queue. */
export class GameRoom {
  status: RoomStatus = "lobby";
  /** Join order = seat order. */
  readonly players = new Map<number, string>();
  private state: GameState | null = null;
  private readonly events: GameEvent[] = [];
  private readonly commands: Command[] = [];
  private assignments: RoleAssignment[] = [];
  private lobbyMessageId: number | null = null;
  private cancelTimer: (() => void) | null = null;
  private cancelNudge: (() => void) | null = null;
  private discussionMessages = 0;
  private phaseStep: "night" | "discussion" | "vote" | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly t;
  private readonly ledger: GameLedger;
  /** On-chain game id (bytes32), set when the game starts with a ledger. */
  gameId: Hex | null = null;
  private secrets = new Map<number, { salt: Hex; proof: Hex[] }>();
  private readonly nights: LedgerNightReveal[] = [];
  private narrator: Narrator;
  private readonly sc: ScenarioText | null;
  /** Marketplace agent picked by the host (null = Nox's own Game Master). */
  agentId: number | null = null;

  constructor(
    readonly id: string,
    readonly chatId: number,
    readonly hostId: number,
    hostName: string,
    readonly lang: Lang,
    private readonly deps: RoomDeps,
    /** Scam Shield scenario (F10): re-skins roles and facts, adds warning signs and a debrief. */
    readonly scenario: Scenario | null = null,
  ) {
    this.t = T[lang];
    this.ledger = deps.ledger ?? noLedger;
    this.sc = scenario ? scenario.text[lang] : null;
    this.narrator = this.sc ? deps.narratorFor(lang, this.sc.persona, this.sc.wording) : deps.narratorFor(lang);
    this.players.set(hostId, safeName(hostName, 1, lang));
  }

  /** Commands and assignment so far — enough to replay the game with @nox/shared/engine. */
  get log() {
    return { assignments: [...this.assignments], commands: [...this.commands] };
  }

  roleOf(userId: number): Role | null {
    return this.state?.players[String(userId)]?.role ?? null;
  }

  isAlive(userId: number): boolean {
    return this.state?.players[String(userId)]?.alive ?? false;
  }

  private run<R>(fn: () => Promise<R>): Promise<R> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private name(userId: number | string): string {
    return esc(this.players.get(Number(userId)) ?? String(userId));
  }

  private schedule(ms: number, fn: () => Promise<void>) {
    this.cancelTimer?.();
    this.cancelTimer = this.deps.scheduler.schedule(ms, () => void this.run(fn));
  }

  // ---------- lobby ----------

  open(): Promise<void> {
    return this.run(async () => {
      this.lobbyMessageId = await this.deps.messenger.sendGroup(this.chatId, this.lobbyText(), this.lobbyKeyboard());
      this.schedule(this.deps.timings.lobbyMs, () => this.lobbyTimeout());
    });
  }

  private lobbyAgents(): AgentRecord[] {
    if (this.sc) return []; // the scenario sets the Game Master's voice
    // Nox themes (negative ids) first, then at most 4 Marketplace agents.
    const all = (this.deps.agents?.() ?? []).filter((a) => a.persona.langs.includes(this.lang));
    return [...all.filter((a) => a.id < 0), ...all.filter((a) => a.id > 0).slice(0, 4)];
  }

  private lobbyText() {
    let text = this.t.lobby(this.name(this.hostId), [...this.players.keys()].map((id) => this.name(id)), MIN_PLAYERS, MAX_PLAYERS, Math.round(this.deps.timings.lobbyMs / 1000));
    if (this.sc) text = `🛡️ <b>${this.sc.title}</b>\n${text}`;
    if (!this.lobbyAgents().length) return text;
    const picked = this.lobbyAgents().find((a) => a.id === this.agentId);
    return `${text}\n${this.t.gmLine(picked ? `${esc(picked.persona.name)}${picked.persona.tagline ? ` (${esc(picked.persona.tagline)})` : ""}` : this.t.gmDefault)}`;
  }

  private lobbyKeyboard(): Keyboard {
    const rows: Keyboard = [[{ text: this.t.joinBtn, data: `j:${this.id}` }, { text: this.t.startBtn, data: `s:${this.id}` }]];
    const agents = this.lobbyAgents();
    if (agents.length) {
      const mark = (on: boolean, label: string) => (on ? `✓ ${label}` : label);
      rows.push([{ text: mark(this.agentId === null, this.t.gmDefault), data: `a:${this.id}:0` }]);
      for (const a of agents) rows.push([{ text: mark(this.agentId === a.id, `${a.id < 0 ? "🎨" : "🎭"} ${a.persona.name}`), data: `a:${this.id}:${a.id}` }]);
    }
    return rows;
  }

  /** Host picks the Game Master in the lobby. 0 = Nox's own. */
  pickAgent(userId: number, agentId: number): Promise<Reply> {
    return this.run(async () => {
      if (this.status !== "lobby") return { ok: false, text: this.t.notLobby };
      if (userId !== this.hostId) return { ok: false, text: this.t.onlyHost };
      const agent = this.lobbyAgents().find((a) => a.id === agentId);
      if (agentId !== 0 && !agent) return { ok: false, text: this.t.stale };
      if (agentId !== 0 && this.deps.hostPass && !(await this.deps.hostPass(this.hostId))) return { ok: false, text: this.t.passNeeded };
      this.agentId = agent ? agent.id : null;
      if (this.lobbyMessageId !== null) {
        await this.deps.messenger.editGroup(this.chatId, this.lobbyMessageId, this.lobbyText(), this.lobbyKeyboard());
      }
      return { ok: true, text: this.t.gmPicked(agent ? agent.persona.name : this.t.gmDefault) };
    });
  }

  join(userId: number, displayName: string): Promise<Reply> {
    return this.run(async () => {
      if (this.status !== "lobby") return { ok: false, text: this.t.notLobby };
      if (this.players.has(userId)) return { ok: false, text: this.t.alreadyIn };
      if (this.players.size >= MAX_PLAYERS) return { ok: false, text: this.t.lobbyFull };
      if (this.players.size >= FREE_MAX_PLAYERS && this.deps.hostPass && !(await this.deps.hostPass(this.hostId))) {
        return { ok: false, text: this.t.passForMore(FREE_MAX_PLAYERS) };
      }
      this.players.set(userId, safeName(displayName, this.players.size + 1, this.lang));
      if (this.lobbyMessageId !== null) {
        await this.deps.messenger.editGroup(this.chatId, this.lobbyMessageId, this.lobbyText(), this.lobbyKeyboard());
      }
      return { ok: true, text: this.t.joined(esc(this.players.get(userId)!)) };
    });
  }

  start(userId: number): Promise<Reply> {
    return this.run(async () => {
      if (this.status !== "lobby") return { ok: false, text: this.t.notLobby };
      if (userId !== this.hostId) return { ok: false, text: this.t.onlyHost };
      if (this.players.size < MIN_PLAYERS) return { ok: false, text: this.t.needMore(MIN_PLAYERS) };
      await this.begin();
      return { ok: true };
    });
  }

  private async lobbyTimeout() {
    if (this.status !== "lobby") return;
    if (this.players.size >= MIN_PLAYERS) return this.begin();
    this.status = "cancelled";
    await this.deps.messenger.sendGroup(this.chatId, this.t.cancelled(MIN_PLAYERS));
    this.narrator.finish?.();
    this.deps.onClosed(this);
  }

  // ---------- game ----------

  private async begin() {
    this.cancelTimer?.();
    this.status = "running";
    const agent = this.agentId !== null ? this.lobbyAgents().find((a) => a.id === this.agentId) : undefined;
    if (agent) this.narrator = this.deps.narratorFor(this.lang, agent.persona, undefined, agent);
    else this.agentId = null;
    const ids = [...this.players.keys()].map(String);
    this.assignments = assignRoles(ids, this.deps.randomInt);
    const created = createGame(this.assignments);
    this.state = created.state;
    this.events.push(...created.events);

    if (this.ledger.enabled) this.commitOnChain();

    const wolves = this.assignments.filter((a) => a.role === "werewolf").map((a) => a.id);
    for (const a of this.assignments) {
      const mates = a.role === "werewolf" ? wolves.filter((w) => w !== a.id).map((w) => this.name(w)) : [];
      let text = this.t.yourRole(this.sc ? this.sc.roles[a.role] : roleName(this.lang, a.role), mates);
      const secret = this.secrets.get(Number(a.id));
      if (secret) text += `\n\n${this.t.roleProof(secret.salt)}`;
      await this.deps.messenger.sendDM(Number(a.id), text);
    }

    const view = publicView(this.state, this.events);
    await this.deps.messenger.sendGroup(this.chatId, await this.narrator.intro(view, ids.map((id) => this.name(id))));
    await this.startNight();
  }

  /** Lock the roles on-chain (Merkle root) before anyone receives theirs. */
  private commitOnChain() {
    const gameId = randomBytes32();
    const committed = commitRoles(
      gameId,
      this.assignments.map((a) => ({ player: this.ledger.addressOf(Number(a.id))!, role: a.role })),
    );
    this.assignments.forEach((a, i) => {
      const p = committed.players[i]!;
      this.secrets.set(Number(a.id), { salt: p.salt, proof: p.proof });
    });
    this.gameId = gameId;
    // Persist before anything goes on-chain: without the salts the game could never be revealed.
    this.deps.store?.saveGame(gameId, this.chatId, this.lang, { roles: this.roleReveals(), nights: [] });
    const config = { players: this.assignments.length, timings: this.deps.timings, revealOnDeath: true, lang: this.lang, scenario: this.scenario?.key ?? null };
    this.ledger.startGame(gameId, configHash(config), this.assignments.map((a) => Number(a.id)), committed.root);
  }

  private roleReveals() {
    return this.assignments.map((a) => ({ userId: Number(a.id), role: ROLE_CODE[a.role], ...this.secrets.get(Number(a.id))! }));
  }

  private exec(cmd: Command): GameEvent[] {
    const t = apply(this.state!, cmd);
    this.state = t.state;
    this.events.push(...t.events);
    this.commands.push(cmd);
    return t.events;
  }

  private async startNight() {
    this.phaseStep = "night";
    const state = this.state!;
    await this.deps.messenger.sendGroup(this.chatId, await this.narrator.nightFalls(publicView(state, this.events)));
    const alive = state.seats.filter((id) => state.players[id]!.alive);
    for (const id of alive) {
      const role = state.players[id]!.role;
      if (!NIGHT_ROLES.has(role)) continue;
      const targets = alive.filter((t) => {
        if (role === "werewolf") return state.players[t]!.role !== "werewolf";
        if (role === "seer") return t !== id;
        return true;
      });
      const prompt = role === "werewolf" ? this.t.pickKill : role === "seer" ? this.t.pickInspect : this.t.pickProtect;
      await this.deps.messenger.sendDM(Number(id), prompt, this.targetKeyboard("n", targets));
    }
    this.schedule(this.deps.timings.nightMs, () => this.endNight());
  }

  /** Buttons carry the round so a button from an earlier night or day is rejected as stale. */
  private targetKeyboard(prefix: "n" | "v", targets: string[]): Keyboard {
    const round = this.state!.round;
    return targets.map((t) => [{ text: this.players.get(Number(t)) ?? t, data: `${prefix}:${this.id}:${round}:${t}` }]);
  }

  private isStale(step: "night" | "vote", round: number) {
    return this.status !== "running" || this.phaseStep !== step || this.state!.round !== round;
  }

  nightAction(userId: number, round: number, targetId: string): Promise<Reply> {
    return this.run(async () => {
      if (this.isStale("night", round)) return { ok: false, text: this.t.stale };
      try {
        this.exec({ type: "night_action", actor: String(userId), target: targetId });
      } catch (e) {
        if (e instanceof GameRuleError) return { ok: false, text: this.t.noPermission };
        throw e;
      }
      this.commitNight(userId, round, Number(targetId));
      const reply = { ok: true, text: this.t.actionOk(this.name(targetId)) };
      if (this.allNightActionsIn()) await this.endNight();
      return reply;
    });
  }

  private commitNight(userId: number, round: number, targetUserId: number) {
    const kind = ACTION_OF[this.roleOf(userId)!];
    if (!this.gameId || !kind) return;
    const nonce = randomBytes32();
    const hash = actionHash(this.gameId, round, this.ledger.addressOf(userId)!, kind, this.ledger.addressOf(targetUserId)!, nonce);
    this.nights.push({ round, userId, action: ACTION_CODE[kind], targetUserId, nonce });
    this.deps.store?.updateSecret(this.gameId, { roles: this.roleReveals(), nights: this.nights });
    this.ledger.commitNightAction(this.gameId, round, userId, hash);
  }

  private allNightActionsIn(): boolean {
    const s = this.state!;
    return s.seats.every((id) => {
      const p = s.players[id]!;
      return !p.alive || !NIGHT_ROLES.has(p.role) || Boolean(s.nightActions[id]);
    });
  }

  private async endNight() {
    if (this.phaseStep !== "night") return;
    this.cancelTimer?.();
    this.phaseStep = null;
    const evs = this.exec({ type: "end_night" });
    for (const e of evs) {
      if (e.type === "inspection_result") {
        await this.deps.messenger.sendDM(Number(e.seer), this.t.inspection(this.name(e.target), e.isWerewolf));
      }
    }
    const resolved = evs.find((e) => e.type === "night_resolved");
    if (resolved?.type === "night_resolved") {
      const name = resolved.eliminated ? this.name(resolved.eliminated) : null;
      await this.deps.messenger.sendGroup(this.chatId, await this.narrator.morning(publicView(this.state!, this.events), name, resolved.revealedRole));
    }
    if (await this.finishIfEnded(evs)) return;
    if (this.sc) {
      const hint = this.sc.hints[(this.state!.round - 1) % this.sc.hints.length]!;
      await this.deps.messenger.sendGroup(this.chatId, hint);
    }
    this.phaseStep = "discussion";
    this.discussionMessages = 0;
    await this.deps.messenger.sendGroup(this.chatId, this.t.discussion(Math.round(this.deps.timings.discussionMs / 1000)));
    this.schedule(this.deps.timings.discussionMs, () => this.openVote());
    const mode = this.deps.nudge === "quiet" && !this.deps.canCountMessages ? undefined : this.deps.nudge;
    if (mode && this.narrator.nudge) {
      const round = this.state!.round;
      this.cancelNudge = this.deps.scheduler.schedule(Math.floor(this.deps.timings.discussionMs / 2), () => void this.run(() => this.maybeNudge(round, mode)));
    }
  }

  /** A group message seen by the bot (only possible with Telegram privacy mode off). */
  noteGroupMessage() {
    if (this.phaseStep === "discussion") this.discussionMessages++;
  }

  private async maybeNudge(round: number, mode: "quiet" | "always") {
    if (this.phaseStep !== "discussion" || this.state?.round !== round) return;
    const alive = this.state.seats.filter((id) => this.state!.players[id]!.alive).length;
    // Quiet = fewer messages than living players by halfway.
    if (mode === "quiet" && this.discussionMessages >= alive) return;
    await this.deps.messenger.sendGroup(this.chatId, await this.narrator.nudge!(publicView(this.state, this.events)));
  }

  private async openVote() {
    this.cancelNudge?.();
    this.cancelNudge = null;
    if (this.phaseStep !== "discussion") return;
    this.phaseStep = "vote";
    const s = this.state!;
    const alive = s.seats.filter((id) => s.players[id]!.alive);
    await this.deps.messenger.sendGroup(this.chatId, this.t.voteOpen(Math.round(this.deps.timings.voteMs / 1000)), this.targetKeyboard("v", alive));
    this.schedule(this.deps.timings.voteMs, () => this.endDay());
  }

  vote(userId: number, round: number, targetId: string): Promise<Reply> {
    return this.run(async () => {
      if (this.isStale("vote", round)) return { ok: false, text: this.t.stale };
      try {
        this.exec({ type: "vote", voter: String(userId), target: targetId });
      } catch (e) {
        if (e instanceof GameRuleError) return { ok: false, text: this.t.noPermission };
        throw e;
      }
      if (this.gameId) this.ledger.castVote(this.gameId, round, userId, Number(targetId));
      await this.deps.messenger.sendGroup(this.chatId, this.t.voted(this.name(userId), this.name(targetId)));
      const s = this.state!;
      const aliveCount = s.seats.filter((id) => s.players[id]!.alive).length;
      if (Object.keys(s.votes).length >= aliveCount) await this.endDay();
      return { ok: true, text: this.t.voteOk(this.name(targetId)) };
    });
  }

  private async endDay() {
    if (this.phaseStep !== "vote") return;
    this.cancelTimer?.();
    this.phaseStep = null;
    const dayRound = this.state!.round;
    const evs = this.exec({ type: "end_day" });
    const resolved = evs.find((e) => e.type === "day_resolved");
    if (this.gameId && resolved) this.ledger.recordRound(this.gameId, dayRound, resultHash(resolved));
    if (resolved?.type === "day_resolved") {
      const name = resolved.eliminated ? this.name(resolved.eliminated) : null;
      await this.deps.messenger.sendGroup(this.chatId, await this.narrator.dayResult(publicView(this.state!, this.events), name, resolved.revealedRole));
    }
    if (await this.finishIfEnded(evs)) return;
    await this.startNight();
  }

  private async finishIfEnded(evs: GameEvent[]): Promise<boolean> {
    const ended = evs.find((e) => e.type === "game_ended");
    if (ended?.type !== "game_ended") return false;
    this.status = "ended";
    this.phaseStep = null;
    this.cancelTimer?.();
    if (this.gameId) {
      const payload = { roles: this.roleReveals(), nights: this.nights, resultHash: resultHash(this.log), winner: TEAM_CODE[ended.winner] };
      this.deps.store?.markEnded(this.gameId, payload);
      this.ledger.finalize(this.gameId, payload.roles, payload.nights, payload.resultHash, payload.winner);
    }
    const roster = this.state!.seats.map((id) => ({ name: this.name(id), role: ended.roles[id]! }));
    // Nox themes (negative ids) are not Marketplace agents: they count as Nox's own GM for revenue.
    const agentId = this.agentId !== null && this.agentId > 0 ? this.agentId : null;
    this.deps.store?.recordFinishedGame({ agentId, players: this.players.size, hostId: this.hostId, chainGameId: this.gameId, chatId: this.chatId });
    let over = await this.narrator.gameOver(ended.winner, roster);
    if (this.gameId && this.deps.webUrl) over += `\n\n${this.t.verifyLink(`${this.deps.webUrl.replace(/\/+$/, "")}/game/?id=${this.gameId}`)}`;
    await this.deps.messenger.sendGroup(this.chatId, over);
    if (this.sc) {
      await this.deps.messenger.sendGroup(this.chatId, this.sc.debrief);
      if (ended.winner === "village") {
        for (const a of this.assignments) if (a.role !== "werewolf") await this.deps.messenger.sendDM(Number(a.id), this.sc.spotterBadge);
      }
    }
    const report = this.narrator.finish?.();
    if (report) this.deps.onGameReport?.({ gameId: this.gameId, agentId, players: this.players.size, report });
    if (report && agentId !== null) this.deps.onAgentGame?.(agentId, report);
    this.deps.onClosed(this);
    return true;
  }

  /** Relay a DM from a living werewolf to the other living werewolves during the night. */
  wolfChat(userId: number, text: string): Promise<boolean> {
    return this.run(async () => {
      const s = this.state;
      if (!s || this.phaseStep !== "night") return false;
      const me = s.players[String(userId)];
      if (!me?.alive || me.role !== "werewolf") return false;
      const others = s.seats.filter((id) => id !== String(userId) && s.players[id]!.alive && s.players[id]!.role === "werewolf");
      for (const id of others) await this.deps.messenger.sendDM(Number(id), this.t.wolfMsg(this.name(userId), esc(text)));
      return true;
    });
  }
}
