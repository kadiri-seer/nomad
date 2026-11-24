import { describe, expect, it } from "vitest";
import { encodeFunctionData, erc20Abi, recoverMessageAddress, toHex, keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { encodeCallsMAv2 } from "@alchemy/smart-accounts";
import { AGENTS_ABI } from "../../apps/web/lib/agents-contract";
import { ENTRY_POINT, NOMAD, STOA_ROUTER, TREASURY, USDG } from "../../apps/web/lib/accounts/chain";
import { classify, freeGasOk, FREE_OP_MAX_WEI, maxCostWei, mintFeeOf, paymasterHash, sponsor, SponsorError, stubData, userOpHash, type RpcUserOp } from "../../apps/web/lib/server/sponsor";

/**
 * Nomad's paymaster service: who pays for an operation, and a signature NomadPaymaster accepts. The reference hashes
 * below come from the real contracts (NomadPaymaster.getHash and the v0.7 EntryPoint's getUserOpHash) on a local chain.
 */

const SENDER = "0x1111111111111111111111111111111111111111" as Address;
const AGENTS = "0x3333333333333333333333333333333333333333" as Address;
const PAYMASTER = "0x1F4808Bb14BBeee80f30c725fF8198B3d86482f1" as Address;
const signer = privateKeyToAccount(keccak256(toHex("nomad-sponsor-test-signer")));

const vectorOp: RpcUserOp = {
  sender: SENDER,
  nonce: toHex(7n),
  factory: "0x2222222222222222222222222222222222222222",
  factoryData: "0xabcdef",
  callData: "0x12345678",
  verificationGasLimit: toHex(200000n),
  callGasLimit: toHex(300000n),
  preVerificationGas: toHex(50000n),
  maxPriorityFeePerGas: toHex(1000000n),
  maxFeePerGas: toHex(2000000000n)
};

describe("hashes match the contracts", () => {
  it("paymasterHash equals NomadPaymaster.getHash", () => {
    expect(paymasterHash(vectorOp, PAYMASTER, 1900000000, 0)).toBe("0xf996d62ea6be0ec6461c71ed6053d4eac0cd722809fd095967e559be1917f16e");
  });
  it("userOpHash equals the EntryPoint's getUserOpHash", () => {
    const pmd = `0x00000000000000000000000000000000000000000000000000000000713fb3000000000000000000000000000000000000000000000000000000000000000000${"ab".repeat(65)}` as Hex;
    expect(userOpHash(vectorOp, PAYMASTER, pmd, 4663, "0xB008649d1c265CBd9aD53797Dbd4e41d2545cd74")).toBe("0x0cbab777c7f4e51bf2e9da3ef8f5963492be93a2bef31cfda6b0f666cb90930e");
  });
});

const erc = (fn: "transfer" | "approve", to: Address, amount: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: fn, args: [to, amount] });
const swap = (tokenIn: Address, tokenOut: Address, to: Address, amountIn = 5_000_000n, minOut = 950_000n) =>
  encodeFunctionData({
    abi: [{ type: "function", name: "swap", stateMutability: "payable", inputs: [{ name: "p", type: "tuple", components: [{ name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "mid", type: "address" }, { name: "leg1", type: "tuple", components: [{ name: "venue", type: "address" }, { name: "isPool", type: "bool" }] }, { name: "leg2", type: "tuple", components: [{ name: "venue", type: "address" }, { name: "isPool", type: "bool" }] }, { name: "amountIn", type: "uint256" }, { name: "minOut", type: "uint256" }, { name: "to", type: "address" }, { name: "deadline", type: "uint256" }, { name: "referrer", type: "address" }] }], outputs: [{ type: "uint256" }] }] as const,
    functionName: "swap",
    args: [{ tokenIn, tokenOut, mid: "0x0000000000000000000000000000000000000000", leg1: { venue: AGENTS, isPool: false }, leg2: { venue: AGENTS, isPool: false }, amountIn, minOut, to, deadline: 9999999999n, referrer: "0x0000000000000000000000000000000000000000" }]
  });
