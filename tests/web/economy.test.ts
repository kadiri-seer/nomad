import { REWARD_SAFE, TOKEN_CA } from "../../apps/web/lib/token";
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, parseAbi, type Abi } from "viem";
import { addDollarFees, agentsFromLogs, parseBalances, parseBounties, parseBuybacks, parseCosts, parseTransfers, sumBySymbol, ECONOMY_WALLETS, BURN_ADDRESS } from "../../apps/web/lib/economy";
import { AGENTS_ABI } from "../../apps/web/lib/agents-contract";
import { AGENTS_BYTECODE } from "../../apps/web/lib/agents-bytecode";
import { PAYMASTER_ABI, PAYMASTER_BYTECODE } from "../../apps/web/lib/paymaster-contract";
// @ts-expect-error plain JavaScript module
import { agentsTx, batch, bountyTx, burnTx, nomadAmount, recordBuyback, SAFE } from "../../scripts/economy/lib.mjs";

/** The economy page, minted agents and the treasury tools: what they read, what they show and what they write. */
const ROOT = resolve(__dirname, "../..");
const NOMAD = "0x14c0a77e792f6c9818888630e95c50cf3b48c979";
const H = "0x" + "ab".repeat(32);
const ADDR = "0x1111111111111111111111111111111111111111";
const tok = (symbol: string, address: string, decimals = "18") => ({ address_hash: address, symbol, decimals, type: "ERC-20", exchange_rate: null });

describe("economy page copy", () => {
  it("follows the site's rules and never promises returns", () => {
    for (const f of ["apps/web/app/economy/page.tsx", "apps/web/components/EconomyLive.tsx", "apps/web/components/AgentCosts.tsx", "apps/web/lib/economy.ts", "apps/web/app/agents/page.tsx", "apps/web/components/AgentsMarket.tsx", "apps/web/components/account/AccountApp.tsx", "apps/web/components/account/MyAgents.tsx", "apps/web/app/docs/agents/page.tsx", "apps/web/components/account/AccountFast.tsx", "apps/web/lib/server/runner.ts", "apps/web/app/account/page.tsx", "docs/token.md", "docs/economy.md", "apps/web/app/docs/token/page.tsx"]) {
      const text = readFileSync(join(ROOT, f), "utf8");
      expect(text.includes("—"), `${f}: em dash`).toBe(false);
      expect(/\p{Extended_Pictographic}/u.test(text), `${f}: emoji`).toBe(false);
      for (const re of [/\bofficial\b/i, /\bpartner\b/i, /airdrop/i, /token launch/i, /guaranteed?/i, /\bAPY\b/, /passive income/i, /to the moon/i]) expect(re.test(text), `${f}: ${re}`).toBe(false);
      expect(/\b(PC|laptop|my computer)\b/.test(text), `${f}: where Nomad AI runs`).toBe(false);
    }
  });

  it("names every wallet it follows, once", () => {
    const ids = ECONOMY_WALLETS.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ECONOMY_WALLETS.find((w) => w.id === "treasury")?.address).toBe("0xe4862B7605f0CD66796F5d1A9cC936462642b515");
  });
});

