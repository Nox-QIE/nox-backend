/**
 * Store key rotation (F01-D06). Shows how many sealed blobs (game secrets, finalize payloads, endpoint
 * secrets) use each key version, and with --apply re-seals them all with the current key: the first
 * entry of NOX_STORE_KEYS, or version 0 (from NOX_WALLET_SECRET) without it. Prints no key.
 *   npm run store:rotate [-- --apply]
 * Rotation: generate a key (openssl rand -hex 32), put it first in NOX_STORE_KEYS with a higher
 * version, restart the bot, run this with --apply, then drop the old version from NOX_STORE_KEYS.
 * Version 0 stays readable for as long as NOX_WALLET_SECRET is set (it also derives the wallets).
 */
import { installLogRedaction, secretsFrom } from "../src/redact.js";
import { SqliteStore, storeKeyring } from "../src/store.js";

installLogRedaction(secretsFrom(process.env));
const ring = storeKeyring(process.env.NOX_WALLET_SECRET, process.env.NOX_STORE_KEYS);
if (!ring) throw new Error("set NOX_WALLET_SECRET and/or NOX_STORE_KEYS");
const store = new SqliteStore(process.env.NOX_DB_PATH || "data/nox.db", ring);
const show = (label: string) =>
  console.log(`${label}: ${Object.entries(store.keyVersions()).map(([v, n]) => `version ${v}: ${n}`).join(", ") || "no sealed data"} (current key: version ${ring.current})`);
show("Before");
if (process.argv.includes("--apply")) {
  console.log(`Re-sealed ${store.reseal()} blob(s).`);
  show("After");
} else console.log("Dry run: add --apply to re-seal with the current key.");
store.close();
