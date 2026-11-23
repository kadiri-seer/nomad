/**
 * Keys the agent runner holds, all derived from one secret (AGENT_RUNNER_SECRET, kept only in the site's settings):
 * a session key per agent wallet, and the small wallet that pays Idlex for AI jobs. Nothing is stored.
 */
import { concat, keccak256, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export function runnerSecret(env: Record<string, string | undefined> = process.env): Hex | null {
  const s = env.AGENT_RUNNER_SECRET?.trim();
  return s && /^0x[0-9a-fA-F]{64}$/.test(s) ? (s as Hex) : null;
}

/** The runner's session key for one agent wallet. */
export const sessionKey = (secret: Hex, agentAccount: Address) => keccak256(concat([secret, toHex("nomad-agent-session"), agentAccount.toLowerCase() as Hex]));
export const sessionSigner = (secret: Hex, agentAccount: Address) => privateKeyToAccount(sessionKey(secret, agentAccount));

/** The wallet that pays Idlex; fund it with a few USDG. */
export const idlexPayer = (secret: Hex) => privateKeyToAccount(keccak256(concat([secret, toHex("nomad-idlex-payer")])));
