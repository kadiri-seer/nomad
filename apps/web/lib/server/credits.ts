/**
 * Credits: each Nomad account's prepaid balance, in dollars, kept as whole micro-dollars in the site's Upstash
 * database. They pay for its agents' AI runs and for gas. They are prepaid service credits: they cannot be withdrawn.
 *
 * - Top-ups are made on-chain from the account itself (USDG to the treasury, or $NOMAD swapped by Stoa straight to the
 *   treasury, with a bonus) and claimed here with the transaction hash, which is checked on-chain and counted once.
 * - Gas: when NomadPaymaster is to pay from credits, the operation's most possible cost is held; once it lands, the real
 *   cost plus a margin is charged and the hold released; one that never lands is released after it expires.
 * Every dependency comes in as an argument, so the rules are tested without the network.
 */
import { decodeEventLog, getAddress, parseAbi, type Address, type Hex, type Log } from "viem";
import type { RedisLike } from "../vote/redis";
import { hashToObject } from "../vote/redis";
import { ENTRY_POINT, FREE_OPS_PER_DAY, GAS_MARGIN_BPS, MIN_TOPUP_USDG, NOMAD, NOMAD_TOPUP_BONUS_BPS, TREASURY, USDG } from "../accounts/chain";

export class CreditsError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const KEY = (a: Address) => `nomad:credits:${a.toLowerCase()}`;
const PENDING = (a: Address) => `nomad:credits:pending:${a.toLowerCase()}`;
const CLAIMED = "nomad:credits:claimed";
const FREE = (a: Address, day: string) => `nomad:free:${a.toLowerCase()}:${day}`;
const lc = (a: string) => a.toLowerCase();
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export type Receipt = { status: "success" | "reverted"; logs: Pick<Log, "address" | "topics" | "data">[] };

export type CreditsDeps = {
  redis: RedisLike;
  /** ETH's price in dollars, for gas. */
  ethUsd: () => Promise<number>;
  /** A transaction's receipt on Robinhood Chain, or null when there is none (yet). */
  txReceipt: (hash: Hex) => Promise<Receipt | null>;
  /** A user operation's actual gas cost in wei once it landed, or null when it has not (the bundler's receipt). */
  userOpCost: (userOpHash: Hex) => Promise<bigint | null>;
  now?: () => Date;
};

export type Balance = { balanceUsd: string; heldUsd: string; availableUsd: string; micros: { balance: bigint; held: bigint; available: bigint } };

const usd = (m: bigint) => {
  const neg = m < 0n;
  const a = neg ? -m : m;
  return `${neg ? "-" : ""}${a / 1_000_000n}.${String((a % 1_000_000n) / 10_000n).padStart(2, "0")}`;
};

/** Wei of gas to micro-dollars, with the margin on top, rounded up. */
export function gasCharge(wei: bigint, ethUsd: number): bigint {
  if (!(ethUsd > 0)) throw new CreditsError(503, "ETH's price is not available right now. Try again shortly.");
  const priceMicros = BigInt(Math.round(ethUsd * 1_000_000));
  const base = (wei * priceMicros + 10n ** 18n - 1n) / 10n ** 18n;
  return (base * (10_000n + GAS_MARGIN_BPS) + 9_999n) / 10_000n;
}

async function readBalance(redis: RedisLike, account: Address) {
  const h = hashToObject(await redis.cmd(["HGETALL", KEY(account)]));
  const balance = BigInt(h.balance ?? "0");
  const held = BigInt(h.held ?? "0");
  return { balance, held, available: balance - held };
}

export async function balanceOf(deps: Pick<CreditsDeps, "redis">, account: Address): Promise<Balance> {
  const b = await readBalance(deps.redis, account);
  return { balanceUsd: usd(b.balance), heldUsd: usd(b.held), availableUsd: usd(b.available), micros: b };
}

/** Records one operation the treasury pays outright; false once the account used today's. */
export async function useFreeOp(redis: RedisLike, account: Address, day: string): Promise<boolean> {
  const n = Number(await redis.cmd(["INCR", FREE(account, day)]));
  if (n === 1) await redis.cmd(["EXPIRE", FREE(account, day), 2 * 86400]);
  return n <= FREE_OPS_PER_DAY;
}

/** Holds an operation's most possible cost against the account's credits; false when they do not cover it. */
export async function hold(deps: CreditsDeps, account: Address, maxCostWei: bigint, userOpHash: Hex, validUntil: number): Promise<boolean> {
  await settle(deps, account);
  const micros = gasCharge(maxCostWei, await deps.ethUsd());
  const b = await readBalance(deps.redis, account);
  if (b.available < micros) return false;
  await deps.redis.cmd(["HINCRBY", KEY(account), "held", micros.toString()]);
  await deps.redis.cmd(["HSET", PENDING(account), userOpHash.toLowerCase(), JSON.stringify({ held: micros.toString(), validUntil })]);
  return true;
}

