/** Keeps a draft from `nomad deploy` for 24 hours and returns its id. */
import { json, rateLimited } from "@/lib/server/account-routes";
import { checkDraft, DraftError, draftStore } from "@/lib/server/agent-drafts";
import { veninCheck } from "@/lib/server/venin-check";
import { redisFromEnv } from "@/lib/redis";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (await rateLimited(req, "agent-draft", 10)) return json({ error: "Too many tries. Wait a minute." }, 429);
  const redis = redisFromEnv();
  if (!redis) return json({ error: "Deploying is not set up on this site yet." }, 503);
  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return json({ error: "Not JSON." }, 400);
  }
  if (!b || typeof b !== "object") return json({ error: "Not JSON." }, 400);
  try {
    const draft = await checkDraft(b, async (p, t) => (await veninCheck(p, t)).planted);
    return json({ id: await draftStore(redis).put(draft) });
  } catch (e) {
    if (e instanceof DraftError) return json({ error: e.message }, e.status);
    return json({ error: "Something went wrong. Nothing was kept. Try again." }, 502);
  }
}
