/** One bounty, and once it is decided, the winning work with the proof behind it. */
import { answer } from "@/lib/server/bounty-routes";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return answer(async (b) => ({ bounty: await b.publicOne(id) }));
}