/**
 * Settles the account's held operations: each that landed is charged its real cost plus the margin, and one that
 * expired without landing is released. Run before every hold and every balance read.
 */
export async function settle(deps: CreditsDeps, account: Address): Promise<void> {
  const pending = hashToObject(await deps.redis.cmd(["HGETALL", PENDING(account)]));
  const now = Math.floor((deps.now ?? (() => new Date()))().getTime() / 1000);
  for (const [hash, raw] of Object.entries(pending)) {
    let p: { held: string; validUntil: number };
    try {
      p = JSON.parse(raw);
    } catch {
      await deps.redis.cmd(["HDEL", PENDING(account), hash]);
      continue;
    }
    const cost = await deps.userOpCost(hash as Hex).catch(() => null);
    if (cost !== null) {
      const charge = gasCharge(cost, await deps.ethUsd());
      if ((await deps.redis.cmd(["HDEL", PENDING(account), hash])) === 1) {
        await deps.redis.cmd(["HINCRBY", KEY(account), "held", (-BigInt(p.held)).toString()]);
        await deps.redis.cmd(["HINCRBY", KEY(account), "balance", (-charge).toString()]);
      }
    } else if (now > p.validUntil + 600) {
      if ((await deps.redis.cmd(["HDEL", PENDING(account), hash])) === 1) await deps.redis.cmd(["HINCRBY", KEY(account), "held", (-BigInt(p.held)).toString()]);
    }
  }
}

const EP_EVENTS = parseAbi([
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
  "event BeforeExecution()"
]);
const TRANSFER = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

/**
 * Adds credits for a top-up the account made. Only what the treasury received in USDG within this account's own
 * user operation counts (in a bundle, each operation's logs come just before its UserOperationEvent), at least
 * MIN_TOPUP_USDG; when the account paid in $NOMAD (swapped by Stoa to USDG for the treasury), the bonus is added.
 * Each transaction is counted once, for one account.
 */
export async function claimTopUp(deps: CreditsDeps, account: string, txHash: string): Promise<{ addedUsd: string; balance: Balance }> {
  if (!ADDRESS.test(account)) throw new CreditsError(400, "account must be an address.");
  if (!HASH.test(txHash)) throw new CreditsError(400, "txHash must be a transaction hash.");
  const acct = getAddress(account);
  const receipt = await deps.txReceipt(txHash as Hex);
  if (!receipt) throw new CreditsError(404, "That transaction is not on Robinhood Chain yet. Try again in a few seconds.");
  if (receipt.status !== "success") throw new CreditsError(400, "That transaction failed, so nothing was paid.");
  let start = 0;
  let window: typeof receipt.logs | null = null;
  receipt.logs.forEach((l, i) => {
    if (lc(l.address) !== lc(ENTRY_POINT)) return;
    try {
      const ev = decodeEventLog({ abi: EP_EVENTS, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      if (ev.eventName === "BeforeExecution") start = i + 1;
      else if (ev.eventName === "UserOperationEvent") {
        if (lc(ev.args.sender) === lc(acct) && ev.args.success && !window) window = receipt.logs.slice(start, i);
        start = i + 1;
      }
    } catch {
      /* another EntryPoint event */
    }
  });
  if (!window) throw new CreditsError(400, "That transaction is not a payment from this account.");
  let usdg = 0n;
  let paidInNomad = false;
  for (const l of window as typeof receipt.logs) {
    let ev;
    try {
      ev = decodeEventLog({ abi: TRANSFER, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
    } catch {
      continue;
    }
    if (ev.eventName !== "Transfer") continue;
    if (lc(l.address) === lc(USDG) && lc(ev.args.to) === lc(TREASURY)) usdg += ev.args.value;
    if (lc(l.address) === lc(NOMAD) && lc(ev.args.from) === lc(acct)) paidInNomad = true;
  }
  if (usdg < MIN_TOPUP_USDG) throw new CreditsError(400, "That transaction did not pay the treasury at least 1 USDG.");
  const added = paidInNomad ? (usdg * (10_000n + NOMAD_TOPUP_BONUS_BPS)) / 10_000n : usdg;
  if ((await deps.redis.cmd(["SADD", CLAIMED, txHash.toLowerCase()])) !== 1) throw new CreditsError(409, "That top-up was counted already.");
  await deps.redis.cmd(["HINCRBY", KEY(acct), "balance", added.toString()]);
  await settle(deps, acct);
  return { addedUsd: usd(added), balance: await balanceOf(deps, acct) };
}

/** Charges an agent run's AI cost (micro-dollars) to the account; false when the credits do not cover it. */
export async function chargeRun(deps: CreditsDeps, account: Address, micros: bigint): Promise<boolean> {
  await settle(deps, account);
  const b = await readBalance(deps.redis, account);
  if (micros <= 0n) return true;
  if (b.available < micros) return false;
  await deps.redis.cmd(["HINCRBY", KEY(account), "balance", (-micros).toString()]);
  return true;
}

export { usd as formatUsd };
