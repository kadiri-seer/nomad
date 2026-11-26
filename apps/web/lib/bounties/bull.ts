/**
 * Bounty prizes paid through Bull's arbiter escrow on Robinhood Chain (bull.family, read Nov 26, 2026).
 *
 * Once a winner is picked, the treasury locks the prize in a Bull agreement that pays the winner's Nomad account when
 * the reviewer's Nomad account confirms, the arbiter. Bull's fee (0.5% of the prize, at least $0.25) is paid by the
 * treasury in ETH on top. If the reviewer does not confirm before the agreement expires, anyone can refund the
 * treasury. Bull only plans: it returns the two transactions (approve and createAgreement) that the treasury's own
 * wallet sends, and every field of them is checked here before anything is signed.
 */
import { decodeEventLog, decodeFunctionData, encodeFunctionData, erc20Abi, parseAbi, type Address, type Hex } from "viem";

/** Bull's agreements contract on Robinhood Chain. */
export const BULL_AGREEMENTS: Address = "0x7AB58fAAe65eFCF0037635382cAA546EaC233DA6";
export const BULL_MCP = "https://www.bull.family/api/mcp";
export const bullAgreementPage = (id: string) => `https://www.bull.family/agreement/${id}`;
/** How long the reviewer has to confirm before the treasury can be refunded. */
export const ESCROW_HOURS = 72;
/** Bull's condition kind for "this wallet attested" (from its createAgreement plans). */
export const ATTEST_KIND = 1;
/** The most Bull's fee may be, in wei: far above 0.5% of any prize Nomad posts, to catch a wrong plan. */
export const MAX_FEE_WEI = 30_000_000_000_000_000n; // 0.03 ETH

export const BULL_ABI = parseAbi([
  "function createAgreement((address payee,address asset,uint256 amount,uint64 expiry,bytes32 termsHash,(uint8 kind,address target,bytes data,uint256 value)[] conditions) p,(uint256 feeWei,uint64 expiry,bytes sig) q) payable returns (uint256)",
  "function attest(uint256 id,uint256 index)",
  "function release(uint256 id)",
  "event AgreementCreated(uint256 indexed id, address indexed payer, address indexed payee, address asset, uint256 amount, uint64 expiry, bytes32 termsHash)"
]);

export type Call = { to: Address; data: Hex; value: bigint };
export type EscrowPlan = { calls: Call[]; feeWei: bigint; feeUsd: number | null; expiresAt: number; quoteExpiresAt: number | null };
export type EscrowWant = { winner: Address; arbiter: Address; token: Address; amount: bigint; nowSec: number };

const lc = (a: string) => a.toLowerCase();
const isAddr = (s: unknown): s is Address => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
const isHex = (s: unknown): s is Hex => typeof s === "string" && /^0x[0-9a-fA-F]*$/.test(s);

/**
 * Checks Bull's plan for a prize escrow and returns its two calls. Throws unless it is exactly: approve the prize, no
 * more, to Bull's agreements contract; then createAgreement on that contract paying exactly the prize in the prize
 * token to the winner, released by one condition (the arbiter attests), expiring between one and eight days from
 * now, with Bull's fee as the only ETH sent.
 */
export function checkEscrowPlan(plan: unknown, want: EscrowWant): EscrowPlan {
  const p = (plan && typeof plan === "object" ? plan : {}) as Record<string, unknown>;
  const steps = Array.isArray(p.steps) ? p.steps : [];
  if (steps.length !== 2) throw new Error("Bull's plan did not have the two expected steps.");
  const tx = (s: unknown) => {
    const t = ((s as Record<string, unknown>)?.transaction ?? {}) as Record<string, unknown>;
    if (!isAddr(t.to) || !isHex(t.data)) throw new Error("Bull's plan has a step that is not a transaction.");
    const value = BigInt(typeof t.value === "string" && /^\d+$/.test(t.value) ? t.value : "0");
    return { to: t.to, data: t.data, value };
  };
  const approve = tx(steps[0]);
  const create = tx(steps[1]);

  if (lc(approve.to) !== lc(want.token) || approve.value !== 0n) throw new Error("Bull's approve step is not for the prize token.");
  const a = decodeFunctionData({ abi: erc20Abi, data: approve.data });
  if (a.functionName !== "approve" || lc(a.args[0] as string) !== lc(BULL_AGREEMENTS) || (a.args[1] as bigint) !== want.amount)
    throw new Error("Bull's approve step does not approve exactly the prize to Bull's agreements contract.");

  if (lc(create.to) !== lc(BULL_AGREEMENTS)) throw new Error("Bull's plan does not go to Bull's agreements contract.");
  const c = decodeFunctionData({ abi: BULL_ABI, data: create.data });
  if (c.functionName !== "createAgreement") throw new Error("Bull's second step does not create an agreement.");
  const [terms, quote] = c.args as unknown as [
    { payee: Address; asset: Address; amount: bigint; expiry: bigint; conditions: readonly { kind: number; target: Address; data: Hex; value: bigint }[] },
    { feeWei: bigint; expiry: bigint }
  ];
  if (lc(terms.payee) !== lc(want.winner)) throw new Error("Bull's agreement does not pay the winner's account.");
  if (lc(terms.asset) !== lc(want.token) || terms.amount !== want.amount) throw new Error("Bull's agreement is not for exactly the prize.");
  const cond = terms.conditions;
  if (cond.length !== 1 || cond[0].kind !== ATTEST_KIND || lc(cond[0].target) !== lc(want.arbiter) || cond[0].value !== 0n || cond[0].data !== "0x")
    throw new Error("Bull's agreement is not released by the reviewer's confirmation alone.");
  const expiry = Number(terms.expiry);
  if (expiry < want.nowSec + 24 * 3600 || expiry > want.nowSec + 8 * 24 * 3600) throw new Error("Bull's agreement expires too soon or too late.");
  if (create.value !== quote.feeWei || create.value > MAX_FEE_WEI) throw new Error("Bull's fee in the plan is not what it should be.");

  return {
    calls: [approve, create],
    feeWei: create.value,
    feeUsd: typeof p.feeUsd === "number" ? p.feeUsd : null,
    expiresAt: expiry * 1000,
    quoteExpiresAt: typeof p.quoteExpiresAt === "number" ? p.quoteExpiresAt * 1000 : null
  };
}

/** The agreement a createAgreement transaction made, from its receipt's logs. */
export function createdAgreement(logs: readonly { address: string; data: Hex; topics: readonly Hex[] }[]) {
  for (const l of logs) {
    if (lc(l.address) !== lc(BULL_AGREEMENTS)) continue;
    try {
      const ev = decodeEventLog({ abi: BULL_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      if (ev.eventName === "AgreementCreated") {
        const x = ev.args as { id: bigint; payer: Address; payee: Address; asset: Address; amount: bigint; expiry: bigint };
        return { id: x.id.toString(), payer: x.payer, payee: x.payee, asset: x.asset, amount: x.amount, expiresAt: Number(x.expiry) * 1000 };
      }
    } catch {
      /* another event */
    }
  }
  return null;
}

/** What the arbiter sends to pay the winner: its confirmation, then the release, in one operation. */
export function confirmAndReleaseCalls(id: string): Call[] {
  const n = BigInt(id);
  return [
    { to: BULL_AGREEMENTS, data: encodeFunctionData({ abi: BULL_ABI, functionName: "attest", args: [n, 0n] }), value: 0n },
    { to: BULL_AGREEMENTS, data: encodeFunctionData({ abi: BULL_ABI, functionName: "release", args: [n] }), value: 0n }
  ];
}
