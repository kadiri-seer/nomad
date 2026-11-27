import { describe, expect, it } from "vitest";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { STOA_ROUTER, USDG } from "../../apps/web/lib/accounts/chain";
import { DEFAULT_STOCKS, TEMPLATES, type AgentRecord } from "../../apps/web/lib/agents/shared";
import { agentStore } from "../../apps/web/lib/server/agents-store";
import { buildStockCandidates, runAgent, stockPasses, type Candidate, type RunnerDeps } from "../../apps/web/lib/server/runner";
import { stoa, type Quote, type Safety, type StockToken } from "../../apps/web/lib/server/stoa";
import { MemoryRedis } from "../../apps/web/lib/redis";

const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const OWNER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;
const NVDA = "0x1111111111111111111111111111111111111111" as Address;
const TSLA = "0x2222222222222222222222222222222222222222" as Address;
const Z = "0x0000000000000000000000000000000000000000" as Address;
const OK: Safety = { verdict: "ok", buyTaxPct: 0, sellTaxPct: 0, buyOk: true, sellOk: true, notes: [] };

const stock = (over: Partial<StockToken> = {}): StockToken => ({
  address: NVDA,
  symbol: "NVDA",
  name: "NVIDIA",
  halted: false,
  refPriceUsd: 180,
  priceUsd: 180.9,
  liquidityUsd: 250_000,
  volume24hUsd: 90_000,
  change24hPct: 1.2,
  gapPct: 0.5,
  route: true,
  ...over
});

function agent(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "9",
    name: "Desk",
    template: "stocks",
    limits: { perTradeUsd: "0.30", tradesPerDay: 3 },
    runEveryHours: 6,
    status: "active",
    owner: OWNER,
    signer: Z,
    account: WALLET,
    salt: "1",
    deferredAction: "0x00",
    sessionAddress: Z,
    sessionEntityId: 1,
    sessionDeadline: 2_000_000_000,
    packageHash: "0x00",
    mintTx: "0x00",
    createdAt: 0,
    stocksConfirmedAt: 0,
    ...over
  };
}

