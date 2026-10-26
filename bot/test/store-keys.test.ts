import { describe, expect, it } from "vitest";
import { makeRedactor, secretsFrom } from "../src/redact.js";
import { blobVersion, open, seal, storeKeyring } from "../src/store-keys.js";
import { SqliteStore, storeKey } from "../src/store.js";
import { tempDbPath } from "./fakes.js";

const WALLET = "ab".repeat(32);
const K1 = "11".repeat(32);
const K2 = "22".repeat(32);
const secret = { roles: { "11": "werewolf" }, salts: ["0x01"], proofs: [], nights: [] };

describe("store key versions and rotation (F01-D06)", () => {
  it("parses NOX_STORE_KEYS: the first entry seals, version 0 comes from the wallet secret", () => {
    expect(storeKeyring(undefined)).toBeNull();
    expect(storeKeyring(WALLET)!.current).toBe(0);
    const ring = storeKeyring(WALLET, `2:${K2}, 1:0x${K1}`)!;
    expect(ring.current).toBe(2);
    expect([...ring.keys.keys()].sort()).toEqual([0, 1, 2]);
    expect(storeKeyring(undefined, `3:${K1}`)!.current).toBe(3);
    expect(() => storeKeyring(WALLET, "2:abc")).toThrow("NOX_STORE_KEYS");
    expect(() => storeKeyring(WALLET, `0:${K1}`)).toThrow("NOX_STORE_KEYS");
    expect(() => storeKeyring(WALLET, `2:${K1},2:${K2}`)).toThrow("twice");
  });

  it("seals with the current version and opens every configured one", () => {
    const old = storeKeyring(WALLET)!;
    const legacy = seal(old, secret);
    expect(blobVersion(legacy)).toBe(0);
    const ring = storeKeyring(WALLET, `2:${K2},1:${K1}`)!;
    const fresh = seal(ring, secret);
    expect(blobVersion(fresh)).toBe(2);
    expect(open(ring, legacy)).toEqual(secret);
    expect(open(ring, fresh)).toEqual(secret);
    expect(() => open(storeKeyring(undefined, `1:${K1}`)!, fresh)).toThrow("version 2 is not configured");
    expect(() => open(storeKeyring(undefined, `2:${K1}`)!, fresh)).toThrow(); // wrong key for version 2
  });

  it("re-seals a whole store onto the new key, after which the old key is not needed", () => {
    const path = tempDbPath("rotate");
    const before = new SqliteStore(path, storeKey(WALLET)); // a store from before key versions
    before.saveGame(("0x" + "aa".repeat(32)) as `0x${string}`, -1, "id", secret as never);
    before.addEndpointAgent("0x" + "11".repeat(20), { name: "Rogue", tagline: "", style: "x".repeat(50), examples: [], langs: ["en"] }, "https://a.example/gm", "sig-secret", 1);
    expect(before.keyVersions()).toEqual({ 0: 2 });
    before.close();

    const rotating = new SqliteStore(path, storeKeyring(WALLET, `1:${K1}`));
    expect(rotating.reseal()).toBe(2);
    expect(rotating.reseal()).toBe(0);
    expect(rotating.keyVersions()).toEqual({ 1: 2 });
    rotating.close();

    const after = new SqliteStore(path, storeKeyring(undefined, `1:${K1}`));
    expect(after.unsettledGames()[0]!.secret).toEqual(secret);
    expect(after.agentSecret(1)).toBe("sig-secret");
  });

  it("hides every store key in the logs", () => {
    const hide = makeRedactor(secretsFrom({ NOX_STORE_KEYS: `2:${K2},1:${K1}` }));
    expect(hide(`key ${K1} and ${K2}`)).not.toMatch(/1111|2222/);
  });
});
