import { canonicalJson } from "@nox/shared/crypto-spec";
import { createPublicClient, createWalletClient, keccak256, parseEventLogs, toBytes, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Persona } from "../agents.js";
import type { ChainConfig } from "../config.js";
import { NoxAgentRegistryAbi, NoxPaymentsAbi } from "./contracts.js";
import { chainFor, rpcTransport } from "./viem-ledger.js";

/** Clients for operator scripts (agent registration, revenue settlement). */
export interface Operator {
  publicClient: PublicClient;
  wallet: WalletClient;
  account: PrivateKeyAccount;
}

export function operatorFrom(c: ChainConfig, pollingMs = 1000): Operator {
  if (c.network === "off" || !c.operatorKey) throw new Error("set NOX_CHAIN and NOX_OPERATOR_KEY to use operator scripts");
  const chain = chainFor(c.network);
  const transport = rpcTransport(chain, c.rpcUrl);
  const account = privateKeyToAccount(c.operatorKey);
  return {
    publicClient: createPublicClient({ chain, transport, pollingInterval: pollingMs }) as PublicClient,
    wallet: createWalletClient({ account, chain, transport }),
    account,
  };
}

/** Hash stored on-chain for a hosted persona: keccak256 of its canonical JSON. */
export const personaHash = (p: Persona): Hex => keccak256(toBytes(canonicalJson(p)));

async function write(op: Operator, request: unknown): Promise<Hex> {
  const hash = await op.wallet.writeContract(request as never);
  const receipt = await op.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`transaction reverted: ${hash}`);
  return hash;
}

/** Registers a moderated hosted persona in NoxAgentRegistry; returns its on-chain agent id. */
export async function registerAgentOnChain(op: Operator, registry: Address, owner: Address, persona: Persona): Promise<number> {
  const { request } = await op.publicClient.simulateContract({
    account: op.account,
    address: registry,
    abi: NoxAgentRegistryAbi,
    functionName: "registerAgent",
    args: [owner, 1, personaHash(persona)],
  });
  const hash = await write(op, request);
  const receipt = await op.publicClient.getTransactionReceipt({ hash });
  const [ev] = parseEventLogs({ abi: NoxAgentRegistryAbi, eventName: "AgentRegistered", logs: receipt.logs });
  return Number(ev!.args.agentId);
}

export async function shareOf(op: Operator, registry: Address, chainAgentId: number): Promise<number> {
  return Number(await op.publicClient.readContract({ address: registry, abi: NoxAgentRegistryAbi, functionName: "shareOf", args: [BigInt(chainAgentId)] }));
}

/** Sum of on-chain pass purchases in `token` whose block time falls in [fromMs, toMs). */
export async function passRevenue(op: Operator, payments: Address, token: Address, fromMs: number, toMs: number, fromBlock = 0n): Promise<bigint> {
  const latest = await op.publicClient.getBlockNumber();
  const times = new Map<bigint, number>();
  let total = 0n;
  // QIE caps eth_getLogs at 10,000 blocks per request.
  for (let from = fromBlock; from <= latest; from += 10_000n) {
    const to = from + 9_999n > latest ? latest : from + 9_999n;
    const logs = await op.publicClient.getContractEvents({ address: payments, abi: NoxPaymentsAbi, eventName: "PassPurchased", fromBlock: from, toBlock: to });
    for (const l of logs) {
      if (l.args.token!.toLowerCase() !== token.toLowerCase()) continue;
      let t = times.get(l.blockNumber);
      if (t === undefined) {
        t = Number((await op.publicClient.getBlock({ blockNumber: l.blockNumber })).timestamp) * 1000;
        times.set(l.blockNumber, t);
      }
      if (t >= fromMs && t < toMs) total += l.args.amount!;
    }
  }
  return total;
}

export async function allocateAgentPool(
  op: Operator,
  payments: Address,
  period: number,
  token: Address,
  chainAgentIds: number[],
  amounts: bigint[],
  usageRoot: Hex,
): Promise<Hex> {
  const { request } = await op.publicClient.simulateContract({
    account: op.account,
    address: payments,
    abi: NoxPaymentsAbi,
    functionName: "allocateAgentPool",
    args: [period, token, chainAgentIds.map(BigInt), amounts, usageRoot],
  });
  return write(op, request);
}

/** Records a rupiah-paid Game Night on chain (F04-D04): the booking id and the hash of its receipt. */
export async function recordFiatGameNightOnChain(op: Operator, payments: Address, bookingId: Hex, chainAgentId: number, receiptHash: Hex): Promise<Hex> {
  const { request } = await op.publicClient.simulateContract({
    account: op.account,
    address: payments,
    abi: NoxPaymentsAbi,
    functionName: "recordFiatGameNight",
    args: [bookingId, BigInt(chainAgentId), receiptHash],
  });
  return write(op, request);
}