const mint = encodeFunctionData({ abi: AGENTS_ABI, functionName: "mint", args: ["Scout", `0x${"11".repeat(32)}`, "", 0n, 142000n * 10n ** 18n] });
const ops = (calls: { to: Address; data: Hex; value?: bigint }[]) => encodeCallsMAv2(calls.map((c) => ({ value: 0n, ...c })));

describe("who pays", () => {
  it("the treasury pays for top-ups, buying $NOMAD and minting, exactly", () => {
    expect(classify(ops([{ to: USDG, data: erc("transfer", TREASURY, 5_000_000n) }]), SENDER, AGENTS)).toBe("topup");
    expect(classify(ops([{ to: NOMAD, data: erc("approve", STOA_ROUTER, 1n) }, { to: STOA_ROUTER, data: swap(NOMAD, USDG, TREASURY) }]), SENDER, AGENTS)).toBe("topup");
    expect(classify(ops([{ to: USDG, data: erc("approve", STOA_ROUTER, 1n) }, { to: STOA_ROUTER, data: swap(USDG, NOMAD, SENDER) }]), SENDER, AGENTS)).toBe("buy-nomad");
    expect(classify(ops([{ to: NOMAD, data: erc("approve", AGENTS, 1n) }, { to: AGENTS, data: mint }]), SENDER, AGENTS)).toBe("mint");
    expect(classify(ops([{ to: USDG, data: erc("approve", STOA_ROUTER, 1n) }, { to: STOA_ROUTER, data: swap(USDG, NOMAD, SENDER) }, { to: NOMAD, data: erc("approve", AGENTS, 1n) }, { to: AGENTS, data: mint }]), SENDER, AGENTS)).toBe("mint");
  });
  it("taking money out is free too: one send of any token or ETH, or selling a token for USDG to the account", () => {
    const OUT = "0x4444444444444444444444444444444444444444" as Address;
    const OTHER_TOKEN = "0x5555555555555555555555555555555555555555" as Address;
    expect(classify(ops([{ to: USDG, data: erc("transfer", OUT, 1n) }]), SENDER, AGENTS)).toBe("send");
    expect(classify(ops([{ to: NOMAD, data: erc("transfer", OUT, 10n ** 18n) }]), SENDER, AGENTS)).toBe("send");
    expect(classify(ops([{ to: OTHER_TOKEN, data: erc("transfer", OUT, 5n) }]), SENDER, AGENTS)).toBe("send");
    expect(classify(ops([{ to: OUT, data: "0x", value: 10n ** 15n }]), SENDER, AGENTS)).toBe("send");
    expect(classify(ops([{ to: OTHER_TOKEN, data: erc("approve", STOA_ROUTER, 5n) }, { to: STOA_ROUTER, data: swap(OTHER_TOKEN, USDG, SENDER) }]), SENDER, AGENTS)).toBe("sell");
    expect(classify(ops([{ to: STOA_ROUTER, data: swap(OTHER_TOKEN, USDG, OUT) }]), SENDER, AGENTS)).toBe("paid"); // sold for someone else
    expect(classify(ops([{ to: STOA_ROUTER, data: swap(USDG, OTHER_TOKEN, SENDER) }]), SENDER, AGENTS)).toBe("paid"); // buying other tokens is a trade
    expect(classify(ops([{ to: OTHER_TOKEN, data: erc("approve", OUT, 5n) }]), SENDER, AGENTS)).toBe("paid"); // approving anyone else
  });

  it("everything else, or anything close but not exact, is paid from credits", () => {
    expect(classify(ops([{ to: USDG, data: erc("transfer", TREASURY, 999_999n) }]), SENDER, AGENTS)).toBe("paid"); // under 1 USDG
    expect(classify(ops([{ to: USDG, data: erc("transfer", SENDER, 5_000_000n) }]), SENDER, AGENTS)).toBe("paid"); // not to the treasury
    expect(classify(ops([{ to: NOMAD, data: erc("transfer", TREASURY, 5n) }]), SENDER, AGENTS)).toBe("paid"); // $NOMAD sent, not swapped
    expect(classify(ops([{ to: STOA_ROUTER, data: swap(USDG, NOMAD, AGENTS) }]), SENDER, AGENTS)).toBe("paid"); // bought for someone else
    expect(classify(ops([{ to: USDG, data: erc("approve", STOA_ROUTER, 1n) }]), SENDER, AGENTS)).toBe("paid"); // an approval alone
    expect(classify(ops([{ to: AGENTS, data: mint }, { to: USDG, data: erc("transfer", SENDER, 1n) }]), SENDER, AGENTS)).toBe("paid"); // mixed in
    expect(classify(ops([{ to: USDG, data: erc("transfer", AGENTS, 1n) }, { to: NOMAD, data: erc("transfer", AGENTS, 1n) }]), SENDER, AGENTS)).toBe("paid"); // two sends in one
    expect(classify(ops([{ to: USDG, data: erc("transfer", AGENTS, 0n) }]), SENDER, AGENTS)).toBe("paid"); // sends nothing
    expect(classify(ops([{ to: AGENTS, data: "0x", value: 1n }, { to: AGENTS, data: "0x", value: 1n }]), SENDER, AGENTS)).toBe("paid"); // ETH twice
    expect(classify(ops([{ to: AGENTS, data: "0x12", value: 1n }]), SENDER, AGENTS)).toBe("paid"); // ETH with a call
    expect(classify(ops([{ to: AGENTS, data: mint, value: 1n }]), SENDER, AGENTS)).toBe("paid"); // sends ETH
    expect(classify(ops([{ to: AGENTS, data: mint }]), SENDER, "")).toBe("paid"); // minting not open
    expect(classify("0xdeadbeef", SENDER, AGENTS)).toBe("paid");
    expect(classify(ops([{ to: STOA_ROUTER, data: swap(USDG, NOMAD, SENDER, 999_999n) }]), SENDER, AGENTS)).toBe("paid"); // a crumb of $NOMAD
    expect(classify(ops([{ to: STOA_ROUTER, data: swap(NOMAD, USDG, TREASURY, 10n ** 18n, 100_000n) }]), SENDER, AGENTS)).toBe("paid"); // a crumb to the treasury
    expect(classify(ops([{ to: STOA_ROUTER, data: swap(USDG, NOMAD, SENDER, 200_000n) }, { to: AGENTS, data: mint }]), SENDER, AGENTS)).toBe("mint"); // a small top-up inside a mint is fine
    expect(classify(ops([{ to: USDG, data: erc("transfer", TREASURY, 5_000_000n) }, { to: AGENTS, data: mint }]), SENDER, AGENTS)).toBe("paid"); // credits mixed into a mint
  });
});

