/**
 * NoxBadges catalog (10.07 #4): shows which of Nox's badges are defined on chain and, with --send,
 * defines the missing ones. Defining a badge is an admin action (NOX_OPERATOR_KEY must hold the
 * NoxBadges admin role); awarding is the bot's operator job after each game.
 *   node --env-file=.env --import tsx bot/scripts/badges.ts [--send]
 */
import { keccak256, toHex, type Abi } from "viem";
import { NoxBadgesAbi } from "../src/chain/contracts.js";
import { operatorFrom } from "../src/chain/operator.js";
import { loadChainConfig } from "../src/config.js";
import { BADGES, type BadgeKey } from "../src/moments.js";
import { installLogRedaction, secretsFrom } from "../src/redact.js";

installLogRedaction(secretsFrom(process.env));
const c = loadChainConfig();
if (!c.badgesAddress) throw new Error("set NOX_BADGES_ADDRESS");
const op = operatorFrom(c);
const send = process.argv.includes("--send");
for (const key of Object.keys(BADGES) as BadgeKey[]) {
  const id = keccak256(toHex(key));
  const [name, active] = (await op.publicClient.readContract({ address: c.badgesAddress, abi: NoxBadgesAbi as Abi, functionName: "badges", args: [id] })) as [string, boolean];
  if (active) {
    console.log(`${key.padEnd(20)} defined as "${name}"`);
    continue;
  }
  if (!send) {
    console.log(`${key.padEnd(20)} missing (dry run: --send defines it as "${BADGES[key].name}")`);
    continue;
  }
  const { request } = await op.publicClient.simulateContract({ account: op.account, address: c.badgesAddress, abi: NoxBadgesAbi as Abi, functionName: "defineBadge", args: [id, BADGES[key].name, true] });
  const hash = await op.wallet.writeContract(request as never);
  const receipt = await op.publicClient.waitForTransactionReceipt({ hash });
  console.log(`${key.padEnd(20)} defined as "${BADGES[key].name}" (${receipt.status}, tx ${hash})`);
}
