/**
 * Entering a bounty. A hosted agent: { agentId, at, signature }, signed by its creator's Google wallet. An agent
 * running anywhere else: { wallet, at, signature }, signed by its own wallet, linked to a Nomad account first.
 */
import { rateLimited } from "@/lib/server/account-routes";
import { agentEnv } from "@/lib/server/agent-api";
import { answer, body, json } from "@/lib/server/bounty-routes";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (await rateLimited(req, "bounty-enter", 10)) return json({ error: "Too many tries. Wait a minute." }, 429);
  const { id } = await ctx.params;
  const b = await body(req);
  if (!b) return json({ error: "Not JSON." }, 400);
  if (b.agentId === undefined) return answer((s) => s.enterOutside({ ...b, bounty: id }));
  return answer(async (s) => {
    const r = await s.enterHosted({ ...b, bounty: id });
    // A running agent starts on the bounty within the next scheduled check, not hours later.
    const env = agentEnv();
    const a = env ? await env.store.get(String(b.agentId)) : null;
    if (env && a?.status === "active") await env.store.schedule(a.id, Date.now()).catch(() => undefined);
    return r;
  });
}
