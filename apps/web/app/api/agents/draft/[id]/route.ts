/** One draft from `nomad deploy`, for the account page to fill in Create agent. */
import { json } from "@/lib/server/account-routes";
import { draftStore } from "@/lib/server/agent-drafts";
import { redisFromEnv } from "@/lib/redis";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const redis = redisFromEnv();
  if (!redis) return json({ error: "Not found." }, 404);
  const draft = await draftStore(redis).get(id);
  return draft ? json({ draft }) : json({ error: "This draft has expired or does not exist. Run nomad deploy again." }, 404);
}