describe("reading the explorer", () => {
  it("balances: ETH and fungible tokens, $NOMAD named and priced when a price is known; NFTs left out", () => {
    const b = parseBalances(ECONOMY_WALLETS[0], { coin_balance: "500000000000000000", exchange_rate: "3000" }, [
      { token: tok("NOMAD", NOMAD), value: "2500000000000000000000000" },
      { token: { ...tok("USDG", "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", "6"), exchange_rate: "1" }, value: "12500000" },
      { token: { address_hash: ADDR, type: "ERC-721", decimals: null }, value: "1" },
      { token: tok("ZERO", ADDR), value: "0" }
    ], 0.0001);
    expect(b.balances).toEqual([
      { symbol: "ETH", amount: 0.5, usd: 1500, token: null },
      { symbol: "$NOMAD", amount: 2_500_000, usd: 250, token: NOMAD },
      { symbol: "USDG", amount: 12.5, usd: 12.5, token: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" }
    ]);
    expect(b.usd).toBe(1762.5);
  });

  it("spam airdrops are left out of balances and transfers", () => {
    const SPAM = "0x71Fa6238a4F61673B0bf81f2F64F54ea651C59B7";
    expect(parseBalances(ECONOMY_WALLETS[2], { coin_balance: "0" }, [{ token: tok("ROBINCAT", SPAM), value: "60000000000000000000000" }], null).balances.map((b) => b.symbol)).toEqual(["ETH"]);
    expect(parseTransfers({ items: [{ transaction_hash: H, token: tok("ROBINCAT", SPAM), total: { value: "1" }, from: { hash: ADDR }, to: { hash: ADDR } }] })).toEqual([]);
  });

  it("transfers: only fungible ones with real hashes, summed per token", () => {
    const list = parseTransfers({
      items: [
        { transaction_hash: H, timestamp: "2026-11-23T10:00:00Z", from: { hash: ADDR }, to: { hash: BURN_ADDRESS }, token: tok("NOMAD", NOMAD), total: { value: "1000000000000000000000", decimals: "18" } },
        { transaction_hash: H, timestamp: "2026-11-23T11:00:00Z", from: { hash: ADDR }, to: { hash: BURN_ADDRESS }, token: tok("NOMAD", NOMAD), total: { value: "500000000000000000000" } },
        { transaction_hash: "not a hash", token: tok("NOMAD", NOMAD), total: { value: "1" } },
        { transaction_hash: H, token: { type: "ERC-721" }, total: { token_id: "1" } }
      ]
    });
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ symbol: "$NOMAD", amount: 1000, to: BURN_ADDRESS });
    expect(sumBySymbol(list)).toEqual([{ symbol: "$NOMAD", amount: 1500 }]);
  });
});

describe("Nomad AI's costs feed", () => {
  const feed = {
    updated: "2026-11-23T10:00:00.000Z",
    month: "2026-11",
    thisMonth: { runs: 3, aiUsd: "1.25", oddsEngineChecks: 10, oddsEngineUsd: "0.20", upochTransactions: 4, networkFeesEth: "0.001", networkFeesUsd: "3.00", payments: 0, paymentsUsd: "0.00", totalUsd: "4.45", trades: 2, tradedUsd: "0.60" },
    allTime: { runs: 3, aiUsd: "1.25", oddsEngineChecks: 10, oddsEngineUsd: "0.20", upochTransactions: 4, networkFeesEth: "0.001", networkFeesUsd: null, payments: 0, paymentsUsd: "0.00", totalUsd: "4.45", trades: 2, tradedUsd: "0.60" },
    budget: { monthlyUsd: "100.00", usedPct: 4 },
    payments: [{ time: "2026-11-23T10:00:00.000Z", name: "Memoria <script>", amount: "50", token: "MEMORIA", txHash: H }]
  };
  it("is read field by field; anything out of shape becomes a safe default", () => {
    const c = parseCosts(feed)!;
    expect(c.thisMonth.totalUsd).toBe("4.45");
    expect(c.allTime.networkFeesUsd).toBeNull();
    expect(c.payments[0]).toEqual({ time: feed.payments[0].time, name: "Memoria script", amount: "50", token: "MEMORIA", txHash: H });
    const bad = parseCosts({ ...feed, thisMonth: { aiUsd: "<b>9</b>", runs: -1, totalUsd: 5 } })!;
    expect(bad.thisMonth).toMatchObject({ aiUsd: "0.00", runs: 0, totalUsd: "0.00" });
    expect(parseCosts({ month: "nope" })).toBeNull();
  });
});

