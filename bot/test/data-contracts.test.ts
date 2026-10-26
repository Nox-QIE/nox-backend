import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * docs/data-contracts.md (L0-10) must name every flow the code has: a new button, command, Game
 * Master beat, chain call, indexed contract or API resource without a line there fails here.
 */
const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const doc = read("docs/data-contracts.md");
const all = (src: string, re: RegExp) => [...new Set([...src.matchAll(re)].map((m) => m[1]!))];

describe("data contracts doc", () => {
  it("names every callback kind and command of the bot", () => {
    const telegram = read("bot/src/telegram.ts");
    const kinds = all(telegram, /kind === "(\w+)"/g);
    expect(kinds.length).toBeGreaterThanOrEqual(7);
    for (const k of kinds) expect(doc, `callback ${k}`).toMatch(new RegExp("`" + k + ":"));
    const commands = all(telegram, /bot\.command\(\[?"(\w+)"/g).concat(all(telegram, /bot\.command\(\["\w+", "(\w+)"\]/g));
    for (const c of commands) expect(doc, `command /${c}`).toContain("`/" + c + "`");
  });

  it("names every Game Master beat sent to the LLM", () => {
    const kinds = all(read("bot/src/gm/prompt.ts"), /kind: "(\w+)"/g);
    expect(kinds.length).toBeGreaterThanOrEqual(6);
    for (const k of kinds) expect(doc, `beat ${k}`).toContain("`" + k + "`");
  });

  it("names every contract function the bot sends and every contract it indexes", () => {
    const sent = all(read("bot/src/chain/viem-ledger.ts"), /as(?:Operator|Player)\((?:[^,()]+, )?"(\w+)"/g).concat(
      all(read("bot/src/chain/operator.ts"), /functionName: "(\w+)"/g),
    );
    expect(sent).toContain("revealAndFinalize");
    for (const f of sent) expect(doc, `function ${f}`).toMatch(new RegExp("`(Nox\\w+\\.)?" + f + "`"));
    for (const c of all(read("bot/scripts/indexer.ts"), /name: "(Nox\w+)"/g)) expect(doc, `contract ${c}`).toContain(c);
  });

  it("names every public API resource", () => {
    const resources = all(read("bot/src/api.ts"), /case "(\w+)":/g);
    expect(resources).toContain("engagement");
    for (const r of resources) expect(doc, `/v1/${r}`).toContain("/v1/" + r);
  });
});