// A normal fee on Robinhood Chain: 0.02 gwei, at most 0.00001 gwei of tip.
const rpcOp = (callData: Hex): RpcUserOp => ({ ...vectorOp, factory: null, factoryData: null, callData, maxFeePerGas: toHex(20_000_000n), maxPriorityFeePerGas: toHex(10_000n) });
const NOW = new Date("2026-11-23T15:00:00Z");

describe("signing", () => {
  it("signs an operation the treasury pays for, and the signature is NomadPaymaster's to check", async () => {
    const op = rpcOp(ops([{ to: USDG, data: erc("transfer", TREASURY, 5_000_000n) }]));
    const r = await sponsor({ paymaster: PAYMASTER, agents: AGENTS, signer, useFreeOp: async () => true, hold: async () => false, now: () => NOW }, [op, ENTRY_POINT, "0x1237"]);
    expect(r).toMatchObject({ paymaster: PAYMASTER, kind: "topup", paidBy: "treasury" });
    const until = Math.floor(NOW.getTime() / 1000) + 600;
    const sig = `0x${r.paymasterData.slice(2 + 128)}` as Hex;
    expect(await recoverMessageAddress({ message: { raw: paymasterHash(op, PAYMASTER, until, 0) }, signature: sig })).toBe(signer.address);
  });

  it("holds the most possible cost against credits for anything else, under the operation's hash", async () => {
    const op = rpcOp(ops([{ to: AGENTS, data: "0x12345678" }]));
    const held: unknown[] = [];
    const r = await sponsor({ paymaster: PAYMASTER, agents: AGENTS, signer, useFreeOp: async () => true, hold: async (...a) => (held.push(a), true), now: () => NOW }, [op, ENTRY_POINT, 4663]);
    expect(r.paidBy).toBe("credits");
    expect(held).toEqual([[SENDER, maxCostWei(op), userOpHash(op, PAYMASTER, r.paymasterData), Math.floor(NOW.getTime() / 1000) + 600]]);
  });

  it("refuses without credits, past the free operations, on another chain or EntryPoint, and before set-up", async () => {
    const paid = rpcOp(ops([{ to: AGENTS, data: "0x12345678" }]));
    const base = { paymaster: PAYMASTER, agents: AGENTS, signer, useFreeOp: async () => false, hold: async () => false, now: () => NOW } as const;
    await expect(sponsor(base, [paid, ENTRY_POINT, 4663])).rejects.toMatchObject({ status: 402 });
    const free = rpcOp(ops([{ to: USDG, data: erc("transfer", TREASURY, 5_000_000n) }]));
    await expect(sponsor(base, [free, ENTRY_POINT, 4663])).rejects.toMatchObject({ status: 402 }); // free ops used up, no credits
    await expect(sponsor(base, [free, ENTRY_POINT, 1])).rejects.toMatchObject({ status: 400 });
    await expect(sponsor(base, [free, "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789", 4663])).rejects.toMatchObject({ status: 400 });
    await expect(sponsor({ ...base, paymaster: "" }, [free, ENTRY_POINT, 4663])).rejects.toBeInstanceOf(SponsorError);
    expect(() => stubData({ paymaster: "" }, [free, ENTRY_POINT, 4663])).toThrow(SponsorError);
    expect(stubData({ paymaster: PAYMASTER }, [free, ENTRY_POINT, 4663])).toMatchObject({ paymaster: PAYMASTER, isFinal: false });
  });
});

