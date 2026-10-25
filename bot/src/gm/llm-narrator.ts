import type { PublicView, Role, Team } from "@nox/shared/engine";
import { esc, unesc, type Lang } from "../i18n.js";
import { TemplateNarrator, type Narrator, type Wording } from "../narrator.js";
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
}

const emptyUsage = (): GmUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
const addUsage = (to: GmUsage, u: GmUsage) => {
  to.inputTokens += u.inputTokens;
  to.outputTokens += u.outputTokens;
  to.cacheReadTokens += u.cacheReadTokens;
  to.cacheWriteTokens += u.cacheWriteTokens;
};

/**
 * AI Game Master. Each beat = one short LLM "flavor" line followed by the template's factual line,
 * so facts never depend on the model. Any failure (timeout, refusal, guard rejection) is retried
 * once, then the template alone is used: a game can never stall on narration.
 *
 * Inputs from the room are HTML-escaped; the model sees raw names and its output is escaped again.
 */
export class LlmNarrator implements Narrator {
  private readonly template: TemplateNarrator;
  private readonly system: string;
  private names: string[] = [];
  readonly stats: GmStats = {
    calls: 0,
    failures: 0,
    fallbacks: 0,
    rejected: {},
    usage: emptyUsage(),
    byModel: {},
  };

  constructor(private readonly opts: LlmNarratorOptions) {
    this.template = new TemplateNarrator(opts.lang, opts.wording);
    this.system = systemPrompt(opts.lang, opts.persona);
  }

  private async flavor(beat: Beat, allowed: string[]): Promise<string | null> {
    const forbidden = this.names.filter((n) => !allowed.includes(n));
    for (let attempt = 0; attempt < 2; attempt++) {
      this.stats.calls++;
      try {
        const r = await this.opts.model.complete(this.system, userPrompt(beat), this.opts.timeoutMs);
        addUsage(this.stats.usage, r.usage);
        addUsage((this.stats.byModel[r.model] ??= emptyUsage()), r.usage);
        const g = checkNarration(r.text, forbidden);
        if (g.ok) return esc(g.text);
        this.stats.rejected[g.reason] = (this.stats.rejected[g.reason] ?? 0) + 1;
      } catch (e) {
        this.stats.failures++;
        this.opts.log?.({ event: "gm_error", beat: beat.kind, error: e instanceof Error ? e.message : String(e) });
      }
    }
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

  finish() {
    let cost: number | null = 0;
    for (const [model, u] of Object.entries(this.stats.byModel)) {
      const c = costUsd(model, u, this.opts.price);
      cost = c === null || cost === null ? null : cost + c;
    }
    this.opts.log?.({ event: "gm_usage", model: this.opts.model.model, ...this.stats, costUsd: cost });
  }
}
