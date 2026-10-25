/**
 * NOX-F09-S01: narrate one typical 5-player game (3 rounds) against the configured provider and
 * print token usage and cost. Spends real tokens. Run from the repo root:
 *   node --env-file=.env --import tsx bot/scripts/gm-sample.ts
 */
import type { PublicView } from "@nox/shared/engine";
import { loadGmConfig } from "../src/config.js";
import { LlmNarrator } from "../src/gm/llm-narrator.js";
import { createGmModel } from "../src/gm/model.js";

const gm = { ...loadGmConfig(), mode: "llm" as const };
const lang = process.env.NOX_GM_SAMPLE_LANG === "en" ? "en" : "id";
const lines: Record<string, unknown>[] = [];
const n = new LlmNarrator({
  model: createGmModel(gm),
  lang,
  timeoutMs: gm.timeoutMs,
  log: (l) => lines.push(l),
  ...(gm.price ? { price: gm.price } : {}),
});

const names = ["Ava", "Ben", "Cy", "Dee", "Eli"];
const v = (round: number, alive: number): PublicView => ({
  phase: "day",
  round,
  alive: names.slice(0, alive),
  eliminated: [],
  votesCast: 0,
  winner: null,
});

const out: string[] = [];
out.push(await n.intro(v(1, 5), names));
out.push(await n.nightFalls(v(1, 5)));
out.push(await n.morning(v(1, 4), "Eli", "villager"));
out.push(await n.dayResult(v(1, 4), null, null));
out.push(await n.nightFalls(v(2, 4)));
out.push(await n.morning(v(2, 4), null, null));
out.push(await n.dayResult(v(2, 3), "Dee", "seer"));
out.push(await n.nightFalls(v(3, 3)));
out.push(await n.morning(v(3, 2), "Cy", "doctor"));
out.push(
  await n.gameOver("wolves", [
    { name: "Ava", role: "werewolf" },
    { name: "Ben", role: "villager" },
    { name: "Cy", role: "doctor" },
    { name: "Dee", role: "seer" },
    { name: "Eli", role: "villager" },
  ]),
);
n.finish();

console.log(out.join("\n\n---\n\n"));
console.log("\n" + JSON.stringify(lines.at(-1), null, 2));
for (const l of lines.filter((l) => l.event === "gm_error")) console.error(JSON.stringify(l));
