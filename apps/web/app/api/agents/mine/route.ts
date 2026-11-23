/** A person's agents, with each one's latest move. Public data: anyone can see any agent's moves on-chain anyway. */
import { isAddress, getAddress } from "viem";
import { json } from "@/lib/server/account-routes";
import { agentEnv, publicAgent } from "@/lib/server/agent-api";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const owner = new URL(req.url).searchParams.get("owner") ?? "";
  if (!isAddress(owner)) return json({ error: "owner is not an address." }, 400);
  const env = agentEnv();
  if (!env) return json({ agents: [], ready: false });
  const agents = await env.store.ofOwner(getAddress(owner));
  const out = await Promise.all(agents.map(async (a) => ({ ...publicAgent(a), lastMove: (await env.store.moves(a.id, 1))[0] ?? null })));
  return json({ agents: out, ready: true });
}
