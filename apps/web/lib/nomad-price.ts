/**
 * $NOMAD's live price in dollars, for showing $NOMAD amounts in dollars the way ETH is: Stoa's quote for what 1 USDG
 * buys right now (Stoa routes $NOMAD's own pools), turned into dollars per $NOMAD, with the explorer's rate as a
 * fallback. Read in the browser, at most once a minute per page; null when neither answers.
 */
import { TOKEN_CA } from "./token";

// Kept here rather than imported from accounts/chain, which imports agent.ts, which imports this file. A test checks
// they match accounts/chain.ts.
export const PRICE_USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
export const PRICE_QUOTE_API = "https://stoadex.com/api/v1/quote";
const NOMAD = TOKEN_CA;

let cached: { at: number; usd: number | null } | null = null;
let inflight: Promise<number | null> | null = null;

/** Dollars per $NOMAD from what 1 USDG buys, in $NOMAD's smallest units (18 decimals). */
export function priceFromQuote(amountOut: string | number | bigint | undefined | null): number | null {
  if (amountOut === undefined || amountOut === null) return null;
  let out: bigint;
  try {
    out = BigInt(amountOut);
  } catch {
    return null;
  }
  if (out <= 0n) return null;
  const nomadPerDollar = Number(out) / 1e18;
  return nomadPerDollar > 0 && Number.isFinite(nomadPerDollar) ? 1 / nomadPerDollar : null;
}

async function stoaPrice(signal?: AbortSignal): Promise<number | null> {
  const q = new URLSearchParams({ chain: "robinhood", sellToken: PRICE_USDG, buyToken: NOMAD, amount: "1000000", slippageBps: "100" });
  const r = await fetch(`${PRICE_QUOTE_API}?${q}`, { cache: "no-store", signal });
  if (!r.ok) return null;
  const j = (await r.json().catch(() => ({}))) as { amountOut?: string };
  return priceFromQuote(j.amountOut);
}

/** $NOMAD in dollars now: Stoa's live quote, or the explorer's rate, or null. */
export async function nomadUsd(fallback: number | null = null, signal?: AbortSignal): Promise<number | null> {
  if (cached && Date.now() - cached.at < 60_000) return cached.usd ?? fallback;
  inflight ??= stoaPrice(signal)
    .catch(() => null)
    .then((usd) => {
      cached = { at: Date.now(), usd };
      inflight = null;
      return usd;
    });
  return (await inflight) ?? fallback;
}

/** A dollar amount for a $NOMAD figure: "$12.40", or "<$0.01" for a crumb. */
export function dollars(n: number): string {
  if (!(n > 0)) return "$0.00";
  if (n < 0.01) return "<$0.01";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
