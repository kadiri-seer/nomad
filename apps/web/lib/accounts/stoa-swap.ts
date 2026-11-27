/**
 * Stoa's router swap, as its public API encodes it, and the checks every swap Nomad signs must pass, in the browser
 * and on the server: the call goes to Stoa's router with no ETH, swaps exactly the tokens and amount asked for, pays
 * out to the address asked for, and keeps a real minimum out. Its approval is for Stoa's router and exactly the
 * amount sold. A quote that fails any of these is not signed, whatever Stoa's API returned.
 */
import { decodeFunctionData, encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import { STOA_ROUTER } from "./chain";

/** swap((tokenIn, tokenOut, mid, leg1, leg2, amountIn, minOut, to, deadline, referrer)). */
export const STOA_SWAP_ABI = [
  {
    type: "function",
    name: "swap",
    stateMutability: "payable",
    inputs: [
      {
        name: "p",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "mid", type: "address" },
          { name: "leg1", type: "tuple", components: [{ name: "venue", type: "address" }, { name: "isPool", type: "bool" }] },
          { name: "leg2", type: "tuple", components: [{ name: "venue", type: "address" }, { name: "isPool", type: "bool" }] },
          { name: "amountIn", type: "uint256" },
          { name: "minOut", type: "uint256" },
          { name: "to", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "referrer", type: "address" }
        ]
      }
    ],
    outputs: [{ type: "uint256" }]
  }
] as const;

export function stoaSwap(data: Hex): { tokenIn: Address; tokenOut: Address; to: Address; amountIn: bigint; minOut: bigint } | null {
  try {
    const d = decodeFunctionData({ abi: STOA_SWAP_ABI, data });
    const p = d.args[0];
    return { tokenIn: p.tokenIn, tokenOut: p.tokenOut, to: p.to, amountIn: p.amountIn, minOut: p.minOut };
  } catch {
    return null;
  }
}

/** The lowest minimum out accepted, against the quoted amount: 98% (Nomad asks Stoa for 1% slippage). */
export const MIN_OUT_BPS = 9_800n;

const lc = (a: string) => a.toLowerCase();

export type StoaTx = { to: string; data: Hex; value?: bigint | string | number };
export type Call = { to: Address; data: Hex; value?: bigint };

/**
 * The calls for one checked swap: an exact approval to Stoa's router when Stoa says one is needed, then the swap.
 * Throws when the swap Stoa returned is not exactly the one asked for.
 */
export function checkedSwapCalls(tx: StoaTx | null | undefined, needsApproval: boolean, want: { sell: Address; buy: Address; amountIn: bigint; to: Address; amountOut: bigint }): Call[] {
  if (!tx || lc(tx.to) !== lc(STOA_ROUTER) || BigInt(tx.value ?? 0) !== 0n) throw new Error("Stoa's swap did not go to its router.");
  const s = stoaSwap(tx.data);
  if (!s || lc(s.tokenIn) !== lc(want.sell) || lc(s.tokenOut) !== lc(want.buy) || lc(s.to) !== lc(want.to) || s.amountIn !== want.amountIn) throw new Error("Stoa's swap was not the one asked for.");
  if (s.minOut === 0n || s.minOut * 10_000n < want.amountOut * MIN_OUT_BPS) throw new Error("Stoa's swap had no safe minimum out.");
  const calls: Call[] = [];
  if (needsApproval) calls.push({ to: want.sell, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [STOA_ROUTER, want.amountIn] }) });
  calls.push({ to: STOA_ROUTER, data: tx.data, value: 0n });
  return calls;
}
