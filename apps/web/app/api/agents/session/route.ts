/** The agent wallet for a signer and salt, and the runner's session key for it (an address; the key never leaves). */
import { getAddress, isAddress } from "viem";
import { json } from "@/lib/server/account-routes";
import { agentEnv } from "@/lib/server/agent-api";
import { expectedAgentWallet } from "@/lib/server/agent-exec";
import { sessionSigner } from "@/lib/server/runner-keys";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const signer = q.get("signer") ?? "";
  const salt = q.get("salt") ?? "";
  if (!isAddress(signer) || !/^\d{1,30}$/.test(salt) || BigInt(salt) === 0n) return json({ error: "signer or salt is not valid." }, 400);
  const env = agentEnv();
  if (!env) return json({ error: "Agents are not switched on on this site yet." }, 503);
  const { address } = await expectedAgentWallet(getAddress(signer), BigInt(salt));
  return json({ account: address, sessionAddress: sessionSigner(env.secret, address).address });
}