const SWAP_ABI = [
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
const quote = (sell: Address, buy: Address, amount: bigint, out: bigint, taker: Address): Quote => ({
  amountOut: out,
  minOut: out,
  priceImpactPct: 0.2,
  tx: {
    to: STOA_ROUTER,
    data: encodeFunctionData({ abi: SWAP_ABI, functionName: "swap", args: [{ tokenIn: sell, tokenOut: buy, mid: Z, leg1: { venue: Z, isPool: true }, leg2: { venue: Z, isPool: false }, amountIn: amount, minOut: out - out / 100n, to: taker, deadline: 9999999999n, referrer: Z }] }),
    value: 0n
  },
  approval: { spender: STOA_ROUTER, amount, token: sell }
});

async function stockCandidates(list: StockToken[], safety: Safety = OK) {
  const store = agentStore(new MemoryRedis());
  return buildStockCandidates({ stockTokens: async () => list, safetyCheck: async () => safety }, store);
}

function harness(opts: { stocks: Candidate[]; answer?: string; prompts?: string[]; now?: number }) {
  const store = agentStore(new MemoryRedis());
  const sent: unknown[] = [];
  const balances: Record<string, bigint> = { [USDG.toLowerCase()]: 5_000_000n };
  const d: RunnerDeps = {
    store,
    now: () => opts.now ?? 1_800_000_000_000,
    credits: { available: async () => 1_000_000n, charge: async () => true },
    balanceOf: async (t) => balances[t.toLowerCase()] ?? 0n,
    quote: async (sell, buy, amount, taker) => quote(sell, buy, amount, sell === USDG ? amount * 10n ** 9n : amount / 10n ** 9n, taker),
    candidates: async () => {
      throw new Error("a Stocks agent must not use the launch-token list");
    },
    stockCandidates: async () => opts.stocks,
    sender: async () => ({
      async send(calls) {
        sent.push(calls);
        balances[NVDA.toLowerCase()] = (balances[NVDA.toLowerCase()] ?? 0n) + 1n;
        return `0x${"cd".repeat(32)}` as Hex;
      }
    }),
    ai: {
      name: "Gemini",
      ask: async (prompt) => {
        opts.prompts?.push(prompt);
        return opts.answer ?? "ACTION: HOLD\nREASON: nothing stands out";
      }
    },
    idlex: null,
    oddsEngine: {
      name: "OddsEngine",
      scanToken: async () => {
        throw new Error("OddsEngine looks for launch-token risks and is not asked about stock tokens");
      }
    },
    sleep: async () => undefined
  };
  return { d, store, sent, balances };
}

describe("Stocks agents", () => {
  it("is a template", () => {
    expect(TEMPLATES).toContain("stocks");
  });

  it("passes a routed, live stock token near Robinhood's price with real liquidity", () => {
    expect(stockPasses(stock(), OK)).toBe(true);
    expect(stockPasses(stock({ halted: true }), OK)).toBe(false);
    expect(stockPasses(stock({ route: false }), OK)).toBe(false);
    expect(stockPasses(stock({ gapPct: 2.5 }), OK)).toBe(false);
    expect(stockPasses(stock({ gapPct: -2.5 }), OK)).toBe(false);
    expect(stockPasses(stock({ gapPct: null }), OK)).toBe(false);
    expect(stockPasses(stock({ refPriceUsd: null }), OK)).toBe(false);
    expect(stockPasses(stock({ liquidityUsd: 5_000 }), OK)).toBe(false);
    expect(stockPasses(stock(), { ...OK, verdict: "caution" })).toBe(false);
    expect(stockPasses(stock(), { ...OK, sellOk: false })).toBe(false);
  });

  it("keeps only the stock tokens near Robinhood's price, most liquid first, with their facts", async () => {
    const list = await stockCandidates([stock({ address: TSLA, symbol: "TSLA", name: "Tesla", liquidityUsd: 900_000 }), stock(), stock({ address: Z, symbol: "FAR", gapPct: 9 })]);
    expect(list.map((c) => c.symbol)).toEqual(["TSLA", "NVDA"]);
    expect(list[1].stock).toEqual({ name: "NVIDIA", refPriceUsd: 180, gapPct: 0.5, halted: false });
    expect(list.every((c) => c.passes)).toBe(true);
    expect((await stockCandidates([stock()], { ...OK, verdict: "danger" }))[0].passes).toBe(false);
  });

  it("reads Stoa's stock_tokens answer and drops what is not a token", async () => {
    let asked: unknown;
    const fetchImpl = (async (_u: unknown, init: { body: string }) => {
      asked = JSON.parse(init.body).params;
      const structuredContent = {
        stocks: [
          { symbol: "NVDA", name: "NVIDIA", address: NVDA, halted: false, robinhoodPriceUsd: 180, onChain: { priceUsd: 181, liquidityUsd: 1000, volume24h: 50, change24h: 2 }, gapPct: 0.556, routeOnStoa: true },
          { symbol: "XX", name: "No chain", address: TSLA, halted: true, robinhoodPriceUsd: 10, onChain: null, gapPct: null, routeOnStoa: false },
          { symbol: "BAD", address: "not an address" }
        ]
      };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent } }));
    }) as unknown as typeof fetch;
    const list = await stoa(fetchImpl).stockTokens();
    expect(asked).toEqual({ name: "stock_tokens", arguments: { routableOnly: true } });
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ symbol: "NVDA", refPriceUsd: 180, priceUsd: 181, gapPct: 0.556, route: true, halted: false });
    expect(list[1]).toMatchObject({ priceUsd: null, liquidityUsd: null, halted: true, route: false });
  });

  it("decides among the checked stock tokens, following DEFAULT_STOCKS when it has no instructions", async () => {
    const prompts: string[] = [];
    const h = harness({ stocks: await stockCandidates([stock()]), answer: "ACTION: BUY NVDA\nREASON: close to Robinhood's price", prompts });
    const notes = await runAgent(h.d, agent());
    expect(prompts[0]).toContain(DEFAULT_STOCKS.slice(0, 40));
    expect(prompts[0]).toContain("Robinhood's price: $180.00");
    expect(notes[0]).toMatch(/^Bought NVDA \(NVIDIA\) with 0\.30 USDG: Robinhood's price \$180\.00, on-chain \$180\.90 \(\+0\.50% from Robinhood's price\)/);
    expect(h.sent).toHaveLength(1);
    expect((await h.store.positions("9"))[0]).toMatchObject({ symbol: "NVDA" });
  });

  it("holds when no stock token passes, and buys nothing the checks ruled out", async () => {
    const none = harness({ stocks: await stockCandidates([stock({ halted: true })]) });
    expect((await runAgent(none.d, agent()))[0]).toMatch(/no stock token passed every check/);
    const off = harness({ stocks: await stockCandidates([stock()]), answer: "ACTION: BUY TSLA\nREASON: hype" });
    expect((await runAgent(off.d, agent({ instructions: "Buy Tesla." })))[0]).toMatch(/TSLA, which did not pass/);
    expect(off.sent).toHaveLength(0);
  });

  it("sells on its own, slower exits: up 10%, down 8%, or after 7 days", async () => {
    const now = 1_800_000_000_000;
    const h = harness({ stocks: [], now });
    const hold = async (costMicros: string, hoursAgo: number) => {
      await h.store.setPosition("9", { token: NVDA, symbol: "NVDA", decimals: 18, amount: (10n ** 15n).toString(), costMicros, boughtAt: now - hoursAgo * 3_600_000 });
      h.balances[NVDA.toLowerCase()] = 10n ** 15n;
    };
    // 10^15 sells for 10^6 micros (1 USDG). Bought for 0.95: up 5%, held 2 days: kept.
    await hold("950000", 48);
    expect((await runAgent(h.d, agent())).join(" ")).not.toMatch(/Sold/);
    // Bought for 0.90: up 11%: sold.
    await hold("900000", 1);
    expect((await runAgent(h.d, agent({ tradesToday: 0 }))).join(" ")).toMatch(/Sold all its NVDA.*up 11%/);
    // Bought for 1.00, held 8 days: sold.
    await hold("1000000", 24 * 8);
    expect((await runAgent(h.d, agent({ tradesToday: 0 }))).join(" ")).toMatch(/held 7 days/);
  });
});
