/**
 * Stoa, as the agent runner uses it: its keyless MCP server for tokens, market data and safety checks, and its public
 * quote API for swaps. Everything it returns is data; nothing here signs or sends.
 */
import { getAddress, type Address, type Hex } from "viem";
import { STOA_QUOTE_API, STOA_ROUTER } from "../accounts/chain";

const MCP = "https://stoadex.com/mcp";
type FetchLike = typeof fetch;

export type StoaToken = { address: Address; symbol: string; name: string; decimals: number };
export type TokenMarket = {
  address: Address;
  symbol: string;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  change24hPct: number | null;
  riskLabel: string | null;
};
export type Safety = { verdict: "ok" | "caution" | "danger" | "unknown"; buyTaxPct: number | null; sellTaxPct: number | null; buyOk: boolean; sellOk: boolean; notes: string[] };
export type StockToken = { address: Address; symbol: string; name: string; halted: boolean; refPriceUsd: number | null; priceUsd: number | null; liquidityUsd: number | null; volume24hUsd: number | null; change24hPct: number | null; gapPct: number | null; route: boolean };
export type Market = { fearAndGreed: { value: number; label: string } | null; ethUsd: number | null };
export type Quote = {
  amountOut: bigint;
  minOut: bigint;
  priceImpactPct: number;
  tx: { to: Address; data: Hex; value: bigint } | null;
  approval: { spender: Address; amount: bigint; token: Address } | null;
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

export function stoa(fetchImpl: FetchLike = fetch) {
  async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const r = await fetchImpl(MCP, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(20_000),
      cache: "no-store"
    });
    const text = await r.text();
    const json = text.trimStart().startsWith("{")
      ? JSON.parse(text)
      : JSON.parse(
          text
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5))
            .join("")
        );
    const res = json.result as { structuredContent?: T; isError?: boolean; content?: { text?: string }[] } | undefined;
    if (!res || res.isError) throw new Error(`Stoa ${name}: ${res?.content?.[0]?.text?.slice(0, 120) ?? json.error?.message ?? r.status}`);
    if (res.structuredContent) return res.structuredContent;
    return JSON.parse(res.content?.[0]?.text ?? "null") as T;
  }

  return {
    async listTokens(): Promise<StoaToken[]> {
      const r = await call<{ tokens: { address: string; symbol: string; name: string; decimals: number }[] }>("list_tokens", { chain: "robinhood" });
      return r.tokens.filter((t) => /^0x[0-9a-fA-F]{40}$/.test(t.address)).map((t) => ({ address: getAddress(t.address), symbol: t.symbol, name: t.name, decimals: t.decimals }));
    },

    /** Market overview plus up to five tokens' liquidity, volume and price. */
    async marketContext(tokens: Address[]): Promise<{ market: Market; tokens: TokenMarket[] }> {
      const r = await call<{ market?: Record<string, unknown>; tokens?: Record<string, unknown>[] }>("market_context", tokens.length ? { tokens: tokens.slice(0, 5) } : {});
      const m = r.market ?? {};
      const fg = m.fearAndGreed as { value?: number; label?: string } | undefined;
      return {
        market: { fearAndGreed: fg && typeof fg.value === "number" ? { value: fg.value, label: String(fg.label ?? "") } : null, ethUsd: num(m.ethUsd) },
        tokens: (r.tokens ?? [])
          .filter((t) => typeof t.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(t.address as string))
          .map((t) => {
            const d = (t.last24h ?? {}) as Record<string, unknown>;
            return {
              address: getAddress(t.address as string),
              symbol: String(t.symbol ?? "?"),
              priceUsd: num(t.priceUsd),
              liquidityUsd: num(t.liquidityUsd),
              volume24hUsd: num(d.volumeUsd),
              change24hPct: num(d.priceChangePct),
              riskLabel: typeof t.cmcRiskLabel === "string" ? t.cmcRiskLabel : null
            };
          })
      };
    },

    /**
     * Robinhood's stock tokens on Robinhood Chain that Stoa routes right now: Robinhood's price for each (from the
     * underlying shares), the on-chain price and market, the gap between them, and whether Robinhood halted it.
     */
    async stockTokens(): Promise<StockToken[]> {
      const r = await call<{ stocks?: Record<string, unknown>[] }>("stock_tokens", { routableOnly: true });
      return (r?.stocks ?? [])
        .filter((t) => typeof t.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(t.address as string) && typeof t.symbol === "string")
        .map((t) => {
          const oc = (t.onChain && typeof t.onChain === "object" ? t.onChain : null) as Record<string, unknown> | null;
          return {
            address: getAddress(t.address as string),
            symbol: String(t.symbol).slice(0, 16),
            name: String(t.name ?? t.symbol).slice(0, 80),
            halted: t.halted === true,
            refPriceUsd: num(t.robinhoodPriceUsd),
            priceUsd: oc ? num(oc.priceUsd) : null,
            liquidityUsd: oc ? num(oc.liquidityUsd) : null,
            volume24hUsd: oc ? num(oc.volume24h) : null,
            change24hPct: oc ? num(oc.change24h) : null,
            gapPct: num(t.gapPct),
            route: t.routeOnStoa === true
          };
        });
    },
    async safetyCheck(token: Address): Promise<Safety> {
      const r = await call<Record<string, unknown>>("safety_check", { chain: "robinhood", token });
      const t = (r.test ?? {}) as Record<string, unknown>;
      const verdict = ["ok", "caution", "danger", "unknown"].includes(String(r.verdict)) ? (r.verdict as Safety["verdict"]) : "unknown";
      return { verdict, buyTaxPct: num(t.buyTaxPct), sellTaxPct: num(t.sellTaxPct), buyOk: t.buyOk === true, sellOk: t.sellOk === true, notes: Array.isArray(r.notes) ? r.notes.map(String).slice(0, 5) : [] };
    },

    /** A fresh quote for exactly `amount`, with the swap built for `taker` (Stoa's public API). */
    async quote(sellToken: Address, buyToken: Address, amount: bigint, taker: Address, slippageBps = 100): Promise<Quote> {
      const u = new URL(STOA_QUOTE_API);
      for (const [k, v] of Object.entries({ chain: "robinhood", sellToken, buyToken, amount: amount.toString(), slippageBps: String(slippageBps), taker })) u.searchParams.set(k, v);
      const r = await fetchImpl(u, { signal: AbortSignal.timeout(20_000), cache: "no-store" });
      const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (!r.ok) throw new Error(`Stoa quote: ${String(j.error ?? r.status)}`);
      const tx = j.tx as { to?: string; data?: string; value?: string } | undefined;
      const ap = j.approval as { spender?: string; amount?: string; token?: string } | undefined;
      return {
        amountOut: BigInt(String(j.amountOut ?? "0")),
        minOut: BigInt(String(j.minOut ?? "0")),
        priceImpactPct: num(j.priceImpactPct) ?? 100,
        tx: tx?.to && tx.data ? { to: getAddress(tx.to), data: tx.data as Hex, value: BigInt(tx.value ?? "0") } : null,
        approval: ap?.spender ? { spender: getAddress(ap.spender), amount: BigInt(ap.amount ?? amount.toString()), token: getAddress(ap.token ?? sellToken) } : null
      };
    }
  };
}

export type Stoa = ReturnType<typeof stoa>;
export { STOA_ROUTER };
