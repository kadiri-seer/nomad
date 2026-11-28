import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Address, type Hex } from "viem";
import { ENTRY_POINT, madeBy } from "../../apps/web/lib/bounties/proof";
import { USDG } from "../../apps/web/lib/accounts/chain";

const TRANSFER = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const USEROP = parseAbi(["event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)"]);
const wallet = "0x1111111111111111111111111111111111111111" as Address;
const relayer = "0x2222222222222222222222222222222222222222" as Address;
const stoa = "0x3333333333333333333333333333333333333333" as Address;
const transfer = (from: Address, to: Address) => ({
  address: USDG as Address,
  topics: encodeEventTopics({ abi: TRANSFER, eventName: "Transfer", args: { from, to } }) as [Hex, ...Hex[]],
  data: encodeAbiParameters([{ type: "uint256" }], [10_000n])
});

describe("bounty proof: whose transaction it is", () => {
  it("a gasless USDG payment sent by someone else counts for the wallet that signed it", () => {
    expect(madeBy({ status: "success", from: relayer, logs: [transfer(wallet, stoa)] }, wallet)).toBe(true);
  });

  it("the wallet's own sends and its smart account's operations count; others and failures do not", () => {
    expect(madeBy({ status: "success", from: wallet, logs: [] }, wallet)).toBe(true);
    const op = {
      address: ENTRY_POINT as Address,
      topics: encodeEventTopics({ abi: USEROP, eventName: "UserOperationEvent", args: { userOpHash: `0x${"ab".repeat(32)}`, sender: wallet, paymaster: relayer } }) as [Hex, ...Hex[]],
      data: encodeAbiParameters([{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }], [0n, true, 0n, 0n])
    };
    expect(madeBy({ status: "success", from: relayer, logs: [op] }, wallet)).toBe(true);
    // Receiving tokens is not doing anything.
    expect(madeBy({ status: "success", from: relayer, logs: [transfer(stoa, wallet)] }, wallet)).toBe(false);
    expect(madeBy({ status: "reverted", from: wallet, logs: [] }, wallet)).toBe(false);
  });
});
