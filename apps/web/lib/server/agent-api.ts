/** What the agent routes share: building the runner from the deployment's settings, and checking a registration. */
import { decodeEventLog, getAddress, isAddress, parseAbi, verifyMessage, type Address, type Hex } from "viem";
import { AGENTS_CONTRACT } from "../economy";
import { AGENT_FEE_USD, agentPackage, BURN_ADDRESS, registerMessage, RUN_EVERY_HOURS, SESSION_DAYS, TEMPLATES, validLimits, type AgentRecord, type RunRecord, type Template } from "../agents/shared";
import { NOMAD, TREASURY, USDG } from "../accounts/chain";
import { redisFromEnv } from "../vote/redis";
import { balanceOf as creditBalance, chargeRun } from "./credits";
import { sponsorDeps } from "./account-routes";
import { agentStore } from "./agents-store";
import { agentSender, expectedAgentWallet, mainAccountOf, serverClient } from "./agent-exec";
import { gemini, type ResearchLimits } from "./gemini";
import { toolKit } from "./agent-tools";
import { veninCheck } from "./venin-check";
import { ODDSENGINE_DAILY_CAP, oddsEngine, type OddsVerdict } from "./oddsengine";
import { rushrSafety } from "./rushr";
import { idlex } from "./idlex";
import { idlexPayer, runnerSecret, sessionSigner } from "./runner-keys";
import { buildCandidates, type RunnerDeps } from "./runner";
import { stoa } from "./stoa";
import { bountyEnv } from "./bounty-env";

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

/** OddsEngine for agents, within a daily number of scans for all agents together, so Nomad's balance is never run down. */
export function cappedOddsEngine(store: { count(key: string, ttlSeconds: number): Promise<number> }, oe: { name: string; scanToken(t: Address): Promise<OddsVerdict | null> }, cap = Number(process.env.ODDSENGINE_DAILY_CAP) || ODDSENGINE_DAILY_CAP) {
  return {
    name: oe.name,
    async scanToken(token: Address): Promise<OddsVerdict | null> {
      const n = await store.count(`odds-scans:${new Date().toISOString().slice(0, 10)}`, 2 * 86400);
      if (n > cap) return { facts: [], context: "", skipped: true };
      return oe.scanToken(token);
    }
  };
}

export function runnerDeps(env: NonNullable<ReturnType<typeof agentEnv>>, now = () => Date.now()): RunnerDeps {
  const s = stoa();
  const client = serverClient();
  const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
  const idlexOn = process.env.AGENT_IDLEX !== "off";
  const key = process.env.GEMINI_API_KEY?.trim();
  const g = key ? gemini(key, { model: process.env.GEMINI_MODEL?.trim() }) : null;
  const toolsOn = process.env.AGENT_TOOLS !== "off";
  const b = bountyEnv();
  return {
    store: env.store,
    now,
    credits: {
      available: async (owner) => (await creditBalance(env.credits, owner)).micros.available,
      charge: (owner, micros) => chargeRun(env.credits, owner, micros)
    },
    balanceOf: (token, holder) => client.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [holder] }),
    quote: s.quote,
    candidates: () => buildCandidates(s, env.store, (a) => rushrSafety(a)),
    sender: (agent) => agentSender(agent, env.secret, env.sponsor, env.bundlerUrl),
    // Each research question gets its own tool kit, so its sources are only the services that answered it.
    ai: g ? { name: g.name, ask: g.ask, ...(toolsOn ? { withTools: (prompt: string, system: string, limits?: ResearchLimits) => g.withTools(prompt, system, toolKit({ cache: env.store }), limits) } : {}) } : null,
    ...(b ? { bounties: { tasks: (a: AgentRecord) => b.tasks(a), submit: (a: AgentRecord, id: string, text: string, rec: RunRecord) => b.submitHosted(a, id, text, rec) } } : {}),
    venin: (path, text) => veninCheck(path, text),
    ...(process.env.ODDSENGINE_API_KEY?.trim() ? { oddsEngine: cappedOddsEngine(env.store, oddsEngine(process.env.ODDSENGINE_API_KEY.trim())) } : {}),
    idlex: idlexOn ? idlex(idlexPayer(env.secret)) : null
  };
}

/** The public view of an agent (no signed grant). */
/** What anyone may see of an agent: never its signed grant, and never its instructions (the creator's own words). */
export function publicAgent(a: AgentRecord) {
  const { deferredAction: _d, instructions, pendingJob, ...rest } = a;
  return { ...rest, hasInstructions: !!instructions, waitingFor: pendingJob ? (pendingJob.kind === "check" ? `a second opinion on ${pendingJob.symbol}` : "an answer from Idlex") : null };
}

const TRANSFER_EVENT = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
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

/**
 * The $5 creation fee paid in the mint's transaction (when the contract's own fee is 0): $NOMAD from the creator's
 * account to the burn address and the treasury, worth at least 90% of $5 at Stoa's price now (it moves), with at
 * least 15% of it burned. `nomadFor5` is the price check, for tests.
 */
export async function checkDollarFee(logs: readonly { address: string; data: Hex; topics: readonly Hex[] }[], from: Address, nomadFor5?: () => Promise<bigint>, agents = 1) {
  let burned = 0n;
  let toTreasury = 0n;
  for (const l of logs) {
    if (l.address.toLowerCase() !== NOMAD.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: TRANSFER_EVENT, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      if (ev.args.from.toLowerCase() !== from.toLowerCase()) continue;
      if (ev.args.to.toLowerCase() === BURN_ADDRESS.toLowerCase()) burned += ev.args.value;
      else if (ev.args.to.toLowerCase() === TREASURY.toLowerCase()) toTreasury += ev.args.value;
    } catch {
      /* another event */
    }
  }
  const total = burned + toTreasury;
  let want: bigint;
  try {
    want = nomadFor5 ? await nomadFor5() : (await stoa().quote(USDG, NOMAD, BigInt(AGENT_FEE_USD) * 1_000_000n, TREASURY)).amountOut;
  } catch {
    throw new AgentApiError(503, "The price check is not answering. Your agent is minted and will be set up on your next visit.");
  }
  // $5 for every agent the transaction minted (80% of it at today's price, for the price moving since).
  if (total * 10n < want * 8n * BigInt(Math.max(1, agents)) || burned * 100n < total * 15n) throw new AgentApiError(402, "That mint did not pay the $5 creation fee, so the agent will not run.");
}

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
  let contractFee = 0n;
  let mintsInTx = 0;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== AGENTS_CONTRACT.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: MINTED, data: log.data, topics: log.topics });
      if (ev.args.creator.toLowerCase() === owner.toLowerCase() && ev.args.fee === 0n) mintsInTx += 1;
      if (ev.args.creator.toLowerCase() === owner.toLowerCase() && ev.args.packageHash.toLowerCase() === pkg.hash.toLowerCase()) {
        id = ev.args.id.toString();
        contractFee = ev.args.fee;
      }
    } catch {
      /* another event */
    }
  }
  if (!id) throw new AgentApiError(400, "That transaction did not mint this agent from this account.");
  // With no fee in the contract, the $5 is paid alongside the mint: check it was, with its burn, before running it.
  if (contractFee === 0n) await checkDollarFee(receipt.logs, owner, undefined, mintsInTx);
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
