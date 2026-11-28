/** Beta testers: accounts (or their sign-in wallets) that can use every agent feature before it opens to everyone. */
import type { Address } from "viem";

export const BETA_TESTERS: string[] = ["0xad44DE6F62a0386Edc53fB66eaD6F4f61b7014eE"];

/** True when any of these addresses (an account, or the wallet that signs for it) is a beta tester. */
export function isBetaTester(addresses: (Address | string | null | undefined)[]): boolean {
  const set = new Set(BETA_TESTERS.map((a) => a.toLowerCase()));
  return addresses.some((a) => !!a && set.has(a.toLowerCase()));
}