describe("bounties and buybacks", () => {
  it("bounties come from the issue form; pull requests are left out", () => {
    const b = parseBounties([
      { number: 7, title: "[Bounty] Windsurf adapter", state: "open", html_url: "https://github.com/kadiri-seer/nomad/issues/7", body: "### Integration\n\nWindsurf adapter\n\n### Bounty amount\n\n250000 $NOMAD\n\n### Funding transaction\n\nx" },
      { number: 8, title: "[Bounty] Done one", state: "closed", html_url: "https://evil.example/8", body: "### Bounty amount\n\n_No response_" },
      { number: 9, title: "PR", pull_request: {} }
    ]);
    expect(b).toEqual([
      { number: 7, title: "Windsurf adapter", url: "https://github.com/kadiri-seer/nomad/issues/7", state: "open", amount: "250000 $NOMAD", integration: "Windsurf adapter" },
      { number: 8, title: "Done one", url: "https://github.com/kadiri-seer/nomad/issues/8", state: "done", amount: null, integration: null }
    ]);
  });

  it("buybacks count only with their own transaction, newest first", () => {
    expect(parseBuybacks({ buybacks: [{ date: "2026-12-01", spent: "500 USDG", bought: "1200000 $NOMAD", tx: H }, { date: "2026-12-05", spent: "x", bought: "y", tx: "0x12" }, { date: "2026-12-09", spent: "1 USDG", bought: "2 $NOMAD", tx: H, burnTx: H }] })).toEqual([
      { date: "2026-12-09", spent: "1 USDG", bought: "2 $NOMAD", tx: H, burnTx: H, note: "" },
      { date: "2026-12-01", spent: "500 USDG", bought: "1200000 $NOMAD", tx: H, burnTx: null, note: "" }
    ]);
    expect(JSON.parse(readFileSync(join(ROOT, "governance/economy.json"), "utf8")).buybacks).toEqual([]);
  });
});

describe("minted agents from the contract's events", () => {
  const abi = AGENTS_ABI as unknown as Abi;
  const log = (eventName: string, args: Record<string, unknown>, block: number) => {
    const ev = (AGENTS_ABI as readonly { type: string; name?: string; inputs?: readonly { name: string; type: string; indexed?: boolean }[] }[]).find((x) => x.type === "event" && x.name === eventName)!;
    const topics = encodeEventTopics({ abi, eventName, args } as Parameters<typeof encodeEventTopics>[0]);
    const data = encodeAbiParameters(ev.inputs!.filter((i) => !i.indexed), ev.inputs!.filter((i) => !i.indexed).map((i) => args[i.name]) as never);
    return { topics, data, block_number: block, index: 0, timestamp: `2026-12-0${block}T00:00:00Z`, transaction_hash: H };
  };
  const E = (n: number) => BigInt(n) * 10n ** 18n;
  it("applies mints, price changes, link changes and copies in chain order", () => {
    const s = agentsFromLogs({
      items: [
        log("Copied", { id: 1n, buyer: ADDR, owner: ADDR, price: E(900), toOwner: E(810), toTreasury: E(45), burned: E(45) }, 4),
        log("PriceSet", { id: 1n, price: E(900) }, 3),
        log("Minted", { id: 1n, creator: ADDR, packageHash: H, name: "Pip", uri: "https://example.com/pip.nomad", price: E(500), fee: E(10000), burned: E(5000) }, 1),
        log("Minted", { id: 2n, creator: ADDR, packageHash: "0x" + "cd".repeat(32), name: "Free", uri: "javascript:alert(1)", price: 0n, fee: E(10000), burned: E(5000) }, 2),
        { topics: ["0x" + "00".repeat(32)], data: "0x", block_number: 5 }
      ]
    });
    expect(s.agents.map((a) => [a.id, a.name, a.price, a.copies, a.uri])).toEqual([
      [2, "Free", 0, 0, ""],
      [1, "Pip", 900, 1, "https://example.com/pip.nomad"]
    ]);
    expect(s).toMatchObject({ burned: 10045, toTreasury: 10045, toCreators: 810 });
  });

  it("the site's ABI and bytecode are the compiled contract's", () => {
    const art = JSON.parse(readFileSync(join(ROOT, "contracts/artifacts/NomadAgents.json"), "utf8"));
    expect(AGENTS_ABI).toEqual(art.abi);
    expect(AGENTS_BYTECODE).toBe(art.bytecode);
    const pm = JSON.parse(readFileSync(join(ROOT, "contracts/artifacts/NomadPaymaster.json"), "utf8"));
    expect(PAYMASTER_ABI).toEqual(pm.abi);
    expect(PAYMASTER_BYTECODE).toBe(pm.bytecode);
  });
});