describe("the fee a free operation may name", () => {
  const op = rpcOp(ops([{ to: USDG, data: erc("transfer", TREASURY, 5_000_000n) }]));
  it("is close to the chain's price and small in all", () => {
    expect(freeGasOk(op, 10_000_000n)).toBe(true);
    expect(freeGasOk({ ...op, maxFeePerGas: toHex(500_000_000n), maxPriorityFeePerGas: toHex(400_000_000n) }, 10_000_000n)).toBe(false); // 0.5 gwei when the chain asks 0.01
    expect(freeGasOk({ ...op, maxPriorityFeePerGas: toHex(30_000_000n) }, 10_000_000n)).toBe(false); // tip above the fee
    expect(freeGasOk({ ...op, callGasLimit: toHex(30_000_000n) }, 10_000_000n)).toBe(false); // over FREE_OP_MAX_WEI in all
    expect(maxCostWei(op) <= FREE_OP_MAX_WEI).toBe(true);
  });
  it("past that, the operation is paid from credits, and the free operation is not used up", async () => {
    let used = 0;
    const greedy = { ...op, maxFeePerGas: toHex(500_000_000n), maxPriorityFeePerGas: toHex(400_000_000n) };
    const r = await sponsor({ paymaster: PAYMASTER, agents: AGENTS, signer, useFreeOp: async () => (used++, true), hold: async () => true, gasPrice: async () => 10_000_000n, now: () => NOW }, [greedy, ENTRY_POINT, 4663]);
    expect(r.paidBy).toBe("credits");
    expect(used).toBe(0);
  });
});

