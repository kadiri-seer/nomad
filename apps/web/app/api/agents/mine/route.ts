/**
 * A person's agents. Anyone can list them (GET: names, kinds, wallets); their latest moves and reports are only for
 * their creator (POST, signed by the creator's Google wallet).
 */
import { getAddress, isAddress, verifyMessage, type Hex } from "viem";
import { json, rateLimited } from "@/lib/server/account-routes";
import { agentEnv, ownerAgent, publicAgent } from "@/lib/server/agent-api";
import { mainAccountOf } from "@/lib/server/agent-exec";
import { viewMessage } from "@/lib/agents/shared";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (await rateLimited(req, "agents-mine", 60)) return json({ error: "Too many requests. Wait a minute." }, 429);
  const owner = new URL(req.url).searchParams.get("owner") ?? "";
  if (!isAddress(owner, { strict: false })) return json({ error: "owner is not an address." }, 400);
  const env = agentEnv();
  if (!env) return json({ agents: [], ready: false });
  const agents = await env.store.ofOwner(getAddress(owner));
  return json({ agents: agents.map(publicAgent), ready: true });
}

export async function POST(req: Request) {
  if (await rateLimited(req, "agents-mine-owner", 30)) return json({ error: "Too many requests. Wait a minute." }, 429);
  let b: { signer?: string; at?: number; signature?: string };
  try {
    b = await req.json();
  } catch {
    return json({ error: "Not JSON." }, 400);
  }
  if (typeof b.signer !== "string" || !isAddress(b.signer, { strict: false })) return json({ error: "signer is not an address." }, 400);
  const at = Number(b.at);
  if (!Number.isFinite(at) || Math.abs(Date.now() - at) > 10 * 60_000) return json({ error: "The signature is too old. Try again." }, 400);
  const signer = getAddress(b.signer);
  const ok = typeof b.signature === "string" && (await verifyMessage({ address: signer, message: viewMessage(signer, at), signature: b.signature as Hex }).catch(() => false));
  if (!ok) return json({ error: "The signature does not match." }, 403);
  const env = agentEnv();
  if (!env) return json({ agents: [], ready: false });
  const agents = await env.store.ofOwner(getAddress(await mainAccountOf(signer)));
  const out = await Promise.all(agents.map(async (a) => ({ ...ownerAgent(a), lastMove: (await env.store.moves(a.id, 1))[0] ?? null })));
  return json({ agents: out, ready: true });
}
