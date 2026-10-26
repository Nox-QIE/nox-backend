import { createHmac, randomBytes } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import type { Lang } from "../i18n.js";
import type { GmCompletion, GmModel } from "./model.js";

/**
 * External Game Master endpoints (F18-S10, F18-D03). An agent owner runs their own service; Nox
 * calls it for the flavor line of each beat. Nox only ever sends the public facts it would give its
 * own LLM, signs every request with the agent's secret, and treats the answer like any model output
 * (guard, then Nox's own voice, then the template).
 *
 * The URL is attacker-chosen, so the client must not become a way into Nox's network (SSRF): https
 * only, port 443, no credentials, no redirects, and every address the name resolves to is checked
 * at connect time (not just at registration), which also defeats DNS rebinding.
 */

const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata (169.254.169.254)
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
] as const)
  BLOCKED.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["100::", 64], // discard
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const)
  BLOCKED.addSubnet(net, prefix, "ipv6");

/** An IPv4 address carried inside IPv6 (v4-mapped ::ffff:a.b.c.d, NAT64 64:ff9b::/96, 6to4 2002::/16). */
function embeddedV4(ip: string): string | null {
  const lower = ip.toLowerCase();
  const dotted = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return dotted[1]!;
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  const sixToFour = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/.exec(lower);
  const m = hex ?? sixToFour;
  if (!m) return null;
  const n = (parseInt(m[1]!, 16) << 16) | parseInt(m[2]!, 16);
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/** Whether Nox may connect to this address (public unicast only). */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return false;
  if (family === 4) return !BLOCKED.check(ip, "ipv4");
  const v4 = embeddedV4(ip);
  if (v4) return isPublicAddress(v4);
  return !BLOCKED.check(ip, "ipv6");
}

const BAD_HOST = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/i;

/** Check an endpoint URL before storing it; returns the parsed URL or throws with the reason. */
export function checkEndpointUrl(raw: string): URL {
  if (raw.length > 2048) throw new Error("endpoint URL is too long");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("endpoint is not a valid URL");
  }
  if (url.protocol !== "https:") throw new Error("endpoint must use https");
  if (url.username || url.password) throw new Error("endpoint must not contain credentials");
  if (url.port && url.port !== "443") throw new Error("endpoint must use the default https port (443)");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new Error("endpoint address is not public");
  } else if (!host.includes(".") || BAD_HOST.test(host)) {
    throw new Error("endpoint host must be a public domain name");
  }
  url.hash = "";
  return url;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** `lookup` for https.request: resolves the name and refuses to connect if any address is not public. */
export function safeLookup(resolve: typeof dnsLookup = dnsLookup) {
  return (hostname: string, options: { all?: boolean }, callback: LookupCallback) => {
    resolve(hostname, { all: true }, (err, addresses) => {
      if (err) return callback(err, []);
      const list = addresses as LookupAddress[];
      const bad = list.find((a) => !isPublicAddress(a.address));
      if (!list.length || bad) {
        const e = Object.assign(new Error(`endpoint ${hostname} resolves to a non-public address`), { code: "ENDPOINT_NOT_PUBLIC" });
        return callback(e, []);
      }
      if (options.all) return callback(null, list);
      callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

/** A fresh per-agent secret (hex), shown to the owner once. */
export const newEndpointSecret = () => randomBytes(32).toString("hex");

/** X-Nox-Signature: sha256=HMAC(secret, `${timestamp}.${body}`), so owners can verify the caller and reject replays. */
export function signRequest(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export interface PostResult {
  status: number;
  contentType: string;
  body: string;
}

export type Post = (url: URL, headers: Record<string, string>, body: string, timeoutMs: number) => Promise<PostResult>;

export const MAX_RESPONSE_BYTES = 4096;

/** POST over https with the SSRF-safe lookup, no redirects, a timeout and a response size cap. */
export const httpsPost: Post = (url, headers, body, timeoutMs) =>
  new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: "POST", headers: { ...headers, "content-length": String(Buffer.byteLength(body)) }, lookup: safeLookup() as never, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(new Error("endpoint response too large"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, contentType: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("endpoint timed out")));
    req.on("error", reject);
    req.end(body);
  });

/**
 * A Marketplace agent's own service, used as the persona layer of the narrator. The request carries
 * only the beat's public facts (the JSON inside <facts>, exactly what Nox's LLM sees), never roles,
 * secrets or Telegram ids. Expected answer: 200, application/json, {"text": "..."}.
 */
export class EndpointModel implements GmModel {
  readonly model: string;

  constructor(
    private readonly o: { agentId: number; url: string; secret: string; lang: Lang; post?: Post; now?: () => number },
  ) {
    this.model = `endpoint:${o.agentId}`;
  }

  async complete(_system: string, user: string, timeoutMs: number): Promise<GmCompletion> {
    const start = user.indexOf("<facts>");
    const end = user.indexOf("</facts>");
    if (start < 0 || end < start) throw new Error("no facts to send");
    const facts = JSON.parse(user.slice(start + 7, end)) as unknown;
    const body = JSON.stringify({ v: 1, agentId: this.o.agentId, lang: this.o.lang, facts });
    const ts = String(Math.floor((this.o.now ?? Date.now)() / 1000));
    const res = await (this.o.post ?? httpsPost)(
      checkEndpointUrl(this.o.url),
      { "content-type": "application/json", "user-agent": "Nox-GM/1", "x-nox-timestamp": ts, "x-nox-signature": signRequest(this.o.secret, ts, body) },
      body,
      timeoutMs,
    );
    if (res.status !== 200) throw new Error(`endpoint answered HTTP ${res.status}`);
    if (!res.contentType.toLowerCase().startsWith("application/json")) throw new Error("endpoint did not answer JSON");
    if (Buffer.byteLength(res.body) > MAX_RESPONSE_BYTES) throw new Error("endpoint response too large");
    const parsed = JSON.parse(res.body) as { text?: unknown };
    if (typeof parsed.text !== "string") throw new Error('endpoint answer has no "text"');
    return { text: parsed.text, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: this.model };
  }
}
