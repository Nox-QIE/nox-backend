import type { PublicView, Role, Team } from "@nox/shared/engine";
import { esc, unesc, type Lang } from "../i18n.js";
import { TemplateNarrator, type Narrator, type NarratorReport, type Wording } from "../narrator.js";
import { checkNarration } from "./guard.js";
import { costUsd, type GmModel, type GmUsage } from "./model.js";
import { systemPrompt, userPrompt, type Beat, type Persona } from "./prompt.js";

export interface LlmNarratorOptions {
  model: GmModel;
  lang: Lang;
  timeoutMs: number;
  log?: (line: Record<string, unknown>) => void;
  /** USD per million tokens [input, output]; defaults to the Claude API price table. */
  price?: [number, number];
  /** Hosted persona from the Agent Marketplace; changes voice only, never rules or facts. */
  persona?: Persona;
  /** Writes the persona layer instead of `model` (an agent's own endpoint, F18-S10); needs `persona`. */
  personaModel?: GmModel;
  /** Scenario wording for the factual lines (Scam Shield). */
  wording?: Wording;
}

export interface GmStats {
  calls: number;
  failures: number;
  fallbacks: number;
  rejected: Record<string, number>;
  usage: GmUsage;
  /** Usage per "provider:model" that actually served a call (differs from the primary on failover). */
  byModel: Record<string, GmUsage>;
  /** Which voice wrote each beat: the persona (agent or theme), Nox's own, or the template alone. */
  voice: { persona: number; nox: number; template: number };
  /** The persona was set aside for the rest of this game after too many guard rejections. */
  personaDemoted: boolean;
  /** Calls to an agent's own endpoint, and those that failed (error or timeout). */
  endpointCalls: number;
  endpointErrors: number;
}

/** Guard rejections of a persona's lines in one game before Nox's own voice takes over for good. */
export const PERSONA_REJECTION_LIMIT = 3;

const emptyUsage = (): GmUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
const addUsage = (to: GmUsage, u: GmUsage) => {
  to.inputTokens += u.inputTokens;
  to.outputTokens += u.outputTokens;
  to.cacheReadTokens += u.cacheReadTokens;
  to.cacheWriteTokens += u.cacheWriteTokens;
};

/**
 * AI Game Master. Each beat = one short LLM "flavor" line followed by the template's factual line,
 * so facts never depend on the model. Fallback in layers (F18-S06): the persona (a Marketplace agent
 * or theme) gets two tries, then Nox's own voice one, then the template alone is used: a game can
 * never stall on narration. A persona whose lines the guard keeps rejecting is set aside for the
 * rest of the game.
 *
 * Inputs from the room are HTML-escaped; the model sees raw names and its output is escaped again.
 */
export class LlmNarrator implements Narrator {
  private readonly template: TemplateNarrator;
  private readonly system: string;
  private readonly noxSystem: string | null;
  private personaRejections = 0;
  private names: string[] = [];
  readonly stats: GmStats = {
    calls: 0,
    failures: 0,
    fallbacks: 0,
    rejected: {},
    usage: emptyUsage(),
    byModel: {},
    voice: { persona: 0, nox: 0, template: 0 },
    personaDemoted: false,
    endpointCalls: 0,
    endpointErrors: 0,
  };

  constructor(private readonly opts: LlmNarratorOptions) {
    this.template = new TemplateNarrator(opts.lang, opts.wording);
    this.system = systemPrompt(opts.lang, opts.persona);
    this.noxSystem = opts.persona ? systemPrompt(opts.lang) : null;
  }