describe("treasury batches for the Safe", () => {
  const ERC20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
  it("a burn sends exactly that much $NOMAD to the dead address, from the treasury Safe", () => {
    const b = batch([burnTx("250000")], "Burn", 1);
    expect(b).toMatchObject({ version: "1.0", chainId: "4663", meta: { createdFromSafeAddress: SAFE } });
    expect(b.transactions).toHaveLength(1);
    expect(b.transactions[0].to.toLowerCase()).toBe(NOMAD);
    expect(b.transactions[0].value).toBe("0");
    const d = decodeFunctionData({ abi: ERC20, data: b.transactions[0].data });
    expect(d.args).toEqual([BURN_ADDRESS, E(250000)]);
  });

  it("a bounty pays a builder; bad amounts and addresses write nothing", () => {
    const d = decodeFunctionData({ abi: ERC20, data: bountyTx(ADDR, "1500.5").data });
    expect(d.args).toEqual([ADDR, 1500500000000000000000n]);
    for (const bad of ["0", "-1", "1e5", "abc", ""]) expect(() => nomadAmount(bad), bad).toThrow();
    expect(() => bountyTx("0x123", "1")).toThrow();
    expect(() => bountyTx(SAFE, "1")).toThrow();
  });

  it("contract settings stay within the contract's own limits", () => {
    expect(() => agentsTx(ADDR, "setPlatform", ["21", "50"])).toThrow();
    expect(() => agentsTx(ADDR, "setMintFee", ["100", "101"])).toThrow();
    expect(agentsTx(ADDR, "setMintingOpen", [true]).data.startsWith("0x")).toBe(true);
    const abi = parseAbi(["function setPlatform(uint256 platformBps, uint256 burnBps)"]);
    expect(decodeFunctionData({ abi, data: agentsTx(ADDR, "setPlatform", ["10", "50"]).data }).args).toEqual([1000n, 5000n]);
  });

  it("the buyback record takes only complete entries with real hashes, once each", () => {
    const f = join(mkdtempSync(join(tmpdir(), "eco-")), "economy.json");
    writeFileSync(f, JSON.stringify({ buybacks: [] }));
    expect(() => recordBuyback(f, { date: "2026-12-01", spent: "500 USDG", bought: "1 $NOMAD", tx: "0x12" })).toThrow();
    expect(() => recordBuyback(f, { date: "Dec 1", spent: "500 USDG", bought: "1 $NOMAD", tx: H })).toThrow();
    expect(recordBuyback(f, { date: "2026-12-01", spent: "500 USDG", bought: "1200000 $NOMAD", tx: H, note: "<b>first</b>" })).toEqual({ date: "2026-12-01", spent: "500 USDG", bought: "1200000 $NOMAD", tx: H, note: "bfirstb" });
    expect(() => recordBuyback(f, { date: "2026-12-02", spent: "1 USDG", bought: "1 $NOMAD", tx: H })).toThrow("already recorded");
  });
});

const E = (n: number) => BigInt(n) * 10n ** 18n;

describe("the $5 fees in the agents totals", () => {
  it("adds what each zero-fee mint's creator sent to the burn address and the treasury in that transaction", async () => {
    const CREATOR = "0x1111111111111111111111111111111111111111";
    const hash = `0x${"ab".repeat(32)}`;
    const t = (from: string, to: string, value: string, token = TOKEN_CA) => ({ token: { address_hash: token }, from: { hash: from }, to: { hash: to }, total: { value } });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ items: [t(CREATOR, "0x000000000000000000000000000000000000dEaD", "17000000000000000000000"), t(CREATOR, REWARD_SAFE, "68000000000000000000000"), t("0x2222222222222222222222222222222222222222", REWARD_SAFE, "1000000000000000000000000"), t(CREATOR, REWARD_SAFE, "5", "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168")] }))) as unknown as typeof fetch;
    try {
      const s = await addDollarFees({ agents: [], burned: 10, toTreasury: 20, toCreators: 0, dollarMints: [{ hash, creator: CREATOR }] });
      expect(s.burned).toBe(17_010);
      expect(s.toTreasury).toBe(68_020);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
