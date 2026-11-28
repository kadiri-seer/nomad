import { afterEach, describe, expect, it, vi } from "vitest";
import { PRICE_QUOTE_API, PRICE_USDG, dollars, nomadUsd, priceFromQuote } from "../../apps/web/lib/nomad-price";
import { STOA_QUOTE_API, USDG } from "../../apps/web/lib/accounts/chain";
import { nomadAmount } from "../../apps/web/lib/economy";

afterEach(() => vi.unstubAllGlobals());

describe("$NOMAD in dollars", () => {
  it("asks Stoa for the same USDG and quote address the rest of the site uses", () => {
    expect(PRICE_USDG.toLowerCase()).toBe(USDG.toLowerCase());
    expect(PRICE_QUOTE_API).toBe(STOA_QUOTE_API);
  });

  it("turns what 1 USDG buys into dollars per $NOMAD", () => {
    // 1 USDG buys 250 $NOMAD: each is $0.004.
    expect(priceFromQuote((250n * 10n ** 18n).toString())).toBeCloseTo(0.004, 10);
    expect(priceFromQuote("0")).toBeNull();
    expect(priceFromQuote(undefined)).toBeNull();
    expect(priceFromQuote("not a number")).toBeNull();
  });

  it("shows a $NOMAD amount with its dollar value, or alone without a price", () => {
    expect(nomadAmount(1200, 0.004)).toBe("1,200 $NOMAD ($4.80)");
    expect(nomadAmount(1200, null)).toBe("1,200 $NOMAD");
    expect(dollars(0.001)).toBe("<$0.01");
  });

  it("reads Stoa's live quote, and falls back when Stoa does not answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ amountOut: (500n * 10n ** 18n).toString() }), { status: 200 })));
    expect(await nomadUsd(null)).toBeCloseTo(0.002, 10);
  });
});
