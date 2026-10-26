import { format } from "node:util";

/**
 * Keys never reach the logs (F11-D04). Every line the process writes through console is checked for
 * the secrets it was configured with (operator key, wallet secret, bot token, API keys, webhook
 * secret) and each is replaced, so a key leaked into an error message by any library (an RPC error,
 * a grammY request URL) is still hidden. Hex secrets match with or without 0x, in any letter case.
 */
export const SECRET_ENV = ["NOX_OPERATOR_KEY", "NOX_WALLET_SECRET", "BOT_TOKEN", "OXION_API_KEY", "ANTHROPIC_API_KEY", "NOX_WEBHOOK_SECRET", "NOX_STORE_KEYS"] as const;
const MIN_SECRET = 16; // shorter values would hide ordinary text and are no real secret

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function makeRedactor(secrets: (string | undefined)[]): (text: string) => string {
  const patterns = [...new Set(secrets.filter((s): s is string => !!s && s.length >= MIN_SECRET))]
    .map((s) => s.replace(/^0x/i, ""))
    .sort((a, b) => b.length - a.length)
    .map((s) => new RegExp(`(0x)?${escapeRe(s)}`, /^[0-9a-f]+$/i.test(s) ? "gi" : "g"));
  if (!patterns.length) return (t) => t;
  return (text) => patterns.reduce((t, re) => t.replace(re, "[redacted]"), text);
}

/** Route console.log/info/warn/error through the redactor. Returns a function that restores console. */
export function installLogRedaction(secrets: (string | undefined)[], con: Pick<Console, "log" | "info" | "warn" | "error"> = console): () => void {
  const redact = makeRedactor(secrets);
  const original = { log: con.log, info: con.info, warn: con.warn, error: con.error };
  for (const k of ["log", "info", "warn", "error"] as const) {
    const write = original[k];
    con[k] = (...args: unknown[]) => write.call(con, redact(format(...args)));
  }
  return () => Object.assign(con, original);
}

/** The secrets in an environment, for installLogRedaction. */
// NOX_STORE_KEYS holds several keys ("2:<hex>,1:<hex>"): each one is hidden on its own, too.
export const secretsFrom = (env: NodeJS.ProcessEnv) =>
  SECRET_ENV.flatMap((k) => (k === "NOX_STORE_KEYS" ? [env[k], ...(env[k] ?? "").split(",").map((e) => e.split(":").pop())] : [env[k]]));
