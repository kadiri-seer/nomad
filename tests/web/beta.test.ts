import { describe, expect, it } from "vitest";
import { betaMessage, CREATE_BETA_ONLY } from "../../apps/web/lib/agents/beta";
import { BETA_TESTERS, isBetaTester } from "../../apps/web/lib/server/beta";

describe("the agents beta", () => {
  it("is closed to everyone but beta testers, matched by account or sign-in wallet, in any letter case", () => {
    expect(CREATE_BETA_ONLY).toBe(true);
    expect(BETA_TESTERS).toContain("0xA0eB8754d83116ae0d987C520DE64b2C56f042FC");
    expect(isBetaTester(["0xa0eb8754d83116ae0d987c520de64b2c56f042fc"])).toBe(true);
    expect(isBetaTester([null, "0xA0EB8754D83116AE0D987C520DE64B2C56F042FC"])).toBe(true);
    expect(isBetaTester(["0x742e2cB0D250c22D71a1df00Cf9D2c40214544a4", undefined])).toBe(false);
    expect(betaMessage(5)).toBe("Nomad beta: check at 5");
  });
});
