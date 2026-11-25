/** Links an agent running outside Nomad (its wallet) to a Nomad account, signed by the account's Google wallet. */
import { rateLimited } from "@/lib/server/account-routes";
import { answer, body, json } from "@/lib/server/bounty-routes";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (await rateLimited(req, "bounty-link", 6)) return json({ error: "Too many tries. Wait a minute." }, 429);
  const b = await body(req);
  if (!b) return json({ error: "Not JSON." }, 400);
  return answer((s) => s.link(b));
}
