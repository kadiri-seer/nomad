/** A whitelisted sponsor's own bounties: each step signed by its sign-in wallet. "check" tells a wallet only about itself. */
import { rateLimited } from "@/lib/server/account-routes";
import { answer, body, json } from "@/lib/server/bounty-routes";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (await rateLimited(req, "bounty-sponsor", 20)) return json({ error: "Too many tries. Wait a minute." }, 429);
  const b = await body(req);
  if (!b) return json({ error: "Not JSON." }, 400);
  return answer((s) => s.sponsor(b));
}
