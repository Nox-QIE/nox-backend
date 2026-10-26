import { contentProblem } from "./gm/guard.js";
import type { Persona } from "./gm/prompt.js";
import type { Lang } from "./i18n.js";

export type { Persona };

/** A Game Master from the Agent Marketplace (F18). Hosted personas run on Nox's own LLM. */
export interface AgentRecord {
  id: number;
  owner: string;
  persona: Persona;
  status: "active" | "suspended";
  /** Id in NoxAgentRegistry once registered on-chain, for revenue settlement. */
  chainAgentId: number | null;
}

const LIMITS = { name: [2, 32], tagline: [0, 80], style: [40, 1200], example: [0, 200], examples: 3 } as const;

/**
 * Automatic checks before an operator reviews a persona: sizes, languages, and the same content
 * rules as narration (no links, markup, @mentions or money talk). Returns a list of problems.
 */
export function checkPersona(p: Persona): string[] {
  const problems: string[] = [];
  const len = (field: string, v: string, [min, max]: readonly [number, number]) => {
    if (v.trim().length < min || v.length > max) problems.push(`${field} must be ${min}–${max} characters`);
  };
  len("name", p.name, LIMITS.name);
  len("tagline", p.tagline, LIMITS.tagline);
  len("style", p.style, LIMITS.style);
  if (p.examples.length > LIMITS.examples) problems.push(`at most ${LIMITS.examples} examples`);
  p.examples.forEach((e, i) => len(`example ${i + 1}`, e, LIMITS.example));
  if (!p.langs.length || p.langs.some((l: Lang) => l !== "id" && l !== "en")) problems.push('langs must be "id" and/or "en"');
  for (const [field, text] of [["name", p.name], ["tagline", p.tagline], ["style", p.style], ...p.examples.map((e, i) => [`example ${i + 1}`, e])] as [string, string][]) {
    const problem = contentProblem(text);
    if (problem) problems.push(`${field}: no ${problem}`);
  }
  return problems;
}

/** Owner payout wallet must be an EVM address. */
export const isAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);

/** Automatic suspension rules (F18-S11), over an agent's most recent games. */
export const HEALTH = { window: 10, maxDemotedGames: 3, minGamesForShare: 5, minPersonaShare: 0.5 } as const;

/**
 * Why an agent should be suspended now, or null. `recent` is newest first. A persona is set aside
 * in a game after repeated guard rejections; doing that in several recent games, or leaving most
 * lines to Nox's own voice or the template, means players are not getting the agent they picked.
 */
export function suspensionReason(recent: { persona: number; nox: number; template: number; demoted: boolean }[]): string | null {
  const games = recent.slice(0, HEALTH.window);
  const demoted = games.filter((g) => g.demoted).length;
  if (demoted >= HEALTH.maxDemotedGames) return `persona set aside in ${demoted} of the last ${games.length} games (guard rejections)`;
  if (games.length >= HEALTH.minGamesForShare) {
    // Template-only beats mean every voice failed (a provider outage), which is not the agent's doing.
    const beats = games.reduce((n, g) => n + g.persona + g.nox, 0);
    const own = games.reduce((n, g) => n + g.persona, 0);
    if (beats > 0 && own / beats < HEALTH.minPersonaShare) {
      return `persona wrote ${Math.round((100 * own) / beats)}% of the lines in the last ${games.length} games (minimum ${HEALTH.minPersonaShare * 100}%)`;
    }
  }
  return null;
}
