/**
 * Operator CLI for the Agent Marketplace (hosted personas). Runs against the bot's SQLite store.
 *   node --env-file=.env --import tsx bot/scripts/agents.ts add <owner-wallet> <persona.json> --accept-terms
 *   node --env-file=.env --import tsx bot/scripts/agents.ts add-endpoint <owner-wallet> <persona.json> <https-url> --accept-terms
 *   node --env-file=.env --import tsx bot/scripts/agents.ts accept-terms <id>   (owner accepted the current terms)
 *   node --env-file=.env --import tsx bot/scripts/agents.ts ping <id>      (sends a test beat to an endpoint agent)
 *   node --env-file=.env --import tsx bot/scripts/agents.ts list
 *   node --env-file=.env --import tsx bot/scripts/agents.ts suspend|activate <id> "<reason>"
 *   node --env-file=.env --import tsx bot/scripts/agents.ts log <id>       (moderation log + recent health)
 *   node --env-file=.env --import tsx bot/scripts/agents.ts usage <YYYY-MM>
 *   node --env-file=.env --import tsx bot/scripts/agents.ts register <id>   (NoxAgentRegistry, operator key)
 * `add` runs the automatic persona checks; review the text yourself before adding (moderation).
 * `--accept-terms` records that the owner accepted docs/agent-terms.md (the version in AGENT_TERMS);
 * lobbies offer only agents whose owner accepted the current version.
 */
import { readFileSync } from "node:fs";
import { AGENT_TERMS, checkPersona, HEALTH, isAddress, type Persona } from "../src/agents.js";
import { operatorFrom, registerAgentOnChain } from "../src/chain/operator.js";
import { loadChainConfig } from "../src/config.js";
import { SqliteStore, storeKeyring } from "../src/store.js";
import { checkEndpointUrl, EndpointModel, newEndpointSecret, safeLookup } from "../src/gm/endpoint.js";
import { checkNarration } from "../src/gm/guard.js";
import { userPrompt } from "../src/gm/prompt.js";

// The key (from NOX_WALLET_SECRET) seals endpoint secrets, as in the bot.
const secretHex = process.env.NOX_WALLET_SECRET;
const store = new SqliteStore(process.env.NOX_DB_PATH || "data/nox.db", storeKeyring(secretHex, process.env.NOX_STORE_KEYS));
const args = process.argv.slice(2).filter((x) => !x.startsWith("--"));
const [cmd, a, b] = args;
const TERMS = `docs/agent-terms.md v${AGENT_TERMS.version} (${AGENT_TERMS.date})`;

/** The owner must have accepted the current terms before an agent is added (L0-13). */
function requireTerms() {
  if (!process.argv.includes("--accept-terms")) {
    console.error(`The owner must accept ${TERMS} first. Send it to them, then add --accept-terms.`);
    process.exit(1);
  }
}

switch (cmd) {
  case "add": {
    if (!a || !isAddress(a) || !b) throw new Error("usage: add <owner-wallet 0x…> <persona.json> --accept-terms");
    requireTerms();
    const persona = JSON.parse(readFileSync(b, "utf8")) as Persona;
    const problems = checkPersona(persona);
    if (problems.length) {
      console.error(`Persona rejected:\n- ${problems.join("\n- ")}`);
      process.exit(1);
    }
    const id = store.addAgent(a, persona, AGENT_TERMS.version);
    store.addModeration(id, "note", `owner accepted ${TERMS}`, process.env.USER || "operator");
    console.log(`Agent #${id} "${persona.name}" added (active, owner accepted ${TERMS}).`);
    break;
  }
  case "add-endpoint": {
    const url = args[3];
    if (!a || !isAddress(a) || !b || !url) throw new Error("usage: add-endpoint <owner-wallet 0x…> <persona.json> <https-url> --accept-terms");
    requireTerms();
    const persona = JSON.parse(readFileSync(b, "utf8")) as Persona;
    const problems = checkPersona(persona);
    if (problems.length) {
      console.error(`Persona rejected:\n- ${problems.join("\n- ")}`);
      process.exit(1);
    }
    const checked = checkEndpointUrl(url);
    // Resolve now too, so an owner learns at once if the name points somewhere Nox will not call.
    await new Promise<void>((resolve, reject) => safeLookup()(checked.hostname, { all: true }, (err) => (err ? reject(err) : resolve())));
    const secret = newEndpointSecret();
    const id = store.addEndpointAgent(a, persona, checked.toString(), secret, AGENT_TERMS.version);
    store.addModeration(id, "note", `owner accepted ${TERMS}`, process.env.USER || "operator");
    console.log(`Agent #${id} "${persona.name}" added (active, endpoint ${checked.toString()}, owner accepted ${TERMS}).`);
    console.log(`Signing secret for the owner (shown once; Nox stores it encrypted):\n${secret}`);
    break;
  }
  case "ping": {
    const agent = store.getAgent(Number(a));
    if (!agent || agent.mode !== "endpoint" || !agent.endpoint) throw new Error(`agent ${a ?? ""} is not an endpoint agent`);
    const model = new EndpointModel({ agentId: agent.id, url: agent.endpoint, secret: store.agentSecret(agent.id)!, lang: agent.persona.langs[0] ?? "en" });
    const r = await model.complete("", userPrompt({ kind: "nightFalls", round: 1, alive: 5 }), 8000);
    const g = checkNarration(r.text, []);
    console.log(g.ok ? `OK: ${g.text}` : `Answer rejected by the guard (${g.reason}): ${r.text}`);
    break;
  }
  case "accept-terms": {
    if (!a || !store.getAgent(Number(a))) throw new Error(`usage: accept-terms <id> (unknown agent ${a ?? ""})`);
    store.acceptAgentTerms(Number(a), AGENT_TERMS.version);
    store.addModeration(Number(a), "note", `owner accepted ${TERMS}`, process.env.USER || "operator");
    console.log(`Agent #${a}: owner accepted ${TERMS}.`);
    break;
  }
  case "list":
    for (const g of store.listAgents()) {
      // Agents on older terms stay out of lobbies until their owner accepts the current version.
      const terms = (g.termsVersion ?? 0) >= AGENT_TERMS.version ? "" : ` (terms ${g.termsVersion ? `v${g.termsVersion}` : "not accepted"}: hidden from lobbies)`;
      console.log(
        `#${g.id} ${g.status.padEnd(9)} ${g.persona.name} [${g.persona.langs.join(",")}] owner ${g.owner}${g.chainAgentId ? ` chain #${g.chainAgentId}` : ""}${g.mode === "endpoint" ? ` endpoint ${g.endpoint}` : ""}${terms}`,
      );
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
      const calls = games.reduce((n, g) => n + (g.endpointCalls ?? 0), 0);
      if (calls) console.log(`  endpoint: ${games.reduce((n, g) => n + (g.endpointErrors ?? 0), 0)} of ${calls} calls failed (errors or timeouts)`);
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
    console.log(
      "commands: add <owner> <persona.json> --accept-terms | add-endpoint <owner> <persona.json> <url> --accept-terms | accept-terms <id> | list | ping <id> | suspend|activate <id> <reason> | log <id> | usage <YYYY-MM> | register <id>",
    );
}
