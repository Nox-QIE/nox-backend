import { describe, expect, it } from "vitest";
import { installLogRedaction, makeRedactor, secretsFrom } from "../src/redact.js";

const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // anvil's public dev key
const TOKEN = "123456789:AAH-test_token_value_for_redaction";
const TX = "0x684c14942e9e004c59fcb11e39f1ba7df74f5ca23c4fc347de65038b333f4057"; // a game id, not a secret

describe("secrets never reach the logs (F11-D04)", () => {
  it("hides each secret with or without 0x, in any case, and leaves other hex alone", () => {
    const redact = makeRedactor([KEY, TOKEN, "short", undefined]);
    expect(redact(`signer ${KEY} failed`)).toBe("signer [redacted] failed");
    expect(redact(`key=${KEY.slice(2).toUpperCase()}`)).toBe("key=[redacted]");
    expect(redact(`https://api.telegram.org/bot${TOKEN}/sendMessage`)).toBe("https://api.telegram.org/bot[redacted]/sendMessage");
    expect(redact(`game ${TX} short`)).toBe(`game ${TX} short`);
  });

  it("covers everything written through console, including errors from libraries", () => {
    const out: string[] = [];
    const write = (...a: unknown[]) => void out.push(a.map(String).join(" "));
    const con = { log: write, info: write, warn: write, error: write };
    const restore = installLogRedaction(secretsFrom({ NOX_OPERATOR_KEY: KEY, BOT_TOKEN: TOKEN }), con as never);
    con.log(JSON.stringify({ event: "chain_error", error: `invalid key ${KEY}` }));
    con.error("bot error", new Error(`401 at /bot${TOKEN}/getMe`));
    con.warn("%s", KEY.slice(2));
    expect(out.join("\n")).not.toMatch(new RegExp(`${KEY.slice(2)}|${TOKEN}`, "i"));
    expect(out[0]).toBe('{"event":"chain_error","error":"invalid key [redacted]"}');
    expect(out[1]).toContain("401 at /bot[redacted]/getMe");
    restore();
    con.log(`after ${KEY}`);
    expect(out.at(-1)).toBe(`after ${KEY}`); // restored: the original writer again
  });

  it("does nothing without secrets", () => {
    expect(makeRedactor([])("plain text 0xabc")).toBe("plain text 0xabc");
  });
});
