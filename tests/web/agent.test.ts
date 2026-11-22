import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AGENT_WALLETS, activityFor, fmt, parseMoves, tradesToday, units } from "../../apps/web/lib/agent";

/** The Nomad AI page: its copy follows the site's rules, and explorer data is described correctly. */
const ROOT = resolve(__dirname, "../..");
const oak = AGENT_WALLETS[0];
const rushr = AGENT_WALLETS[1];
const addr = (hash: string) => ({ hash });
const USDG = { address_hash: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", symbol: "USDG", decimals: "6", type: "ERC-20" };

describe("Nomad AI page", () => {
  it("has no em dashes, emojis or words the site avoids, and does not say where the agent runs", () => {
    for (const f of ["apps/web/app/ai/page.tsx", "apps/web/components/AgentLive.tsx", "apps/web/components/AgentAbout.tsx", "apps/web/components/AgentMoves.tsx", "apps/web/lib/agent.ts"]) {
      const text = readFileSync(join(ROOT, f), "utf8");
      expect(text.includes("—"), `${f}: em dash`).toBe(false);
      expect(/\p{Extended_Pictographic}/u.test(text), `${f}: emoji`).toBe(false);
      expect(/\b(PC|laptop|desktop|Windows|my computer)\b/.test(text), `${f}: where it runs`).toBe(false);
    }
  });

  it("reads base units exactly enough for display", () => {
    expect(units("10000000", "6")).toBe(10);
    expect(units("533441607377001", 18)).toBeCloseTo(0.000533441607377001, 15);
    expect(units("x", 6)).toBe(0);
    expect(fmt(0.000533441607377)).toBe("0.000533442");
  });

  it("describes funding, identity registration and a swap in plain words", () => {
    const now = new Date().toISOString();
    const txs = {
      items: [
        { hash: "0xreg", timestamp: "2026-11-21T22:01:37.000000Z", method: "register", status: "ok", value: "0", from: addr(oak.address), to: addr("0x8004A169FB4a3325136EB29fA0ceB6D2e539a432") },
        { hash: "0xswap", timestamp: now, method: "execute", status: "ok", value: "0", from: addr(oak.address), to: addr("0xrouter") }
      ]
    };
    const transfers = {
      items: [
        { transaction_hash: "0xfund", timestamp: "2026-11-21T22:06:17.000000Z", from: addr("0xfunder"), to: addr(oak.address), token: USDG, total: { value: "10000000", decimals: "6" } },
        { transaction_hash: "0xreg", timestamp: "2026-11-21T22:01:37.000000Z", from: addr("0x0000000000000000000000000000000000000000"), to: addr(oak.address), token: { symbol: "AGENT", decimals: null }, total: { value: "1" } },
        { transaction_hash: "0xswap", timestamp: now, from: addr(oak.address), to: addr("0xpool"), token: USDG, total: { value: "300000", decimals: "6" } },
        { transaction_hash: "0xswap", timestamp: now, from: addr("0xpool"), to: addr(oak.address), token: { symbol: "TSLA", decimals: "18" }, total: { value: "1000000000000000" } }
      ]
    };
    const a = activityFor(oak, txs, transfers);
    const by = (h: string) => a.find((x) => x.hash === h)!;
    expect(by("0xreg")).toMatchObject({ kind: "identity", text: "Registered its public agent identity" });
    expect(by("0xfund")).toMatchObject({ kind: "funding", text: "Received 10 USDG" });
    expect(by("0xswap")).toMatchObject({ kind: "trade", text: "Traded 0.3 USDG for 0.001 TSLA" });
    expect(tradesToday(a)).toBe(1);
  });

  it("describes a Rushr buy (ETH out, tokens in) as a trade, and incoming ETH as funding", () => {
    const now = new Date().toISOString();
    const txs = {
      items: [
        { hash: "0xbuy", timestamp: now, method: "execute", status: "ok", value: "100000000000000", from: addr(rushr.address), to: addr("0xrouter") },
        { hash: "0xeth", timestamp: "2026-11-21T22:14:56.000000Z", method: null, status: "ok", value: "2000000000000000", from: addr("0xfunder"), to: addr(rushr.address) }
      ]
    };
    const transfers = { items: [{ transaction_hash: "0xbuy", timestamp: now, from: addr("0xpool"), to: addr(rushr.address), token: { symbol: "MEME", decimals: "18" }, total: { value: "5000000000000000000" } }] };
    const a = activityFor(rushr, txs, transfers);
    expect(a.find((x) => x.hash === "0xbuy")).toMatchObject({ kind: "trade", text: "Traded 0.0001 ETH for 5 MEME" });
    expect(a.find((x) => x.hash === "0xeth")).toMatchObject({ kind: "funding", text: "Received 0.002 ETH" });
  });

  it("shows at most four plain moves from the feed and leaves out anything unsafe or broken", () => {
    expect(parseMoves({ moves: ["Scanned 50 Rushr tokens", "  Checked   HALBROOK  ", "Passed on both"] })).toEqual(["Scanned 50 Rushr tokens", "Checked HALBROOK", "Passed on both"]);
    expect(parseMoves({ moves: ["One", "Two", "Three", "Four", "Five"] })).toHaveLength(4);
    expect(parseMoves({ moves: ["Go to https://x.example", "www.y.example", "<img src=x>", "Sent to 0x60cf07B939AB", "[link]", "ok", "x".repeat(91), 42, null, "Kept"] })).toEqual(["Kept"]);
    for (const bad of [null, "text", 5, {}, { moves: "one" }, []]) expect(parseMoves(bad)).toEqual([]);
  });
});
