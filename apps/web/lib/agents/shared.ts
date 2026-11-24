/**
 * Nomad agents created from accounts: what an agent is, its limits and its package, shared by the account pages, the
 * agent routes and the runner.
 *
 * Each agent has its own wallet: a Modular Account V2 owned by its creator's Google wallet (the same signer as their
 * Nomad account), so the creator can always withdraw. Nomad's runner holds a session key for it, installed by a
 * signature the creator gives once when creating the agent, that can only approve tokens and swap on Stoa.
 */
import { keccak256, toHex, type Address, type Hex } from "viem";

/** trader: Nomad AI's rules plus research; blank: the creator's own instructions; researcher: reports, never trades. */
export type Template = "trader" | "blank" | "researcher";
export const TEMPLATES: readonly Template[] = ["trader", "blank", "researcher"];

/** What a Researcher looks into when its creator leaves the instructions empty. */
export const DEFAULT_RESEARCH = "Follow the projects and tokens on Robinhood Chain that people are using most. Each run, report what changed since last time: new projects, big moves in trading, and anything that looks risky.";

/** How much an agent remembers: its last notes and moves, given to its AI each run. */
export const NOTES_KEPT = 20;
export const NOTES_SHOWN = 6;
export const MOVES_SHOWN = 6;
export type AgentStatus = "active" | "paused";

export type AgentLimits = {
  /** The most one trade may put in, in USDG ("0.30"). */
  perTradeUsd: string;
  /** The most trades a UTC day. */
  tradesPerDay: number;
};

/** `wallet` (the agent's own wallet) makes every package unique: the contract mints each package hash only once. */
export type PackageInput = { name: string; template: Template; perTradeUsd: string; tradesPerDay: number; instructions?: string; wallet: Address };

/** What is minted: the agent's package, hashed into the token. */
export function agentPackage(input: PackageInput) {
  const body = JSON.stringify({ v: 1, ...input });
  return { body, hash: keccak256(toHex(body)) };
}

/** Hours between runs a creator can choose. */
export const RUN_EVERY_HOURS = [1, 3, 6, 12, 24] as const;
export const DEFAULT_RUN_EVERY_HOURS = 6;

/** Hard ceilings the runner applies, whatever an agent's package says. */
export const MAX_PER_TRADE_USD = 50;
export const MAX_TRADES_PER_DAY = 10;
export const MAX_PRICE_IMPACT_PCT = 2;
export const MAX_TAX_PCT = 3;
export const MIN_VOLUME_24H_USD = 1_000;
export const MIN_LIQUIDITY_USD = 20_000;
/** The Trader's exits, as Nomad AI's: up 25%, down 20%, or held 48 hours. */
export const TAKE_PROFIT_PCT = 25;
export const STOP_LOSS_PCT = 20;
export const MAX_HOLD_HOURS = 48;

/** How long the runner's session key stays valid; the creator renews it from the account page. */
export const SESSION_DAYS = 365;

/** Charged to the creator's credits for each paid AI job an agent's run uses, in micro-USD ($0.005). */
export const AI_JOB_CHARGE_MICROS = 5_000n;
/**
 * Creating an agent costs $5 of $NOMAD at Stoa's price at that moment, $1 of it burned and $4 to Nomad's treasury,
 * paid in the same approval as the mint. (This applies once the agents contract's own fee is 0; while it is not,
 * the contract's fee is what is paid.)
 */
export const AGENT_FEE_USD = 5;
export const AGENT_FEE_BURN_BPS = 2_000n;
export const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";

/** Charged to the creator's credits for each OddsEngine check before a buy, in micro-USD ($0.005). */
export const ODDSENGINE_CHECK_CHARGE_MICROS = 5_000n;
/** A run is skipped (and the creator told) when credits are below this, in micro-USD ($0.05). */
export const MIN_RUN_CREDITS_MICROS = 50_000n;

export type Position = { token: Address; symbol: string; decimals: number; amount: string; costMicros: string; boughtAt: number };

export type Move = { at: number; text: string; tx?: Hex; report?: boolean };

export type AgentRecord = {
  id: string;
  name: string;
  template: Template;
  limits: AgentLimits;
  instructions?: string;
  runEveryHours: number;
  status: AgentStatus;
  /** The creator's Nomad account (pays credits) and the Google wallet that owns both accounts. */
  owner: Address;
  signer: Address;
  /** The agent's own wallet, its salt, and the creator's signature installing the runner's session key. */
  account: Address;
  salt: string;
  deferredAction: Hex;
  sessionAddress: Address;
  sessionEntityId: number;
  sessionDeadline: number;
  packageHash: Hex;
  mintTx: Hex;
  createdAt: number;
  /** Runner state. */
  lastRunAt?: number;
  pendingJob?: { id: string; kind: "check" | "decide"; token?: Address; symbol?: string; at: number };
  tradesDay?: string;
  tradesToday?: number;
};

export function validLimits(l: Partial<AgentLimits>): AgentLimits {
  const per = Number(l.perTradeUsd);
  if (!Number.isFinite(per) || per < 0.1 || per > MAX_PER_TRADE_USD) throw new Error(`Per trade must be between 0.10 and ${MAX_PER_TRADE_USD} USDG.`);
  const day = Number(l.tradesPerDay);
  if (!Number.isInteger(day) || day < 1 || day > MAX_TRADES_PER_DAY) throw new Error(`Trades a day must be between 1 and ${MAX_TRADES_PER_DAY}.`);
  return { perTradeUsd: per.toFixed(2), tradesPerDay: day };
}

/** The message an agent's creator signs to register it (so nobody else can claim their mint). */
export function registerMessage(mintTx: string, salt: string) {
  return `Nomad agent: register mint ${mintTx.toLowerCase()} with wallet salt ${salt}`;
}

/** The message an agent's creator signs to pause, resume or change it. */
export function ownerActionMessage(id: string, action: string, at: number) {
  return `Nomad agent ${id}: ${action} at ${at}`;
}
