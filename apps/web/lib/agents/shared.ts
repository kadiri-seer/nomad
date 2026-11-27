/**
 * Nomad agents created from accounts: what an agent is, its limits and its package, shared by the account pages, the
 * agent routes and the runner.
 *
 * Each agent has its own wallet: a Modular Account V2 owned by its creator's Google wallet (the same signer as their
 * Nomad account), so the creator can always withdraw. Nomad's runner holds a session key for it, installed by a
 * signature the creator gives once when creating the agent, that can only approve tokens and swap on Stoa.
 */
import { keccak256, toHex, type Address, type Hex } from "viem";

/**
 * trader: Nomad AI's rules plus research; blank: the creator's own instructions; researcher: reports, never trades;
 * stocks: trades Robinhood's stock tokens on Robinhood Chain, with its own checks and exits.
 */
export type Template = "trader" | "blank" | "researcher" | "stocks";
export const TEMPLATES: readonly Template[] = ["trader", "blank", "researcher", "stocks"];

/** What a Researcher looks into when its creator leaves the instructions empty. */
export const DEFAULT_RESEARCH = "Follow the projects and tokens on Robinhood Chain that people are using most. Each run, report what changed since last time: new projects, big moves in trading, and anything that looks risky.";

/** What a Stocks agent follows when its creator leaves the instructions empty. */
export const DEFAULT_STOCKS = "Trade only the most liquid stock tokens, one at a time. Prefer companies with steady news over sudden moves, and hold when nothing stands out.";

/**
 * A Stocks agent's checks: a stock token is bought only when Stoa can route it, Robinhood has not halted it, Robinhood's
 * own price for it is known, the on-chain price is within MAX_STOCK_GAP_PCT of that price (it drifts when the market
 * is closed), there is real liquidity, and Stoa's safety check passes. Its exits are slower than a Trader's.
 */
export const MAX_STOCK_GAP_PCT = 2;
export const MIN_STOCK_LIQUIDITY_USD = 20_000;
export const STOCK_TAKE_PROFIT_PCT = 10;
export const STOCK_STOP_LOSS_PCT = 8;
export const STOCK_MAX_HOLD_HOURS = 7 * 24;
/** What a creator confirms before a Stocks agent is created. */
export const STOCKS_NOTICE = "Stock tokens are issued by Robinhood Assets (Jersey) Limited, not by Nomad or Stoa, and are not offered in every country. I confirm I may buy and hold them where I live.";

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

/** Hiring other agents (Zero Lux): how many a UTC day, and the most one hire may cost, in USDG ("0.25"). */
export type HireLimits = { perDay: number; maxUsd: string };
export const MAX_HIRES_PER_DAY = 10;
export const MIN_HIRE_USD = 0.05;
export const MAX_HIRE_USD = 1;
export const HIRES_PER_RUN = 2;

/** A creator's hire limits, checked; null turns hiring off. */
export function validHires(h: { perDay?: unknown; maxUsd?: unknown } | null | undefined): HireLimits | null {
  const day = Number(h?.perDay ?? 0);
  if (!Number.isInteger(day) || day < 0 || day > MAX_HIRES_PER_DAY) throw new Error(`Hires a day must be between 0 and ${MAX_HIRES_PER_DAY}.`);
  if (day === 0) return null;
  const max = Number(h?.maxUsd);
  if (!Number.isFinite(max) || max < MIN_HIRE_USD || max > MAX_HIRE_USD) throw new Error(`The most per hire must be between ${MIN_HIRE_USD.toFixed(2)} and ${MAX_HIRE_USD.toFixed(2)} USDG.`);
  return { perDay: day, maxUsd: max.toFixed(2) };
}

/** What a creator signs to change their agent's hire limits. */
export const hiresAction = (h: HireLimits | null) => (h ? `hire up to ${h.perDay} a day at most ${h.maxUsd} USDG each` : "hire no agents");

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

/**
 * One call a run made to an outside service: which service and tool, when, whether it answered, and a fingerprint
 * (keccak-256) of what it answered, so the answer can later be matched without storing it.
 */
export type ToolCallRecord = { service: string; tool: string; at: number; ok: boolean; fingerprint?: Hex };

/** What Nomad records of every hosted run: the proof behind anything the run produced. */
export type RunRecord = {
  id: string;
  agentId: string;
  startedAt: number;
  endedAt: number;
  /** The AI model that answered, when one did. */
  model?: string;
  calls: ToolCallRecord[];
  /** What the run did, as written to its moves. */
  lines: string[];
  txs: Hex[];
  /** The bounty this run worked on, if any. */
  bounty?: string;
  /** What the AI's answers cost this run, charged to the creator's credits (micro-USD). */
  aiCostMicros?: number;
};
export const RUNS_KEPT = 50;

/** The keccak-256 fingerprint of a service's answer. */
export const fingerprint = (text: string): Hex => keccak256(toHex(text));

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
  /** When its creator confirmed STOCKS_NOTICE (Stocks agents only). */
  stocksConfirmedAt?: number;
  /** Hiring Zero Lux agents during its runs, as its creator set it (off when absent). Paid from the creator's credits. */
  hires?: HireLimits;
  /** A hire paid in an earlier run whose answer was not back yet (the signed payment is its claim on the run). */
  pendingHire?: { agent: number; name: string; input: string; ticket: string; paid: string; at: number };
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

/** The message a creator signs to see their agents' moves and reports, which only they can see. */
export function viewMessage(signer: string, at: number) {
  return `Nomad agents: view my agents as ${signer.toLowerCase()} at ${at}`;
}

/** The message an agent's creator signs to pause, resume or change it. */
export function ownerActionMessage(id: string, action: string, at: number) {
  return `Nomad agent ${id}: ${action} at ${at}`;
}
