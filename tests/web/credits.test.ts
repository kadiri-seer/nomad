import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Address, type Hex } from "viem";
import { MemoryRedis } from "../../apps/web/lib/vote/redis";
import { ENTRY_POINT, NOMAD, TREASURY, USDG } from "../../apps/web/lib/accounts/chain";
import { balanceOf, chargeRun, claimTopUp, CreditsError, gasCharge, hold, settle, useFreeOp, type CreditsDeps, type Receipt } from "../../apps/web/lib/server/credits";

/** Credits: top-ups checked on-chain and counted once, gas held then settled at the real cost plus the margin. */

const ME = "0x1111111111111111111111111111111111111111" as Address;
const OTHER = "0x2222222222222222222222222222222222222222" as Address;
const ROUTER = "0x2F2804fad735a38015650f32f95Ad5E08D6B3eE5" as Address;
const TX = `0x${"aa".repeat(32)}` as Hex;
const OP = `0x${"bb".repeat(32)}` as Hex;

const EP = parseAbi([
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
  "event BeforeExecution()"
]);
const T = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const transfer = (token: Address, from: Address, to: Address, value: bigint) => ({ address: token, topics: encodeEventTopics({ abi: T, eventName: "Transfer", args: { from, to } }) as Hex[], data: encodeAbiParameters([{ type: "uint256" }], [value]) });
const opEvent = (sender: Address, success = true) => ({ address: ENTRY_POINT, topics: encodeEventTopics({ abi: EP, eventName: "UserOperationEvent", args: { userOpHash: OP, sender, paymaster: TREASURY } }) as Hex[], data: encodeAbiParameters([{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }], [0n, success, 1n, 1n]) });
const before = { address: ENTRY_POINT, topics: encodeEventTopics({ abi: EP, eventName: "BeforeExecution" }) as Hex[], data: "0x" as Hex };

function deps(receipt: Receipt | null, opCosts: Record<string, bigint> = {}, now = new Date("2026-11-23T15:00:00Z")): CreditsDeps {
  return { redis: new MemoryRedis(), ethUsd: async () => 2500, txReceipt: async () => receipt, userOpCost: async (h) => opCosts[h.toLowerCase()] ?? null, now: () => now };
}

describe("top-ups", () => {
  it("count the USDG the treasury received in this account's own operation, once", async () => {
    const d = deps({ status: "success", logs: [before, transfer(USDG, OTHER, TREASURY, 9_000_000n), opEvent(OTHER), transfer(USDG, ME, TREASURY, 5_000_000n), opEvent(ME)] });
    const r = await claimTopUp(d, ME, TX);
    expect(r.addedUsd).toBe("5.00"); // the other account's 9 USDG in the same bundle is not counted
    expect(r.balance.balanceUsd).toBe("5.00");
    await expect(claimTopUp(d, ME, TX)).rejects.toMatchObject({ status: 409 });
  });

  it("add 10% when paid in $NOMAD (swapped by Stoa to USDG for the treasury)", async () => {
    const d = deps({ status: "success", logs: [before, transfer(NOMAD, ME, ROUTER, 10n ** 23n), transfer(USDG, ROUTER, TREASURY, 10_000_000n), opEvent(ME)] });
    expect((await claimTopUp(d, ME, TX)).addedUsd).toBe("11.00");
  });

  it("refuse what is not a successful top-up of at least 1 USDG from this account", async () => {
    await expect(claimTopUp(deps(null), ME, TX)).rejects.toMatchObject({ status: 404 });
    await expect(claimTopUp(deps({ status: "reverted", logs: [] }), ME, TX)).rejects.toMatchObject({ status: 400 });
    await expect(claimTopUp(deps({ status: "success", logs: [before, transfer(USDG, OTHER, TREASURY, 5_000_000n), opEvent(OTHER)] }), ME, TX)).rejects.toThrow(/not a payment from this account/);
    await expect(claimTopUp(deps({ status: "success", logs: [before, transfer(USDG, ME, TREASURY, 5_000_000n), opEvent(ME, false)] }), ME, TX)).rejects.toThrow(/not a payment from this account/);
    await expect(claimTopUp(deps({ status: "success", logs: [before, transfer(USDG, ME, OTHER, 5_000_000n), opEvent(ME)] }), ME, TX)).rejects.toThrow(/at least 1 USDG/);
    await expect(claimTopUp(deps({ status: "success", logs: [before, transfer(USDG, ME, TREASURY, 999_999n), opEvent(ME)] }), ME, TX)).rejects.toThrow(/at least 1 USDG/);
    await expect(claimTopUp(deps(null), "me", TX)).rejects.toBeInstanceOf(CreditsError);
  });
});

describe("gas", () => {
  it("is charged at cost plus 25%, rounded up to a micro-dollar", () => {
    // 0.000004 ETH at $2,500 is $0.01; plus 25% is $0.0125
    expect(gasCharge(4_000_000_000_000n, 2500)).toBe(12_500n);
    expect(() => gasCharge(1n, 0)).toThrow(CreditsError);
  });

  it("holds the most possible cost, then charges the real cost once the operation lands", async () => {
    const d = deps({ status: "success", logs: [before, transfer(USDG, ME, TREASURY, 2_000_000n), opEvent(ME)] });
    await claimTopUp(d, ME, TX);
    expect(await hold(d, ME, 40_000_000_000_000n, OP, 1_900_000_000)).toBe(true); // $0.125 held
    expect((await balanceOf(d, ME)).heldUsd).toBe("0.12");
    const landed = { ...d, userOpCost: async () => 4_000_000_000_000n };
    await settle(landed, ME);
    const b = await balanceOf(landed, ME);
    expect(b.micros).toEqual({ balance: 2_000_000n - 12_500n, held: 0n, available: 2_000_000n - 12_500n });
  });

  it("refuses to hold more than is available, and releases a hold that expired without landing", async () => {
    const d = deps({ status: "success", logs: [before, transfer(USDG, ME, TREASURY, 1_000_000n), opEvent(ME)] });
    await claimTopUp(d, ME, TX);
    expect(await hold(d, ME, 10n ** 18n, OP, 1_900_000_000)).toBe(false); // 1 ETH of gas
    const nowSec = Math.floor(new Date("2026-11-23T15:00:00Z").getTime() / 1000);
    expect(await hold(d, ME, 4_000_000_000_000n, OP, nowSec + 600)).toBe(true);
    await settle({ ...d, now: () => new Date((nowSec + 1300) * 1000) }, ME);
    expect((await balanceOf(d, ME)).micros).toEqual({ balance: 1_000_000n, held: 0n, available: 1_000_000n });
  });
});

describe("runs and free operations", () => {
  it("charges a run only when the credits cover it", async () => {
    const d = deps({ status: "success", logs: [before, transfer(USDG, ME, TREASURY, 1_000_000n), opEvent(ME)] });
    await claimTopUp(d, ME, TX);
    expect(await chargeRun(d, ME, 250_000n)).toBe(true);
    expect(await chargeRun(d, ME, 900_000n)).toBe(false);
    expect((await balanceOf(d, ME)).balanceUsd).toBe("0.75");
  });

  it("allows six operations a day on the treasury, per account", async () => {
    const r = new MemoryRedis();
    const results = [];
    for (let i = 0; i < 7; i++) results.push(await useFreeOp(r, ME, "2026-11-23"));
    expect(results).toEqual([true, true, true, true, true, true, false]);
    expect(await useFreeOp(r, OTHER, "2026-11-23")).toBe(true);
    expect(await useFreeOp(r, ME, "2026-11-24")).toBe(true);
  });
});
