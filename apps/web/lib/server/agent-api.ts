/** What the agent routes share: building the runner from the deployment's settings, and checking a registration. */
import { decodeEventLog, getAddress, isAddress, parseAbi, verifyMessage, type Address, type Hex } from "viem";
import { AGENTS_CONTRACT } from "../economy";
import { agentPackage, registerMessage, RUN_EVERY_HOURS, SESSION_DAYS, TEMPLATES, validLimits, type AgentRecord, type Template } from "../agents/shared";
import { redisFromEnv } from "../vote/redis";
import { balanceOf as creditBalance, chargeRun } from "./credits";
import { sponsorDeps } from "./account-routes";
import { agentStore } from "./agents-store";
import { agentSender, expectedAgentWallet, mainAccountOf, serverClient } from "./agent-exec";
import { gemini } from "./gemini";
import { toolKit } from "./agent-tools";
import { veninCheck } from "./venin-check";
import { idlex } from "./idlex";
import { idlexPayer, runnerSecret, sessionSigner } from "./runner-keys";
import { buildCandidates, type RunnerDeps } from "./runner";
import { stoa } from "./stoa";

export class AgentApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function agentEnv() {
  const redis = redisFromEnv();
  const secret = runnerSecret();
  const sp = sponsorDeps();
  const bundlerUrl = process.env.ALCHEMY_RPC_URL?.trim() ?? "";
  if (!redis || !secret || typeof sp === "string" || !bundlerUrl) return null;
  return { redis, secret, sponsor: sp.sponsor, credits: sp.credits, bundlerUrl, store: agentStore(redis) };
}

export function runnerDeps(env: NonNullable<ReturnType<typeof agentEnv>>, now = () => Date.now()): RunnerDeps {
  const s = stoa();
  const client = serverClient();
  const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
  const idlexOn = process.env.AGENT_IDLEX !== "off";
  const key = process.env.GEMINI_API_KEY?.trim();
  const g = key ? gemini(key, { model: process.env.GEMINI_MODEL?.trim() }) : null;
  const toolsOn = process.env.AGENT_TOOLS !== "off";
  return {
    store: env.store,
    now,
    credits: {
      available: async (owner) => (await creditBalance(env.credits, owner)).micros.available,
      charge: (owner, micros) => chargeRun(env.credits, owner, micros)
    },
    balanceOf: (token, holder) => client.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [holder] }),
    quote: s.quote,
    candidates: () => buildCandidates(s, env.store),
    sender: (agent) => agentSender(agent, env.secret, env.sponsor, env.bundlerUrl),
    // Each research question gets its own tool kit, so its sources are only the services that answered it.
    ai: g ? { name: g.name, ask: g.ask, ...(toolsOn ? { withTools: (prompt: string, system: string) => g.withTools(prompt, system, toolKit({ cache: env.store })) } : {}) } : null,
    venin: (path, text) => veninCheck(path, text),
    idlex: idlexOn ? idlex(idlexPayer(env.secret)) : null
  };
}

/** The public view of an agent (no signed grant). */
export function publicAgent(a: AgentRecord) {
  const { deferredAction: _d, pendingJob, ...rest } = a;
  return { ...rest, waitingFor: pendingJob ? (pendingJob.kind === "check" ? `a second opinion on ${pendingJob.symbol}` : "an answer from Idlex") : null };
}

const MINTED = parseAbi(["event Minted(uint256 indexed id, address indexed creator, bytes32 indexed packageHash, string name, string uri, uint256 price, uint256 fee, uint256 burned)"]);

export type Registration = {
  signer: string;
  salt: string;
  name: string;
  template: string;
  perTradeUsd: string;
  tradesPerDay: number;
  instructions?: string;
  runEveryHours: number;
  sessionEntityId: number;
  sessionDeadline: number;
  deferredAction: string;
  mintTx: string;
  signature: string;
};

