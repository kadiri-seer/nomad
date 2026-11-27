import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionData, erc20Abi, type Address } from "viem";
import { STOA_SWAP_ABI } from "../../apps/web/lib/accounts/stoa-swap";
import { stoaQuote } from "../../apps/web/lib/accounts/client";
import { NOMAD, STOA_ROUTER, USDG } from "../../apps/web/lib/accounts/chain";

const ME = "0x1111111111111111111111111111111111111111" as Address;
const THIEF = "0x9999999999999999999999999999999999999999" as Address;
const Z = "0x0000000000000000000000000000000000000000" as Address;
const swap = (o: { tokenIn?: Address; tokenOut?: Address; amountIn?: bigint; minOut?: bigint; to?: Address } = {}) =>
  encodeFunctionData({
    abi: STOA_SWAP_ABI,
    functionName: "swap",
    args: [{ tokenIn: o.tokenIn ?? USDG, tokenOut: o.tokenOut ?? NOMAD, mid: Z, leg1: { venue: Z, isPool: true }, leg2: { venue: Z, isPool: false }, amountIn: o.amountIn ?? 1_000_000n, minOut: o.minOut ?? 990n, to: o.to ?? ME, deadline: 9999999999n, referrer: Z }]
  });
const answer = (over: Record<string, unknown> = {}) => ({
  amountOut: "1000",
  minOut: "990",
  priceImpactPct: 0.1,
  tx: { to: STOA_ROUTER, data: swap(), value: "0" },
  approval: { token: USDG, spender: STOA_ROUTER, amount: "1000000" },
  ...over
});
const serve = (body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));

afterEach(() => vi.unstubAllGlobals());

describe("swaps the browser signs from Stoa's quotes", () => {
  it("are an exact approval to Stoa's router, then the swap asked for", async () => {
    serve(answer());
    const q = await stoaQuote(USDG, NOMAD, 1_000_000n, ME);
    expect(q.calls).toHaveLength(2);
    expect(q.calls[0]).toEqual({ to: USDG, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [STOA_ROUTER, 1_000_000n] }) });
    expect(q.calls[1]).toMatchObject({ to: STOA_ROUTER, value: 0n });
  });

  it("refuse an approval to anyone but the router, or of another token", async () => {
    serve(answer({ approval: { token: USDG, spender: THIEF, amount: "1000000" } }));
    await expect(stoaQuote(USDG, NOMAD, 1_000_000n, ME)).rejects.toThrow(/Nothing was signed|nothing was signed/);
    serve(answer({ approval: { token: NOMAD, spender: STOA_ROUTER, amount: "1000000" } }));
    await expect(stoaQuote(USDG, NOMAD, 1_000_000n, ME)).rejects.toThrow(/nothing was signed/i);
  });

  it("refuse a call to another contract, with ETH, paying someone else, of another amount, or with no minimum out", async () => {
    for (const bad of [
      { tx: { to: THIEF, data: swap(), value: "0" } },
      { tx: { to: STOA_ROUTER, data: swap(), value: "1" } },
      { tx: { to: STOA_ROUTER, data: swap({ to: THIEF }), value: "0" } },
      { tx: { to: STOA_ROUTER, data: swap({ amountIn: 2_000_000n }), value: "0" } },
      { tx: { to: STOA_ROUTER, data: swap({ minOut: 0n }), value: "0" } },
      { tx: { to: STOA_ROUTER, data: swap({ minOut: 900n }), value: "0" } },
      { tx: { to: STOA_ROUTER, data: "0xa9059cbb", value: "0" } }
    ]) {
      serve(answer(bad));
      await expect(stoaQuote(USDG, NOMAD, 1_000_000n, ME)).rejects.toThrow(/Nothing was signed/);
    }
  });

  it("a price-only quote (no taker) builds no calls", async () => {
    serve(answer({ tx: { to: THIEF, data: "0x", value: "5" } }));
    expect((await stoaQuote(USDG, NOMAD, 1_000_000n)).calls).toEqual([]);
  });
});
