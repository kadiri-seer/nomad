import { describe, expect, it } from "vitest";
import { betaMessage, CREATE_BETA_ONLY } from "../../apps/web/lib/agents/beta";
import { BETA_TESTERS, isBetaTester } from "../../apps/web/lib/server/beta";

describe("the agents beta", () => {
  it("is closed to everyone but beta testers, matched by account or sign-in wallet, in any letter case", () => {
    expect(CREATE_BETA_ONLY).toBe(true);
    expect(BETA_TESTERS).toContain("0xad44DE6F62a0386Edc53fB66eaD6F4f61b7014eE");
    expect(isBetaTester(["0xad44de6f62a0386edc53fb66ead6f4f61b7014ee"])).toBe(true);
    expect(isBetaTester([null, "0xAD44DE6F62A0386EDC53FB66EAD6F4F61B7014EE"])).toBe(true);
    expect(isBetaTester(["0x742e2cB0D250c22D71a1df00Cf9D2c40214544a4", undefined])).toBe(false);
    expect(betaMessage(5)).toBe("Nomad beta: check at 5");
  });
});
