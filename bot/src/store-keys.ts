import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Store encryption keys with versions (F01-D06). Game secrets, finalize payloads and endpoint
 * secrets are sealed with AES-256-GCM. Version 0 is the original key, derived from
 * NOX_WALLET_SECRET; its blobs have no header. NOX_STORE_KEYS ("2:<64 hex>,1:<64 hex>") adds keys
 * that do not depend on the wallet secret: the first one seals, every listed one (and version 0)
 * still opens. A versioned blob starts with "NK" and its key version. `npm run store:rotate`
 * re-seals everything with the current key, after which an old key can be dropped.
 */
export interface StoreKeyring {
  current: number;
  keys: Map<number, Buffer>;
}

/** Version 0: derived from the wallet secret, as before key versions existed. */
export function storeKey(walletSecretHex: string): Buffer {
  const secret = Buffer.from(walletSecretHex.replace(/^0x/, ""), "hex");
  return Buffer.from(hkdfSync("sha256", secret, "nox-store-v1", "game-secrets", 32));
}

/** Parse NOX_STORE_KEYS; throws on a bad entry. Returns null when there is no key at all. */
export function storeKeyring(walletSecretHex: string | undefined, storeKeys?: string): StoreKeyring | null {
  const keys = new Map<number, Buffer>();
  if (walletSecretHex) keys.set(0, storeKey(walletSecretHex));
  let current = walletSecretHex ? 0 : -1;
  for (const [i, entry] of (storeKeys ?? "").split(",").map((e) => e.trim()).filter(Boolean).entries()) {
    const m = /^(\d{1,3}):(?:0x)?([0-9a-fA-F]{64})$/.exec(entry);
    const version = m ? Number(m[1]) : NaN;
    if (!m || version < 1 || version > 255) throw new Error('NOX_STORE_KEYS entries must look like "<version 1-255>:<64 hex>"');
    if (keys.has(version) && version !== 0) throw new Error(`NOX_STORE_KEYS lists version ${version} twice`);
    keys.set(version, Buffer.from(m[2]!, "hex"));
    if (i === 0) current = version;
  }
  return current < 0 ? null : { current, keys };
}

const MAGIC = Buffer.from("NK");

/** The key version a blob was sealed with (0 = no header). */
export function blobVersion(blob: Uint8Array): number {
  const b = Buffer.from(blob);
  return b.length > 3 + 28 && b.subarray(0, 2).equals(MAGIC) ? b[2]! : 0;
}

function encrypt(key: Buffer, value: unknown): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

function decrypt<T>(key: Buffer, b: Buffer): T {
  const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8")) as T;
}

export function seal(ring: StoreKeyring, value: unknown): Buffer {
  const sealed = encrypt(ring.keys.get(ring.current)!, value);
  return ring.current === 0 ? sealed : Buffer.concat([MAGIC, Buffer.from([ring.current]), sealed]);
}

export function open<T>(ring: StoreKeyring, blob: Uint8Array): T {
  const b = Buffer.from(blob);
  const v = blobVersion(b);
  if (v !== 0) {
    const key = ring.keys.get(v);
    if (key) {
      try {
        return decrypt<T>(key, b.subarray(3));
      } catch (e) {
        // A header-less blob whose random IV happens to start with "NK" (1 in 65,536).
        if (!ring.keys.has(0)) throw e;
      }
    } else if (!ring.keys.has(0)) throw new Error(`store key version ${v} is not configured (NOX_STORE_KEYS)`);
  }
  if (!ring.keys.has(0)) throw new Error("this blob needs key version 0 (NOX_WALLET_SECRET)");
  return decrypt<T>(ring.keys.get(0)!, b);
}
