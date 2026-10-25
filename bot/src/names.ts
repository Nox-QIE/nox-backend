import { contentProblem } from "./gm/guard.js";
import type { Lang } from "./i18n.js";

/** Invisible or direction-changing characters people use to disguise names. */
const INVISIBLE = /[\u0000-\u001F\u007F-\u009F­​-‏‪-‮⁠-⁤﻿]/g;
/** Anything Telegram might turn into a link: a dotted name ending in letters (nox-bonus.xyz, a.b.id). */
const DOMAIN = /[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}/i;
const MAX = 32;

/**
 * Display names are typed by players and echoed by the bot in group messages, so they are an
 * attack surface (phishing links, fake @admin mentions, "deposit here"). Clean them up, and replace
 * any name that still looks like a link, mention, markup or money talk with a neutral seat alias.
 */
export function safeName(raw: string, seat: number, lang: Lang): string {
  const alias = `${lang === "id" ? "Pemain" : "Player"} ${seat}`;
  const name = raw.normalize("NFKC").replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  if (!name || contentProblem(name) || DOMAIN.test(name) || name.includes("@")) return alias;
  return name.length > MAX ? `${name.slice(0, MAX - 1)}…` : name;
}