describe("the $5 creation fee paid alongside a mint", () => {
  const DEAD = "0x000000000000000000000000000000000000dEaD" as Address;
  const mint0 = encodeFunctionData({ abi: AGENTS_ABI, functionName: "mint", args: ["Anne", `0x${"22".repeat(32)}`, "", 0n, 0n] });
  it("is part of the mint: its burn and treasury transfers are free only with a mint", () => {
    expect(classify(ops([{ to: AGENTS, data: mint0 }, { to: NOMAD, data: erc("transfer", DEAD, 16_000n) }, { to: NOMAD, data: erc("transfer", TREASURY, 64_000n) }]), SENDER, AGENTS)).toBe("mint");
    expect(classify(ops([{ to: STOA_ROUTER, data: swap(USDG, NOMAD, SENDER, 2_000_000n) }, { to: AGENTS, data: mint0 }, { to: NOMAD, data: erc("transfer", DEAD, 1n) }, { to: NOMAD, data: erc("transfer", TREASURY, 1n) }]), SENDER, AGENTS)).toBe("mint");
    expect(classify(ops([{ to: NOMAD, data: erc("transfer", DEAD, 16_000n) }, { to: NOMAD, data: erc("transfer", TREASURY, 64_000n) }]), SENDER, AGENTS)).toBe("paid"); // no mint
    expect(classify(ops([{ to: AGENTS, data: mint0 }, { to: NOMAD, data: erc("transfer", AGENTS, 5n) }]), SENDER, AGENTS)).toBe("paid"); // elsewhere
  });
});

describe("free gas for a mint needs its $5 fee", () => {
  const DEAD = "0x000000000000000000000000000000000000dEaD" as Address;
  const mintN = (n: string) => encodeFunctionData({ abi: AGENTS_ABI, functionName: "mint", args: [n, keccak256(toHex(n)), "", 0n, 0n] });
  const op = (calls: { to: Address; data: Hex }[]) => ({ ...rpcOp(ops(calls)), maxFeePerGas: toHex(20_000_000n), maxPriorityFeePerGas: toHex(10_000n) });
  const N = (v: number) => BigInt(v) * 10n ** 18n;
  const base = { paymaster: PAYMASTER, agents: AGENTS, signer, useFreeOp: async () => true, hold: async () => true, now: () => NOW, nomadFor5: async () => N(80_000) };

  it("is free when the mint pays about $5, with $1 of it burned", async () => {
    const paid = op([{ to: AGENTS, data: mintN("a") }, { to: NOMAD, data: erc("transfer", DEAD, N(16_000)) }, { to: NOMAD, data: erc("transfer", TREASURY, N(64_000)) }]);
    expect((await sponsor(base, [paid, ENTRY_POINT, 4663])).paidBy).toBe("treasury");
  });
  it("is paid from credits when the mint pays nothing, too little, too little burned, or one fee for two agents", async () => {
    const cases = [
      [{ to: AGENTS, data: mintN("a") }],
      [{ to: AGENTS, data: mintN("a") }, { to: NOMAD, data: erc("transfer", DEAD, 1n) }, { to: NOMAD, data: erc("transfer", TREASURY, 1n) }],
      [{ to: AGENTS, data: mintN("a") }, { to: NOMAD, data: erc("transfer", DEAD, N(1_000)) }, { to: NOMAD, data: erc("transfer", TREASURY, N(79_000)) }],
      [{ to: AGENTS, data: mintN("a") }, { to: AGENTS, data: mintN("b") }, { to: NOMAD, data: erc("transfer", DEAD, N(16_000)) }, { to: NOMAD, data: erc("transfer", TREASURY, N(64_000)) }]
    ] as { to: Address; data: Hex }[][];
    for (const calls of cases) expect((await sponsor(base, [op(calls), ENTRY_POINT, 4663])).paidBy).toBe("credits");
    expect(mintFeeOf(ops(cases[3]), SENDER, AGENTS)).toEqual({ mints: 2, paid: N(80_000), burned: N(16_000) });
  });
});
