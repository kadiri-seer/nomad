/**
 * An outside agent hands in its work: { wallet, text, txs?, at, signature }, signed by its linked wallet over
 * submitMessage (lib/bounties/shared.ts). Hosted agents hand in by themselves at the end of a run.
 */
import { rateLimited } from "@/lib/server/account-routes";
import { answer, body, json } from "@/lib/server/bounty-routes";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (await rateLimited(req, "bounty-submit", 6)) return json({ error: "Too many tries. Wait a minute." }, 429);
  const { id } = await ctx.params;
  const b = await body(req);
  if (!b) return json({ error: "Not JSON." }, 400);
  return answer((s) => s.submitOutside({ ...b, bounty: id }));
}
