import type { NightActionKind, Role, Team } from "@nox/shared/engine";
import type { Lang } from "./i18n.js";

/**
 * Rare moments of a game, each a non-transferable badge on NoxBadges (10.07 #4). They are computed
 * from what the game revealed at its end, so anyone can check them against the chain: the roles, the
 * night actions (opened at the reveal) and who was still alive.
 */
export type BadgeKey = "SCAM_SPOTTER" | "PERFECT_SEER" | "LAST_WOLF_STANDING" | "SECOND_LIFE" | "GUARDIAN";

/** Display names (English, like every feature name) and what each one means, per language. */
export const BADGES: Record<BadgeKey, { name: string; why: Record<Lang, string> }> = {
  SCAM_SPOTTER: { name: "Scam Spotter", why: { id: "grup membongkar penipu di Scam Shield", en: "the group exposed the scammer in Scam Shield" } },
  PERFECT_SEER: { name: "Perfect Seer", why: { id: "setiap penyelidikan menemukan werewolf", en: "every inspection found a werewolf" } },
  LAST_WOLF_STANDING: { name: "Last Wolf Standing", why: { id: "werewolf terakhir yang hidup, dan werewolf menang", en: "the last werewolf alive, and the wolves won" } },
  SECOND_LIFE: { name: "Second Life", why: { id: "diserang werewolf, diselamatkan dokter, dan bertahan sampai akhir", en: "attacked by the wolves, saved by the doctor, alive at the end" } },
  GUARDIAN: { name: "Guardian", why: { id: "menggagalkan serangan werewolf (dokter atau obat witch)", en: "stopped a werewolf attack (doctor or the witch's heal)" } },
};

export interface NightLogEntry {
  round: number;
  actor: string;
  kind: NightActionKind;
  target: string;
}

/** Who earned which rare moment in a finished game (Scam Spotter is awarded by the scenario itself). */
export function rareMoments(o: { roles: Record<string, Role>; alive: Record<string, boolean>; winner: Team; nights: NightLogEntry[] }): Map<BadgeKey, string[]> {
  const out = new Map<BadgeKey, string[]>();
  const add = (k: BadgeKey, id: string) => out.set(k, [...new Set([...(out.get(k) ?? []), id])]);

  // Perfect Seer: at least one inspection, and every one of them found a werewolf.
  const inspections = o.nights.filter((n) => n.kind === "inspect");
  for (const seer of new Set(inspections.map((n) => n.actor))) {
    const mine = inspections.filter((n) => n.actor === seer);
    if (mine.every((n) => o.roles[n.target] === "werewolf")) add("PERFECT_SEER", seer);
  }

  // A save: the doctor (or the witch's heal) protected the player a werewolf chose the same night.
  for (const p of o.nights.filter((n) => n.kind === "protect" || n.kind === "heal")) {
    const attacked = o.nights.some((n) => n.kind === "kill" && n.round === p.round && n.target === p.target);
    if (!attacked) continue;
    add("GUARDIAN", p.actor);
    if (o.alive[p.target] && o.roles[p.target] !== "werewolf") add("SECOND_LIFE", p.target);
  }

  // Last Wolf Standing: the wolves won with exactly one of them alive.
  if (o.winner === "wolves") {
    const living = Object.keys(o.roles).filter((id) => o.roles[id] === "werewolf" && o.alive[id]);
    if (living.length === 1) add("LAST_WOLF_STANDING", living[0]!);
  }
  return out;
}
