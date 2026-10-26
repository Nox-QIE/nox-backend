import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Web login from the bot (NOX-APP-14): no password. In a private chat, /web gives the player a link
 * holding a signed login token for their game wallet. It lives 10 minutes and works once. The web
 * app trades it at POST /v1/login for a session token (7 days) and shows the player's own pages
 * with it. The token sits in the URL fragment (#t=…), which browsers never send to a server, so it
 * does not end up in server logs. Bot and API share NOX_LOGIN_SECRET; neither needs the wallet secret.
 */
export const LOGIN_TTL_S = 10 * 60;
export const SESSION_TTL_S = 7 * 86_400;

export interface Claims {
  /** "login" (one-time, from the bot) or "session" (from POST /v1/login). */
  k: "login" | "session";
  /** The player's game wallet (lower case). */
  a: string;
  /** Expiry, Unix seconds. */
  e: number;
  /** One-time nonce of a login token. */
  n?: string;
}

/** NOX_LOGIN_SECRET: at least 32 bytes of hex; null when unset (web login off). */
export function loginSecret(hex: string | undefined): Buffer | null {
  if (!hex) return null;
  const clean = hex.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64,}$/.test(clean)) throw new Error("NOX_LOGIN_SECRET must be at least 32 bytes of hex (openssl rand -hex 32)");
  return Buffer.from(clean, "hex");
}

const mac = (secret: Buffer, body: string) => createHmac("sha256", secret).update(`nox-web-login.${body}`).digest();

function sign(secret: Buffer, claims: Claims): string {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${body}.${mac(secret, body).toString("base64url")}`;
}

export const loginToken = (secret: Buffer, address: string, nowS: number) =>
  sign(secret, { k: "login", a: address.toLowerCase(), e: nowS + LOGIN_TTL_S, n: randomBytes(16).toString("hex") });

export const sessionToken = (secret: Buffer, address: string, nowS: number) => sign(secret, { k: "session", a: address.toLowerCase(), e: nowS + SESSION_TTL_S });

/** The claims of a valid, unexpired token of `kind`, or why it is not one. */
export function verifyToken(secret: Buffer, token: string, kind: Claims["k"], nowS: number): Claims | { error: string } {
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined || token.length > 1024) return { error: "malformed token" };
  const want = mac(secret, body);
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { error: "bad signature" };
  let c: Claims;
  try {
    c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Claims;
  } catch {
    return { error: "malformed token" };
  }
  if (c.k !== kind) return { error: `not a ${kind} token` };
  if (!/^0x[0-9a-f]{40}$/.test(c.a ?? "") || !Number.isInteger(c.e)) return { error: "malformed token" };
  if (c.e <= nowS) return { error: "expired" };
  if (kind === "login" && !/^[0-9a-f]{32}$/.test(c.n ?? "")) return { error: "malformed token" };
  return c;
}

/** The link the bot sends: the token in the fragment, never in the path or query. */
export const loginLink = (webUrl: string, token: string) => `${webUrl.replace(/\/+$/, "")}/login/#t=${token}`;
