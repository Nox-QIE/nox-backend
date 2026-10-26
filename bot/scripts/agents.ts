/**
 * Operator CLI for the Agent Marketplace (hosted personas). Runs against the bot's SQLite store.
 *   node --env-file=.env --import tsx bot/scripts/agents.ts add <owner-wallet> <persona.json>
 *   node --env-file=.env --import tsx bot/scripts/agents.ts list
 *   node --env-file=.env --import tsx bot/scripts/agents.ts suspend|activate <id> "<reason>"
 *   node --env-file=.env --import tsx bot/scripts/agents.ts log <id>       (moderation log + recent health)
 *   node --env-file=.env --import tsx bot/scripts/agents.ts usage <YYYY-MM>
 *   node --env-file=.env --import tsx bot/scripts/agents.ts register <id>   (NoxAgentRegistry, operator key)
 * `add` runs the automatic persona checks; review the text yourself before adding (moderation).
 */
import { readFileSync } from "node:fs";
import { checkPersona, HEALTH, isAddress, type Persona } from "../src/agents.js";
import { operatorFrom, registerAgentOnChain } from "../src/chain/operator.js";
import { loadChainConfig } from "../src/config.js";
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
  case "activate": {
    // Every decision is kept with its reason (F18-D06), so owners can be told why.
    if (!a || !store.getAgent(Number(a))) throw new Error(`usage: ${cmd} <id> "<reason>" (unknown agent ${a ?? ""})`);
    if (!b?.trim()) throw new Error(`usage: ${cmd} <id> "<reason>": a reason is required`);
    store.setAgentStatus(Number(a), cmd === "suspend" ? "suspended" : "active");
    store.addModeration(Number(a), cmd === "suspend" ? "suspended" : "activated", b.trim(), process.env.USER || "operator");
    console.log(`Agent #${a} ${cmd === "suspend" ? "suspended" : "active"}: ${b.trim()}`);
    break;
  }
  case "log": {
    const id = Number(a);
    const agent = store.getAgent(id);
    if (!agent) throw new Error(`unknown agent ${a ?? ""}`);
    console.log(`#${id} ${agent.persona.name}: ${agent.status}`);
    for (const m of store.moderationLog(id)) console.log(`  ${new Date(m.at).toISOString()}  ${m.decision.padEnd(9)} by ${m.by}: ${m.reason}`);
    const games = store.agentGames(id, HEALTH.window);
    if (games.length) {
      const sum = (k: "persona" | "nox" | "template") => games.reduce((n, g) => n + g[k], 0);
      console.log(`  last ${games.length} games: persona ${sum("persona")} / Nox ${sum("nox")} / template ${sum("template")} beats, set aside in ${games.filter((g) => g.demoted).length}`);
    }
    break;
  }
  case "usage": {
    const m = /^(\d{4})-(\d{2})$/.exec(a ?? "");
    if (!m) throw new Error("usage: usage <YYYY-MM>");
    const from = Date.UTC(Number(m[1]), Number(m[2]) - 1, 1);
    const to = Date.UTC(Number(m[1]), Number(m[2]), 1);
    for (const u of store.agentUsage(from, to)) console.log(`#${u.agentId}: ${u.games} games, ${u.players} player seats`);
    break;
  }
  case "register": {
    const agent = store.getAgent(Number(a));
    if (!agent) throw new Error(`no agent #${a}`);
    if (agent.chainAgentId) throw new Error(`agent #${a} is already registered on-chain as #${agent.chainAgentId}`);
    const c = loadChainConfig();
    if (!c.agentRegistryAddress) throw new Error("set NOX_AGENT_REGISTRY_ADDRESS");
    const chainId = await registerAgentOnChain(operatorFrom(c), c.agentRegistryAddress, agent.owner as `0x${string}`, agent.persona);
    store.setChainAgentId(agent.id, chainId);
    console.log(`Agent #${agent.id} registered on-chain as #${chainId}.`);
    break;
  }
  default:
    console.log("commands: add <owner> <persona.json> | list | suspend <id> | activate <id> | usage <YYYY-MM> | register <id>");
}
