import { describe, expect, it } from "vitest";
import { PlayerWallets } from "../src/chain/wallets.js";
import { loadChainConfig } from "../src/config.js";

const SECRET = "11".repeat(32);

describe("PlayerWallets", () => {
  it("derives a stable, distinct address per Telegram user", () => {
    const a = PlayerWallets.fromHex(SECRET);
    const b = PlayerWallets.fromHex(`0x${SECRET}`);
    expect(a.address(42)).toBe(b.address(42));
    expect(a.address(42)).not.toBe(a.address(43));
    expect(PlayerWallets.fromHex("22".repeat(32)).address(42)).not.toBe(a.address(42));
    expect(a.privateKey(42)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("rejects short or non-hex secrets", () => {
    expect(() => PlayerWallets.fromHex("11".repeat(16))).toThrow("32 bytes");
    expect(() => PlayerWallets.fromHex("zz".repeat(32))).toThrow("hex");
  });
});

describe("loadChainConfig", () => {
  const ok = {
    NOX_CHAIN: "testnet",
    NOX_GAME_ADDRESS: "0x" + "ab".repeat(20),
    NOX_OPERATOR_KEY: "0x" + "cd".repeat(32),
    NOX_WALLET_SECRET: SECRET,
  };

  it("is off by default and needs nothing else", () => {
    expect(loadChainConfig({}).network).toBe("off");
  });

  it("parses QIE amounts for the gas drip", () => {
    const c = loadChainConfig({ ...ok, NOX_GAS_DRIP: "0.002", NOX_GAS_MIN: "0.0005" });
    expect(c.dripWei).toBe(2_000_000_000_000_000n);
    expect(c.minWei).toBe(500_000_000_000_000n);
    expect(() => loadChainConfig({ ...ok, NOX_GAS_DRIP: "1e-3" })).toThrow("QIE amount");
  });

  it("requires contract address, operator key and wallet secret when on", () => {
    expect(() => loadChainConfig({ ...ok, NOX_GAME_ADDRESS: "" })).toThrow("NOX_GAME_ADDRESS");
    expect(() => loadChainConfig({ ...ok, NOX_OPERATOR_KEY: "" })).toThrow("NOX_OPERATOR_KEY");
    expect(() => loadChainConfig({ ...ok, NOX_OPERATOR_KEY: "0x12" })).toThrow("64 hex");
    expect(() => loadChainConfig({ ...ok, NOX_WALLET_SECRET: "ab" })).toThrow("NOX_WALLET_SECRET");
    expect(() => loadChainConfig({ ...ok, NOX_CHAIN: "goerli" })).toThrow("NOX_CHAIN");
  });

  it("defaults the local RPC to anvil", () => {
    expect(loadChainConfig({ ...ok, NOX_CHAIN: "local" }).rpcUrl).toBe("http://127.0.0.1:8545");
  });
});
