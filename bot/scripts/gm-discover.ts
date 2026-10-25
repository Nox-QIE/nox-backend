/**
 * Fetch the model lists of both providers, pick up to NOX_GM_DISCOVER_TOTAL (default 10) with variety,
 * probe each with one short narration, and write the ones that answer to NOX_GM_MODELS in .env.
 * Spends a few small requests. Run from the repo root:
 *   node --env-file=.env --import tsx bot/scripts/gm-discover.ts            # writes .env
 *   node --env-file=.env --import tsx bot/scripts/gm-discover.ts --dry-run  # only prints
 */
import { readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_SELECT, fetchAnthropicModelIds, fetchOxionModelIds, rankCandidates, setEnvLine, type Candidate } from "../src/gm/discover.js";
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
const picked: Candidate[] = [];

for (const c of ranked) {
  if (picked.length >= total) break;
  const label = `${c.provider}:${c.id}`;
  const t0 = Date.now();
  try {
    const m = createGmModel({ provider: c.provider, model: c.id, ...(baseURL ? { baseURL } : {}), ...(oxionKey ? { authToken: oxionKey } : {}) });
    const r = await m.complete(system, user, 20_000);
    const g = checkNarration(r.text, []);
    const ms = Date.now() - t0;
    if (g.ok) {
      picked.push(c);
      console.log(`OK    ${label}  ${ms} ms  "${g.text.slice(0, 70)}"`);
    } else {
      console.log(`TOLAK ${label}  guard: ${g.reason}`);
    }
  } catch (e) {
    console.log(`GAGAL ${label}  ${e instanceof Error ? e.message.split("\n")[0]!.slice(0, 100) : String(e)}`);
  }
}

const value = picked.map((c) => `${c.provider}:${c.id}`).join(",");
console.log(`\nTerpilih ${picked.length}/${total}:\nNOX_GM_MODELS=${value}`);

if (!picked.length) {
  console.log("\nTidak ada model yang lolos; .env tidak diubah.");
  process.exitCode = 1;
} else if (dryRun) {
  console.log("\n--dry-run: .env tidak diubah.");
} else {
  writeFileSync(".env", setEnvLine(readFileSync(".env", "utf8"), "NOX_GM_MODELS", value), { mode: 0o600 });
  console.log("\n.env diperbarui (hanya baris NOX_GM_MODELS).");
}
