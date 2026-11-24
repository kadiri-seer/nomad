import { describe, expect, it } from "vitest";
import { getContractAddress, keccak256, toHex } from "viem";
import { BURN_BPS, keeperAddresses, MAX_FEE, MIN_FEE, nextFee } from "../../apps/web/lib/server/fee-keeper";
import { feeKeeperSigner } from "../../apps/web/lib/server/runner-keys";
import { FEE_KEEPER_ABI } from "../../apps/web/lib/fee-keeper-contract";

/** Keeping the agent fee at $5: which fee to set, and the keeper's addresses. */

const N = (v: number) => BigInt(v) * 10n ** 18n;

describe("the next fee", () => {
  it("moves to $5's worth when it drifted, and leaves small drifts alone", () => {
    expect(nextFee(N(81_464), N(82_500))).toBeNull(); // 1.3%: not worth a transaction
    expect(nextFee(N(81_464), N(90_000))).toBe(N(90_000));
    expect(nextFee(N(90_000), N(81_464))).toBe(N(81_464));
  });
  it("goes at most 24% a step (inside the contract's 25%), and stays within the bounds", () => {
    expect(nextFee(N(142_000), N(81_464))).toBe(N(107_920)); // 142,000 less 24%
    expect(nextFee(N(107_920), N(81_464))).toBe(N(82_019)); // next step
    expect(nextFee(N(82_019), N(81_464))).toBeNull(); // within 3%
    expect(nextFee(N(20_000), N(1_000))).toBe(MIN_FEE);
    expect(nextFee(N(380_000), N(900_000))).toBe(MAX_FEE);
    expect(nextFee(0n, N(5))).toBeNull();
    expect(BURN_BPS).toBe(2000n);
  });
});

describe("the keeper's addresses", () => {
  it("are fixed by the runner's secret: the contract is the keeper wallet's first deployment", () => {
    const secret = keccak256(toHex("test-secret"));
    const { wallet, contract } = keeperAddresses(secret);
    expect(wallet).toBe(feeKeeperSigner(secret).address);
    expect(contract).toBe(getContractAddress({ from: wallet, nonce: 0n }));
    expect(keeperAddresses(keccak256(toHex("other"))).wallet).not.toBe(wallet);
  });
  it("the site's copy of the contract has the keeper's only power, updateFee, and the owner's controls", () => {
    const fns = FEE_KEEPER_ABI.filter((x) => x.type === "function").map((x) => x.name);
    for (const f of ["updateFee", "acceptAgentsOwnership", "returnAgents", "setBounds", "setKeeper", "setFee", "setTreasury"]) expect(fns).toContain(f);
  });
});
