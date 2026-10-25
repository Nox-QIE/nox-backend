export const MAX_NARRATION_CHARS = 500;

export type GuardResult = { ok: true; text: string } | { ok: false; reason: string };

const LINK = /(https?:\/\/|www\.|t\.me\/|\b[a-z0-9-]+\.(com|io|xyz|me|org|net|app|digital|qie)\b)/i;
const MARKUP = /[<>]|\*\*|__|`/;
const MONEY = /\b(deposit|wallet|seed phrase|private key|airdrop|transfer|setor|dompet|hadiah uang)\b/i;

const norm = (s: string) => s.normalize("NFKC").toLowerCase();
const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whole-word match, so "Ben" does not hit "bentuk" and "Ava" does not hit "lava". */
const mentions = (text: string, name: string) => new RegExp(`(?<![\\p{L}\\p{N}])${reEscape(name)}(?![\\p{L}\\p{N}])`, "u").test(text);

/** Problems shared by narration and third-party persona text: links, markup, mentions, money talk. */
export function contentProblem(text: string): "link" | "markup" | "mention" | "money" | null {
  if (LINK.test(text)) return "link";
  if (MARKUP.test(text)) return "markup";
  if (/@\w/.test(text)) return "mention";
  if (MONEY.test(text)) return "money";
  return null;
}

/**
 * Reject narration that names a forbidden player (anyone still alive, unless explicitly allowed),
 * carries links or markup, or talks about money. Names are matched case-insensitively as whole words;
 * a false positive only costs us the flavor text.
 */
export function checkNarration(raw: string, forbiddenNames: string[]): GuardResult {
  const text = raw.trim();
  if (!text) return { ok: false, reason: "empty" };
  if (text.length > MAX_NARRATION_CHARS) return { ok: false, reason: "too_long" };
  if (LINK.test(text)) return { ok: false, reason: "link" };
  if (MARKUP.test(text)) return { ok: false, reason: "markup" };
  if (MONEY.test(text)) return { ok: false, reason: "money" };
  if (/@\w/.test(text)) return { ok: false, reason: "mention" };
  const t = norm(text);
  for (const name of forbiddenNames) {
    const n = norm(name).trim();
    if (n && mentions(t, n)) return { ok: false, reason: "names_living_player" };
  }
  return { ok: true, text };
}
