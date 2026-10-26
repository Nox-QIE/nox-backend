export const MAX_NARRATION_CHARS = 500;

export type GuardResult = { ok: true; text: string } | { ok: false; reason: string };

// Any "name.tld" counts as a link, not just well-known TLDs (red-team: "nox-gift.click" slipped
// through the old list), also with spaces around the dot or the dot spelled out.
const TLD = "[a-z]{2,24}";
const LINK = new RegExp(
  [
    "https?:\\/\\/",
    "www\\.",
    "t\\.me\\/",
    // "a.b" or "a . b": a normal sentence end ("ends. Morning") has no space before the dot.
    `\\b[a-z0-9][a-z0-9-]*(\\.| \\. )${TLD}\\b`,
    `\\b[a-z0-9-]+\\s*[([]?\\s*(dot|titik)\\s*[)\\]]?\\s*${TLD}\\b`,
  ].join("|"),
  "i",
);
const MARKUP = /[<>]|\*\*|__|`/;
const CURRENCY = "(qie|qusdc|usdt|usdc|eth|btc|bnb|idr|rupiah|rp)";
const MONEY = new RegExp(
  [
    "\\b(deposit|wallet|seed phrase|private key|airdrop|transfer|setor|dompet|hadiah uang|cash ?out|withdraw|tarik dana|rekening|otp|pin)\\b",
    "\\b0x[0-9a-f]{6,}", // a wallet address
    `\\b\\d+([.,]\\d+)*\\s?${CURRENCY}\\b`, // "0.1 QIE", "50.000 rupiah"
    "\\brp\\.?\\s?\\d", // "Rp 50.000"
    `\\b(send|kirim|bayar|pay)\\b[^.!?]{0,40}\\b${CURRENCY}\\b`, // "send ... QIE"
  ].join("|"),
  "i",
);
/** Invisible characters used to break up links and words (zero-width space, joiners, BOM, word joiner). */
const INVISIBLE = /[\u200b-\u200d\u2060\ufeff\u00ad]/g;

const norm = (s: string) => s.normalize("NFKC").toLowerCase();
const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whole-word match, so "Ben" does not hit "bentuk" and "Ava" does not hit "lava". */
const mentions = (text: string, name: string) => new RegExp(`(?<![\\p{L}\\p{N}])${reEscape(name)}(?![\\p{L}\\p{N}])`, "u").test(text);

/** Problems shared by narration and third-party persona text: links, markup, mentions, money talk. */
export function contentProblem(raw: string): "link" | "markup" | "mention" | "money" | null {
  const text = raw.replace(INVISIBLE, "");
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
  const text = raw.replace(INVISIBLE, "").trim();
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