  private async flavor(beat: Beat, allowed: string[]): Promise<string | null> {
    const forbidden = this.names.filter((n) => !allowed.includes(n));
    // Persona first (two tries), then Nox's own voice (one try; two when there is no persona to try).
    const own = this.opts.model;
    const layers: { system: string; tries: number; voice: "persona" | "nox"; model: GmModel }[] =
      this.noxSystem !== null && !this.stats.personaDemoted
        ? [
            { system: this.system, tries: 2, voice: "persona", model: this.opts.personaModel ?? own },
            { system: this.noxSystem, tries: 1, voice: "nox", model: own },
          ]
        : [{ system: this.noxSystem ?? this.system, tries: 2, voice: "nox", model: own }];
    for (const layer of layers) {
      for (let attempt = 0; attempt < layer.tries; attempt++) {
        this.stats.calls++;
        // Only an agent's own service counts against the agent; Nox's provider failing is not its doing.
        const endpoint = layer.voice === "persona" && this.opts.personaModel !== undefined;
        if (endpoint) this.stats.endpointCalls++;
        try {
          const r = await layer.model.complete(layer.system, userPrompt(beat), this.opts.timeoutMs);
          addUsage(this.stats.usage, r.usage);
          addUsage((this.stats.byModel[r.model] ??= emptyUsage()), r.usage);
          const g = checkNarration(r.text, forbidden);
          if (g.ok) {
            this.stats.voice[layer.voice]++;
            return esc(g.text);
          }
          this.stats.rejected[g.reason] = (this.stats.rejected[g.reason] ?? 0) + 1;
          if (layer.voice === "persona" && ++this.personaRejections >= PERSONA_REJECTION_LIMIT) {
            this.stats.personaDemoted = true;
            this.opts.log?.({ event: "gm_persona_demoted", persona: this.opts.persona?.name, rejections: this.personaRejections });
            break; // straight to Nox's own voice
          }
        } catch (e) {
          this.stats.failures++;
          if (endpoint) this.stats.endpointErrors++;
          this.opts.log?.({ event: "gm_error", beat: beat.kind, error: e instanceof Error ? e.message : String(e) });
        }
      }
    }
    this.stats.voice.template++;
    this.stats.fallbacks++;
    return null;
  }

  private join(flavor: string | null, fact: string) {
    return flavor ? `<i>${flavor}</i>\n\n${fact}` : fact;
  }

  async intro(view: PublicView, names: string[]) {
    this.names = names.map(unesc);
    const fact = await this.template.intro(view, names);
    return this.join(await this.flavor({ kind: "intro", playerCount: names.length }, []), fact);
  }

  async nightFalls(view: PublicView) {
    const fact = await this.template.nightFalls(view);
    return this.join(await this.flavor({ kind: "nightFalls", round: view.round, alive: view.alive.length }, []), fact);
  }

  async morning(view: PublicView, eliminated: string | null, revealedRole: Role | null) {
    const fact = await this.template.morning(view, eliminated, revealedRole);
    const name = eliminated ? unesc(eliminated) : null;
    const beat: Beat = { kind: "morning", round: view.round, eliminated: name, revealedRole, alive: view.alive.length };
    return this.join(await this.flavor(beat, name ? [name] : []), fact);
  }

  async dayResult(view: PublicView, eliminated: string | null, revealedRole: Role | null) {
    const fact = await this.template.dayResult(view, eliminated, revealedRole);
    const name = eliminated ? unesc(eliminated) : null;
    const beat: Beat = { kind: "dayResult", round: view.round, eliminated: name, revealedRole, alive: view.alive.length };
    return this.join(await this.flavor(beat, name ? [name] : []), fact);
  }

  async gameOver(winner: Team, roster: { name: string; role: Role }[]) {
    const fact = await this.template.gameOver(winner, roster);
    const raw = roster.map((p) => ({ name: unesc(p.name), role: p.role }));
    return this.join(await this.flavor({ kind: "gameOver", winner, roster: raw }, this.names), fact);
  }

  async nudge(view: PublicView) {
    // Every living player is off limits: the line must not point at anyone.
    const flavor = await this.flavor({ kind: "nudge", round: view.round, alive: view.alive.length }, []);
    return flavor ? `🎙 <i>${flavor}</i>` : this.template.nudge(view);
  }

  finish(): NarratorReport {
    let cost: number | null = 0;
    for (const [model, u] of Object.entries(this.stats.byModel)) {
      if (model.startsWith("endpoint:")) continue; // an agent's own service costs Nox nothing
      const c = costUsd(model, u, this.opts.price);
      cost = c === null || cost === null ? null : cost + c;
    }
    this.opts.log?.({ event: "gm_usage", model: this.opts.model.model, ...this.stats, costUsd: cost });
    return {
      ...this.stats.voice,
      rejected: this.personaRejections,
      demoted: this.stats.personaDemoted,
      ...(this.opts.personaModel ? { endpointCalls: this.stats.endpointCalls, endpointErrors: this.stats.endpointErrors } : {}),
      model: this.opts.model.model,
      inputTokens: this.stats.usage.inputTokens + this.stats.usage.cacheReadTokens + this.stats.usage.cacheWriteTokens,
      outputTokens: this.stats.usage.outputTokens,
      costUsd: cost,
    };
  }
}
