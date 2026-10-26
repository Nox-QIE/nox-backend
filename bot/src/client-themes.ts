import type { Role } from "@nox/shared/engine";
import { checkPersona, type AgentRecord } from "./agents.js";
import { contentProblem } from "./gm/guard.js";
import type { Lang } from "./i18n.js";

/**
 * Client themes (F04-S05, F04-D03): a Game Master style and, optionally, custom role names made for
 * one B2B client. They live in the bot store with their client as owner, and a lobby only gets one
 * when it is opened from that client's paid booking (`theme: "client:<key>"`), so a client theme
 * never shows up in another group. Saving the same key again raises its version; the version and a
 * hash of the text go into the game's committed config.
 */
export interface ClientThemeText {
  name: string;
  tagline: string;
  style: string;
  examples: string[];
  /** Custom names for the roles, e.g. { werewolf: "🕵️ Penyusup" }; missing ones keep Nox's names. */
  roles?: Partial<Record<Role, string>>;
}

export interface ClientTheme {
  key: string;
  /** The client who owns it (as on their bookings). */
  client: string;
  version: number;
  text: Partial<Record<Lang, ClientThemeText>>;
}

/** Agent ids of client themes: below every Nox theme, and negative so revenue counts them as Nox's own. */
export const CLIENT_THEME_BASE = -1000;

const ROLES: Role[] = ["werewolf", "seer", "doctor", "villager"];

export function checkClientTheme(t: Omit<ClientTheme, "version">): string[] {
  const problems: string[] = [];
  if (!/^[a-z0-9-]{2,32}$/.test(t.key ?? "")) problems.push("key must be 2–32 characters of a-z, 0-9 and -");
  if (!t.client?.trim()) problems.push("client is required");
  const langs = Object.keys(t.text ?? {}) as Lang[];
  if (!langs.length || langs.some((l) => l !== "id" && l !== "en")) problems.push('text must have "id" and/or "en"');
  for (const lang of langs.filter((l) => l === "id" || l === "en")) {
    const x = t.text[lang]!;
    // A client may use its own brand in its own theme, so only the brand check is skipped.
    for (const p of checkPersona({ name: x.name, tagline: x.tagline ?? "", style: x.style, examples: x.examples ?? [], langs: [lang] }, { brand: true })) problems.push(`${lang}: ${p}`);
    for (const [role, label] of Object.entries(x.roles ?? {})) {
      if (!ROLES.includes(role as Role)) problems.push(`${lang}: unknown role ${role}`);
      else if (label.trim().length < 1 || label.length > 24) problems.push(`${lang}: role ${role} must be 1–24 characters`);
      else if (contentProblem(label)) problems.push(`${lang}: role ${role}: no ${contentProblem(label)}`);
    }
  }
  return problems;
}

/** The theme as Game Masters for a lobby, one per language it has. `rowId` comes from the store. */
export function clientThemeAgents(t: ClientTheme, rowId: number): AgentRecord[] {
  return (Object.entries(t.text) as [Lang, ClientThemeText][]).map(([lang, x]) => ({
    id: CLIENT_THEME_BASE - rowId,
    owner: "",
    persona: { name: x.name, tagline: x.tagline ?? "", style: x.style, examples: x.examples ?? [], langs: [lang] },
    status: "active",
    chainAgentId: null,
    ...(x.roles ? { roles: x.roles } : {}),
    ref: { id: `client-theme:${t.key}`, version: t.version },
  }));
}
