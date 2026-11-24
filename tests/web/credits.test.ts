import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Address, type Hex } from "viem";
import { MemoryRedis } from "../../apps/web/lib/vote/redis";
import { ENTRY_POINT, NOMAD, TREASURY, USDG } from "../../apps/web/lib/accounts/chain";
import { balanceOf, chargeRun, claimTopUp, CreditsError, FREE_OPS_GLOBAL_PER_DAY, gasCharge, hold, settle, useFreeOp, useFreeOpFor, type CreditsDeps, type Receipt } from "../../apps/web/lib/server/credits";
import { FREE_OPS_PER_DAY } from "../../apps/web/lib/accounts/chain";

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
  // $NOMAD at 10^-5 USDG each in these tests: 10^23 wei (100,000 $NOMAD) is worth 1 USDG.
  return { redis: new MemoryRedis(), ethUsd: async () => 2500, txReceipt: async () => receipt, userOpCost: async (h) => opCosts[h.toLowerCase()] ?? null, nomadValueMicros: async (a) => (a * 10n ** 6n) / 10n ** 23n, now: () => now };
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
    const d = deps({ status: "success", logs: [before, transfer(NOMAD, ME, ROUTER, 10n ** 24n), transfer(USDG, ROUTER, TREASURY, 10_000_000n), opEvent(ME)] });
    expect((await claimTopUp(d, ME, TX)).addedUsd).toBe("11.00");
  });

  it("give the bonus only on the $NOMAD's real value, not on USDG sent with a crumb of $NOMAD", async () => {
    const crumb = deps({ status: "success", logs: [before, transfer(NOMAD, ME, OTHER, 10n ** 18n), transfer(USDG, ME, TREASURY, 50_000_000n), opEvent(ME)] });
    expect((await claimTopUp(crumb, ME, TX)).addedUsd).toBe("50.00"); // 1 $NOMAD is worth 0.00001 USDG: no bonus to speak of
    const half = deps({ status: "success", logs: [before, transfer(NOMAD, ME, ROUTER, 5n * 10n ** 23n), transfer(USDG, ROUTER, TREASURY, 5_000_000n), transfer(USDG, ME, TREASURY, 5_000_000n), opEvent(ME)] });
    expect((await claimTopUp(half, ME, TX)).addedUsd).toBe("10.50"); // 10% of the 5 USDG paid in $NOMAD
    const noPrice = { ...deps({ status: "success", logs: [before, transfer(NOMAD, ME, ROUTER, 10n ** 24n), transfer(USDG, ROUTER, TREASURY, 10_000_000n), opEvent(ME)] }), nomadValueMicros: async () => { throw new Error("no quote"); } };
    expect((await claimTopUp(noPrice, ME, TX)).addedUsd).toBe("10.00"); // no price, no bonus, the top-up still counts
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

describe("free operations need a signed-in person", () => {
  it("are never free without one, and are counted per person, per account and for everyone", async () => {
    const r = new MemoryRedis();
    const day = "2026-11-24";
    expect(await useFreeOpFor(r, { account: ME, user: null }, day)).toBe(false);
    // One person cannot get more by using many accounts.
    const used: boolean[] = [];
    for (let i = 0; i < FREE_OPS_PER_DAY + 2; i++) used.push(await useFreeOpFor(r, { account: (`0x${(i + 16).toString(16).padStart(40, "0")}`) as Address, user: "did:privy:a" }, day));
    expect(used.filter(Boolean).length).toBe(FREE_OPS_PER_DAY);
    expect(await useFreeOpFor(r, { account: OTHER, user: "did:privy:b" }, day)).toBe(true);
  });
  it("stop for everyone at the daily ceiling", async () => {
    const r = new MemoryRedis();
    let ok = 0;
    for (let i = 0; i < FREE_OPS_GLOBAL_PER_DAY + 10; i++) if (await useFreeOpFor(r, { account: (`0x${(i + 1).toString(16).padStart(40, "0")}`) as Address, user: `did:privy:${i}` }, "2026-11-24")) ok++;
    expect(ok).toBe(FREE_OPS_GLOBAL_PER_DAY);
  });
});

describe("holds and charges at the same moment", () => {
  it("never spend the same credits twice", async () => {
    const d = deps(null);
    await d.redis.cmd(["HSET", `nomad:credits:${ME.toLowerCase()}`, "balance", "1000000"]);
    const cost = 4_000_000_000_000n * 50n; // $0.625 with the margin, at $2,500
    const two = await Promise.all([hold(d, ME, cost, `0x${"01".repeat(32)}` as Hex, 9999999999), hold(d, ME, cost, `0x${"02".repeat(32)}` as Hex, 9999999999)]);
    expect(two.filter(Boolean).length).toBe(1);
    expect((await balanceOf(d, ME)).micros.held).toBe(625_000n);
    expect(await chargeRun(d, ME, 400_000n)).toBe(false); // only $0.375 is free
    expect((await balanceOf(d, ME)).micros.balance).toBe(1_000_000n);
  });
});
