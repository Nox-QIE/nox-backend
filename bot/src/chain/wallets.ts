import { hkdfSync } from "node:crypto";
import { toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

// secp256k1 group order: a private key must be in [1, n - 1].
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/**
 * Invisible player wallets, derived instead of stored: key = HKDF-SHA256(secret, "nox-wallet-v1",
 * "player:<telegramId>"). No key database to leak or back up, and the same player always gets the
 * same address. The secret (NOX_WALLET_SECRET) protects every wallet, so it lives only in the env /
 * secret manager. See docs/adr/ADR-002-chain-integration.md.
 */
export class PlayerWallets {
  private readonly cache = new Map<number, PrivateKeyAccount>();

  constructor(private readonly secret: Uint8Array) {
    if (secret.length < 32) throw new Error("NOX_WALLET_SECRET must be at least 32 bytes");
  }

  static fromHex(secretHex: string) {
    const clean = secretHex.replace(/^0x/, "");
    if (!/^[0-9a-fA-F]+$/.test(clean)) throw new Error("NOX_WALLET_SECRET must be hex");
    return new PlayerWallets(Uint8Array.from(Buffer.from(clean, "hex")));
  }

  privateKey(userId: number): Hex {
    for (let counter = 0; ; counter++) {
      const info = counter === 0 ? `player:${userId}` : `player:${userId}:${counter}`;
      const k = Buffer.from(hkdfSync("sha256", this.secret, "nox-wallet-v1", info, 32));
      const n = BigInt(`0x${k.toString("hex")}`);
      if (n > 0n && n < N) return toHex(k);
    }
  }

  account(userId: number): PrivateKeyAccount {
    let a = this.cache.get(userId);
    if (!a) {
      a = privateKeyToAccount(this.privateKey(userId));
      this.cache.set(userId, a);
    }
    return a;
  }

  address(userId: number): Address {
    return this.account(userId).address;
  }
}
