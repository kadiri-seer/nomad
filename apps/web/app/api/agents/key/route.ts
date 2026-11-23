import { releaseKey } from "@/lib/server/agent-keys";
import { deps, fail, json } from "@/lib/server/agent-routes";

export const dynamic = "force-dynamic";

/** Gives a minted agent's package key to a wallet that owns the agent, created it or has a copy. */
export async function POST(req: Request) {
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
