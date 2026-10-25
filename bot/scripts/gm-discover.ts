/**
 * Fetch the model lists of both providers, pick up to NOX_GM_DISCOVER_TOTAL (default 10) with variety,
 * probe each with one short narration, and write the ones that answer to NOX_GM_MODELS in .env.
 * Spends a few small requests. Run from the repo root:
 *   node --env-file=.env --import tsx bot/scripts/gm-discover.ts            # writes .env
 *   node --env-file=.env --import tsx bot/scripts/gm-discover.ts --dry-run  # only prints
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_SELECT, fetchAnthropicModelIds, fetchOxionModelIds, finalizePool, rankCandidates, setEnvLine, type ProbeResult } from "../src/gm/discover.js";
import { checkNarration } from "../src/gm/guard.js";
import { createGmModel } from "../src/gm/model.js";
import { systemPrompt, userPrompt } from "../src/gm/prompt.js";

const total = Number(process.env.NOX_GM_DISCOVER_TOTAL || 10);
const dryRun = process.argv.includes("--dry-run");
const oxionKey = process.env.OXION_API_KEY;
const baseURL = process.env.NOX_GM_BASE_URL || undefined;

async function list(name: string, f: () => Promise<string[]>): Promise<string[]> {
  try {
    const ids = await f();
    console.log(`${name}: ${ids.length} model`);
    return ids;
  } catch (e) {
    console.log(`${name}: dilewati (${e instanceof Error ? e.message.split("\n")[0] : String(e)})`);
    return [];
  }
}

const anthropicIds = process.env.ANTHROPIC_API_KEY ? await list("anthropic", () => fetchAnthropicModelIds()) : (console.log("anthropic: dilewati (ANTHROPIC_API_KEY kosong)"), []);
const oxionIds = oxionKey ? await list("oxion", () => fetchOxionModelIds(oxionKey, baseURL)) : (console.log("oxion: dilewati (OXION_API_KEY kosong)"), []);

const ranked = rankCandidates(anthropicIds, oxionIds, DEFAULT_SELECT);
console.log(`kandidat: ${ranked.length}, target: ${total}\n`);

const system = systemPrompt("id");
const user = userPrompt({ kind: "nightFalls", round: 1, alive: 5 });
const results = new Map<string, ProbeResult>();
let okAnthropic = 0;
let okTotal = 0;

for (const c of ranked) {
  if (okTotal >= total) break;
  if (c.provider === "anthropic" && okAnthropic >= DEFAULT_SELECT.anthropicMax) continue;
  const label = `${c.provider}:${c.id}`;
  const t0 = Date.now();
  try {
    const m = createGmModel({ provider: c.provider, model: c.id, ...(baseURL ? { baseURL } : {}), ...(oxionKey ? { authToken: oxionKey } : {}) });
    const r = await m.complete(system, user, 20_000);
    const g = checkNarration(r.text, []);
    const ms = Date.now() - t0;
    if (g.ok) {
      results.set(label, "ok");
      okTotal++;
      if (c.provider === "anthropic") okAnthropic++;
      console.log(`OK    ${label}  ${ms} ms  "${g.text.slice(0, 70)}"`);
    } else {
      results.set(label, "fail");
      console.log(`TOLAK ${label}  guard: ${g.reason}`);
    }
  } catch (e) {
    // 5xx or no response = provider outage. 401/403 also counts as an outage here: the same key just
    // listed this provider's models, so the gateway is misbehaving, not the key. Other 4xx = this model
    // does not work on this endpoint.
    const status = e instanceof Anthropic.APIError ? e.status : undefined;
    const outage = status === undefined || status >= 500 || status === 401 || status === 403;
    results.set(label, outage ? "outage" : "fail");
    console.log(`GAGAL ${label}  ${e instanceof Error ? e.message.split("\n")[0]!.slice(0, 100) : String(e)}`);
  }
}

const { picked, unverified } = finalizePool(ranked, results, total, DEFAULT_SELECT.anthropicMax);
const value = picked.map((c) => `${c.provider}:${c.id}`).join(",");
console.log(`\nTerpilih ${picked.length}/${total}:\nNOX_GM_MODELS=${value}`);
if (unverified.length) {
  console.log(`\nBelum dites (provider sedang down, akan dipakai lewat failover): ${unverified.map((c) => `${c.provider}:${c.id}`).join(", ")}`);
  console.log("Jalankan ulang skrip ini setelah provider pulih untuk memverifikasi.");
}

if (!picked.length) {
  console.log("\nTidak ada model yang lolos; .env tidak diubah.");
  process.exitCode = 1;
} else if (dryRun) {
  console.log("\n--dry-run: .env tidak diubah.");
} else {
  writeFileSync(".env", setEnvLine(readFileSync(".env", "utf8"), "NOX_GM_MODELS", value), { mode: 0o600 });
  console.log("\n.env diperbarui (hanya baris NOX_GM_MODELS).");
}