/** Checks a new agent against the chain (its mint, its owner, its wallet) and returns the record to store. */
export async function checkRegistration(env: NonNullable<ReturnType<typeof agentEnv>>, b: Registration, now = Date.now()): Promise<AgentRecord> {
  if (!AGENTS_CONTRACT) throw new AgentApiError(503, "Creating agents is not open yet.");
  if (!isAddress(b.signer)) throw new AgentApiError(400, "signer is not an address.");
  if (!/^\d{1,30}$/.test(String(b.salt)) || BigInt(b.salt) === 0n) throw new AgentApiError(400, "salt is not valid.");
  if (!/^0x[0-9a-fA-F]{64}$/.test(b.mintTx)) throw new AgentApiError(400, "mintTx is not a transaction hash.");
  if (!/^0x[0-9a-fA-F]{200,4000}$/.test(b.deferredAction)) throw new AgentApiError(400, "The session grant is not valid.");
  const name = String(b.name ?? "").trim();
  if (!name || name.length > 64) throw new AgentApiError(400, "The name must be 1 to 64 characters.");
  const template = b.template as Template;
  if (!TEMPLATES.includes(template)) throw new AgentApiError(400, "Unknown template.");
  // Its own instructions: required for a custom agent, optional for a Researcher (which then follows DEFAULT_RESEARCH).
  const instructions = template === "trader" ? undefined : String(b.instructions ?? "").trim() || undefined;
  if (template === "blank" && !instructions) throw new AgentApiError(400, "Instructions must be 1 to 4,000 characters.");
  if (instructions && instructions.length > 4000) throw new AgentApiError(400, "Instructions must be 1 to 4,000 characters.");
  let limits;
  try {
    limits = validLimits({ perTradeUsd: String(b.perTradeUsd), tradesPerDay: Number(b.tradesPerDay) });
  } catch (e) {
    throw new AgentApiError(400, (e as Error).message);
  }
  if (!(RUN_EVERY_HOURS as readonly number[]).includes(Number(b.runEveryHours))) throw new AgentApiError(400, "Unknown schedule.");
  const entity = Number(b.sessionEntityId);
  if (!Number.isInteger(entity) || entity < 1 || entity > 1000) throw new AgentApiError(400, "The session grant is not valid.");
  const nowS = Math.floor(now / 1000);
  if (!(b.sessionDeadline > nowS && b.sessionDeadline <= nowS + (SESSION_DAYS + 1) * 86_400)) throw new AgentApiError(400, "The session grant has the wrong deadline.");

  const signer = getAddress(b.signer);
  const signed = typeof b.signature === "string" && (await verifyMessage({ address: signer, message: registerMessage(b.mintTx, BigInt(b.salt).toString()), signature: b.signature as Hex }).catch(() => false));
  if (!signed) throw new AgentApiError(403, "Only the agent's creator can register it.");
  const owner = await mainAccountOf(signer);
  const { address: account } = await expectedAgentWallet(signer, BigInt(b.salt));
  const pkg = agentPackage({ name, template, perTradeUsd: String(b.perTradeUsd), tradesPerDay: Number(b.tradesPerDay), ...(instructions ? { instructions } : {}), wallet: account });

  const receipt = await serverClient().getTransactionReceipt({ hash: b.mintTx as Hex }).catch(() => null);
  if (!receipt || receipt.status !== "success") throw new AgentApiError(409, "The mint is not on-chain yet. Try again in a moment.");
  let id: string | null = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== AGENTS_CONTRACT.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: MINTED, data: log.data, topics: log.topics });
      if (ev.args.creator.toLowerCase() === owner.toLowerCase() && ev.args.packageHash.toLowerCase() === pkg.hash.toLowerCase()) id = ev.args.id.toString();
    } catch {
      /* another event */
    }
  }
  if (!id) throw new AgentApiError(400, "That transaction did not mint this agent from this account.");
  return {
    id,
    name,
    template,
    limits,
    ...(instructions ? { instructions } : {}),
    runEveryHours: Number(b.runEveryHours),
    status: "active",
    owner: owner as Address,
    signer,
    account,
    salt: BigInt(b.salt).toString(),
    deferredAction: b.deferredAction as Hex,
    sessionAddress: sessionSigner(env.secret, account).address,
    sessionEntityId: entity,
    sessionDeadline: b.sessionDeadline,
    packageHash: pkg.hash,
    mintTx: b.mintTx as Hex,
    createdAt: now
  };
}
