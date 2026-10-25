import Anthropic from "@anthropic-ai/sdk";
import type { GmProvider } from "./model.js";

export interface Candidate {
  provider: GmProvider;
  id: string;
}

export interface SelectOptions {
  /** Upper bound on Claude API models (one per tier: opus, sonnet, haiku). */
  anthropicMax: number;
  /** Ids matching this are never considered (tiny, preview, embedding or top-price models). */
  exclude: RegExp;
  /** Preferred order of gateway model families; unknown families follow alphabetically. */
  familyOrder: string[];
}

export const DEFAULT_SELECT: SelectOptions = {
  anthropicMax: 3,
  exclude: /embed|gemma|preview|mythos|fable|tts|whisper|image|audio|rerank/i,
  familyOrder: ["gpt", "gemini", "deepseek", "qwen", "kimi", "glm", "grok", "seed", "muse"],
};

const CLAUDE = /^claude-(opus|sonnet|haiku)-(\d+)(?:[-.](\d+))?$/;

/** "gpt-5.6-terra" → "gpt", "qwen3.8-max" → "qwen", "claude-opus-5.5" → "claude-opus". */
export function familyOf(id: string): string {
  const c = CLAUDE.exec(id);
  if (c) return `claude-${c[1]}`;
  return /^[a-z]+/i.exec(id)?.[0].toLowerCase() ?? id;
}

/** First version number in the id: "gpt-5.6-terra" → [5, 6], "kimi-k3" → [3], "claude-opus-5-5" → [5, 5]. */
export function versionOf(id: string): number[] {
  const c = CLAUDE.exec(id);
  if (c) return [Number(c[2]), Number(c[3] ?? 0)];
  const m = /(\d+(?:\.\d+)*)/.exec(id);
  return m ? m[1]!.split(".").map(Number) : [0];
}

const cmpVersion = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

// Within one family and version, prefer the plain variant over the pricier pro/max/ultra one.
const premium = (id: string) => (/(^|-)(pro|max|ultra)(-|$)/i.test(id) ? 1 : 0);

/** Best first: newest version, then non-premium, then alphabetical. */
function rankFamily(ids: string[]): string[] {
  return [...ids].sort((a, b) => cmpVersion(versionOf(b), versionOf(a)) || premium(a) - premium(b) || a.localeCompare(b));
}

function byFamily(ids: string[]) {
  const m = new Map<string, string[]>();
  for (const id of ids) m.set(familyOf(id), [...(m.get(familyOf(id)) ?? []), id]);
  for (const [k, v] of m) m.set(k, rankFamily(v));
  return m;
}

/**
 * Rank every usable model from both providers, best first. The caller probes them in this order
 * and keeps the first N that answer. Order: newest Claude per tier on the Claude API, then the
 * best model of each gateway family (variety), then gateway Claude, then second choices as backups.
 */
export function rankCandidates(anthropicIds: string[], oxionIds: string[], o: SelectOptions = DEFAULT_SELECT): Candidate[] {
  const usable = (id: string) => !o.exclude.test(id);
  const claudeApi = byFamily(anthropicIds.filter((id) => CLAUDE.test(id) && usable(id)));
  const gateway = byFamily(oxionIds.filter(usable));

  const tiers = ["claude-opus", "claude-sonnet", "claude-haiku"];
  const firsts: Candidate[] = tiers
    .flatMap((t) => (claudeApi.get(t)?.[0] ? [{ provider: "anthropic" as const, id: claudeApi.get(t)![0]! }] : []))
    .slice(0, o.anthropicMax);

  const families = [...gateway.keys()];
  const known = o.familyOrder.filter((f) => families.includes(f));
  const unknown = families.filter((f) => !o.familyOrder.includes(f) && !f.startsWith("claude-")).sort();
  const claudeGw = tiers.filter((t) => families.includes(t));
  for (const f of [...known, ...unknown, ...claudeGw]) firsts.push({ provider: "oxion", id: gateway.get(f)![0]! });

  const seconds: Candidate[] = [];
  for (const ids of gateway.values()) for (const id of ids.slice(1)) seconds.push({ provider: "oxion", id });
  for (const t of tiers) for (const id of claudeApi.get(t)?.slice(1) ?? []) seconds.push({ provider: "anthropic", id });

  return [...firsts, ...seconds];
}

export async function fetchAnthropicModelIds(client: Anthropic = new Anthropic()): Promise<string[]> {
  const ids: string[] = [];
  for await (const m of client.models.list()) ids.push(m.id);
  return ids;
}

export async function fetchOxionModelIds(authToken: string, baseURL = "https://oxionai.com"): Promise<string[]> {
  const root = baseURL.replace(/\/+$/, "").replace(/\/v1$/, "");
  const r = await fetch(`${root}/v1/models`, { headers: { Authorization: `Bearer ${authToken}` } });
  if (!r.ok) throw new Error(`Oxion /v1/models ${r.status}`);
  const j = (await r.json()) as { data?: { id: string }[] };
  return (j.data ?? []).map((m) => m.id);
}

/** Replace (or append) the NOX_GM_MODELS line of a .env file's text, leaving every other line as is. */
export function setEnvLine(envText: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  return re.test(envText) ? envText.replace(re, line) : `${envText.replace(/\n?$/, "\n")}${line}\n`;
}

export type ProbeResult = "ok" | "outage" | "fail";

/**
 * Turn probe results into the final pool. Keeps the ranked order, at most `anthropicMax` Claude API
 * entries, and `total` overall. A provider counts as down when none of its probes answered and
 * outages (5xx / network) are at least as common as client errors (gateways answer the odd 401
 * during maintenance). A down provider's best candidates are still kept, unverified, one per
 * family, so its share is not handed to the other provider; runtime failover covers them.
 */
export function finalizePool(
  ranked: Candidate[],
  results: Map<string, ProbeResult>,
  total: number,
  anthropicMax: number,
): { picked: Candidate[]; unverified: Candidate[] } {
  const key = (c: Candidate) => `${c.provider}:${c.id}`;
  const providers = [...new Set(ranked.map((c) => c.provider))];
  const down = new Set(
    providers.filter((p) => {
      const rs = ranked.filter((c) => c.provider === p && results.has(key(c))).map((c) => results.get(key(c)));
      const outages = rs.filter((r) => r === "outage").length;
      return !rs.includes("ok") && outages > 0 && outages >= rs.length - outages;
    }),
  );
  const picked: Candidate[] = [];
  const unverified: Candidate[] = [];
  let anthropic = 0;
  for (const c of ranked) {
    if (picked.length >= total) break;
    if (c.provider === "anthropic" && anthropic >= anthropicMax) continue;
    const r = results.get(key(c));
    const keep =
      r === "ok" || (r !== "fail" && down.has(c.provider) && !picked.some((p) => p.provider === c.provider && familyOf(p.id) === familyOf(c.id)));
    if (!keep) continue;
    picked.push(c);
    if (r !== "ok") unverified.push(c);
    if (c.provider === "anthropic") anthropic++;
  }
  return { picked, unverified };
}
