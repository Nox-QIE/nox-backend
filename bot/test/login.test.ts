import { describe, expect, it } from "vitest";
import { LOGIN_TTL_S, loginLink, loginSecret, loginToken, sessionToken, verifyToken } from "../src/login.js";

const secret = loginSecret("ab".repeat(32))!;
const wallet = "0x00000000000000000000000000000000000000AA";
const NOW = 1_800_000_000;

describe("web login tokens (NOX-APP-14)", () => {
  it("signs a one-time login token for the game wallet, and a session from it", () => {
    const t = loginToken(secret, wallet, NOW);
    const c = verifyToken(secret, t, "login", NOW + 60);
    expect(c).toMatchObject({ k: "login", a: wallet.toLowerCase(), e: NOW + LOGIN_TTL_S, n: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(loginToken(secret, wallet, NOW)).not.toBe(t); // a fresh nonce every time
    const s = sessionToken(secret, wallet, NOW);
    expect(verifyToken(secret, s, "session", NOW + 86_400)).toMatchObject({ k: "session", a: wallet.toLowerCase() });
  });

  it("refuses expired, tampered, foreign and mixed-up tokens", () => {
    const t = loginToken(secret, wallet, NOW);
    expect(verifyToken(secret, t, "login", NOW + LOGIN_TTL_S)).toEqual({ error: "expired" });
    expect(verifyToken(secret, t, "session", NOW)).toEqual({ error: "not a session token" });
    expect(verifyToken(loginSecret("cd".repeat(32))!, t, "login", NOW)).toEqual({ error: "bad signature" });
    const [body, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ k: "login", a: "0x" + "bb".repeat(20), e: NOW + 600, n: "0".repeat(32) })).toString("base64url");
    expect(verifyToken(secret, `${forged}.${sig}`, "login", NOW)).toEqual({ error: "bad signature" });
    expect(verifyToken(secret, `${body}`, "login", NOW)).toEqual({ error: "malformed token" });
    expect(verifyToken(secret, "x.y.z", "login", NOW)).toEqual({ error: "malformed token" });
  });

  it("puts the token in the URL fragment, which browsers never send to a server", () => {
    expect(loginLink("https://nox.example/", "abc.def")).toBe("https://nox.example/login/#t=abc.def");
    expect(loginSecret(undefined)).toBeNull();
    expect(() => loginSecret("abcd")).toThrow("NOX_LOGIN_SECRET");
  });
});
