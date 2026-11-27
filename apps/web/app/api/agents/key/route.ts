import { releaseKey } from "@/lib/server/agent-keys";
import { deps, fail, json } from "@/lib/server/agent-routes";
import { rateLimited } from "@/lib/server/account-routes";

export const dynamic = "force-dynamic";

/** Gives a minted agent's package key to a wallet that owns the agent, created it or has a copy. */
export async function POST(req: Request) {
  if (await rateLimited(req, "agent-key", 20)) return json({ error: "Too many tries. Wait a minute." }, 429);
  const d = deps();
  if (typeof d === "string") return json({ error: d }, 503);
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const out = await releaseKey(d, { id: Number(body.id), address: String(body.address ?? ""), issuedAt: String(body.issuedAt ?? ""), signature: String(body.signature ?? "") });
    return json(out);
  } catch (e) {
    return fail(e);
  }
}
