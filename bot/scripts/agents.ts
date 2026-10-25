/**
 * Operator CLI for the Agent Marketplace (hosted personas). Runs against the bot's SQLite store.
 *   node --env-file=.env --import tsx bot/scripts/agents.ts add <owner-wallet> <persona.json>
 *   node --env-file=.env --import tsx bot/scripts/agents.ts list
 *   node --env-file=.env --import tsx bot/scripts/agents.ts suspend|activate <id>
 *   node --env-file=.env --import tsx bot/scripts/agents.ts usage <YYYY-MM>
 * `add` runs the automatic persona checks; review the text yourself before adding (moderation).
 */
import { readFileSync } from "node:fs";
import { checkPersona, isAddress, type Persona } from "../src/agents.js";
import { SqliteStore } from "../src/store.js";

const store = new SqliteStore(process.env.NOX_DB_PATH || "data/nox.db");
const [cmd, a, b] = process.argv.slice(2);

switch (cmd) {
  case "add": {
    if (!a || !isAddress(a) || !b) throw new Error("usage: add <owner-wallet 0x…> <persona.json>");
    const persona = JSON.parse(readFileSync(b, "utf8")) as Persona;
    const problems = checkPersona(persona);
    if (problems.length) {
      console.error(`Persona rejected:\n- ${problems.join("\n- ")}`);
      process.exit(1);
    }
    console.log(`Agent #${store.addAgent(a, persona)} "${persona.name}" added (active).`);
    break;
  }
  case "list":
    for (const g of store.listAgents()) {
      console.log(`#${g.id} ${g.status.padEnd(9)} ${g.persona.name} [${g.persona.langs.join(",")}] owner ${g.owner}${g.chainAgentId ? ` chain #${g.chainAgentId}` : ""}`);
    }
    break;
  case "suspend":
  case "activate":
    store.setAgentStatus(Number(a), cmd === "suspend" ? "suspended" : "active");
    console.log(`Agent #${a} ${cmd === "suspend" ? "suspended" : "active"}.`);
    break;
  case "usage": {
    const m = /^(\d{4})-(\d{2})$/.exec(a ?? "");
    if (!m) throw new Error("usage: usage <YYYY-MM>");
    const from = Date.UTC(Number(m[1]), Number(m[2]) - 1, 1);
    const to = Date.UTC(Number(m[1]), Number(m[2]), 1);
    for (const u of store.agentUsage(from, to)) console.log(`#${u.agentId}: ${u.games} games, ${u.players} player seats`);
    break;
  }
  default:
    console.log("commands: add <owner> <persona.json> | list | suspend <id> | activate <id> | usage <YYYY-MM>");
}
