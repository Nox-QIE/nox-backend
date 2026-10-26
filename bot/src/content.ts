import { configHash } from "@nox/shared/crypto-spec";
import type { Hex } from "viem";
import type { Role, Team } from "@nox/shared/engine";
import type { AgentRecord } from "./agents.js";
import type { Wording } from "./narrator.js";
import { SCENARIOS, type Scenario } from "./scenarios.js";
import { THEMES } from "./themes.js";

/**
 * Versioned game content (L1-07, F09-D02, F10-D01). Themes and scenarios carry a version; the hash
 * covers all their text (functions included as source), so the game config committed on chain at
 * createGame names the exact content a game used. content.lock.json records each version's hash and
 * a test fails when text changes without a version bump.
 */
export interface ContentRef {
  id: string;
  version: number;
  hash: Hex;
}

/**
 * Scenario wording is code; its source text depends on the transpiler (tsx and vitest print
 * functions differently), so the hash covers what it renders for fixed sample inputs instead.
 */
function renderWording(w: Wording) {
  const roles: Role[] = ["werewolf", "seer", "doctor", "villager"];
  return {
    role: w.role ? roles.map((r) => w.role!(r)) : null,
    team: w.team ? (["village", "wolves"] as Team[]).map((t) => w.team!(t)) : null,
    intro: w.intro?.(["{a}", "{b}"]) ?? null,
    nightFalls: w.nightFalls?.(7) ?? null,
    morningVictim: w.morningVictim?.("{name}", "{role}") ?? null,
    morningNone: w.morningNone ?? null,
    dayOut: w.dayOut?.("{name}", "{role}") ?? null,
    dayNone: w.dayNone ?? null,
  };
}

/** JSON-safe copy; a function anywhere else would make the hash depend on the build, so it is refused. */
function serializable(v: unknown, path = ""): unknown {
  if (typeof v === "function") throw new Error(`content hash: unexpected function at ${path || "root"}`);
  if (Array.isArray(v)) return v.map((x, i) => serializable(x, `${path}[${i}]`));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "wording" ? renderWording(x as Wording) : serializable(x, `${path}.${k}`)]));
  }
  return v;
}

const hashOf = (v: unknown) => configHash(serializable(v)) as Hex;

export function themeRefs(): ContentRef[] {
  return THEMES.map((t) => ({ id: `theme:${t.keys[0]}`, version: t.version, hash: hashOf({ keys: t.keys, id: t.id_, en: t.en }) }));
}

export function scenarioRef(s: Scenario): ContentRef {
  return { id: `scenario:${s.key}`, version: s.version, hash: hashOf({ keywords: s.keywords, checkedAt: s.checkedAt, text: s.text }) };
}

export function contentCatalog(): ContentRef[] {
  return [...themeRefs(), ...SCENARIOS.map(scenarioRef)];
}

/** The Game Master of a game: Nox's own, a Nox theme, or a Marketplace agent (persona or endpoint). */
export function gmRef(agent: AgentRecord | undefined): { id: string; version?: number; hash?: Hex } {
  if (!agent) return { id: "nox" };
  if (agent.id < 0) {
    const t = THEMES.find((x) => x.id === agent.id);
    const ref = t ? themeRefs().find((r) => r.id === `theme:${t.keys[0]}`) : undefined;
    return ref ? { id: ref.id, version: ref.version, hash: ref.hash } : { id: `theme:${agent.id}` };
  }
  return { id: `agent:${agent.id}`, hash: hashOf({ persona: agent.persona, mode: agent.mode ?? "persona", endpoint: agent.endpoint ?? null }) };
}
