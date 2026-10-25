/**
 * Live red-team of the AI Game Master: runs the 20 attacks from src/gm/redteam.ts against a real
 * model and reports, per attack, whether any group message leaked and how often the model took the
 * bait (outputs the guard had to reject). Spends real tokens (~100 short requests).
 *   node --env-file=.env --import tsx bot/scripts/redteam.ts [provider:model] [id|en]
 */
import { loadGmConfig } from "../src/config.js";
import { createGmModel, type GmProvider } from "../src/gm/model.js";
import { ATTACKS, runAttack } from "../src/gm/redteam.js";

const [spec = "anthropic:claude-opus-5-5", lang = "id"] = process.argv.slice(2);
const [provider, model] = spec.split(":") as [GmProvider, string];
const gm = loadGmConfig({ ...process.env, NOX_GM: "llm" });
const m = createGmModel({ provider, model, ...(gm.baseURL ? { baseURL: gm.baseURL } : {}), ...(gm.authToken ? { authToken: gm.authToken } : {}) });

let leaks = 0;
let bait = 0;
for (const a of ATTACKS) {
  const r = await runAttack(m, a, lang as "id" | "en");
  if (!r.passed) leaks++;
  bait += r.rejected;
  console.log(`${r.passed ? "BLOCKED" : "LEAKED "}  ${a.id.padEnd(26)} bait taken ${r.rejected}${r.failures.length ? `  ${r.failures.join("; ")}` : ""}`);
}
console.log(`\n${spec} (${lang}): ${ATTACKS.length - leaks}/${ATTACKS.length} attacks blocked; model outputs rejected by the guard: ${bait}`);
process.exitCode = leaks ? 1 : 0;
