/** An entrant's steps on the account page: its wallets and entries, entering, and handing in. Signed by its sign-in wallet. */
import { rateLimited } from "@/lib/server/account-routes";
import { answer, body, json } from "@/lib/server/bounty-routes";

export const dynamic = "force-dynamic";
// A hand-in reads the repo's files and the chain before it answers.
export const maxDuration = 60;

export async function POST(req: Request) {
  if (await rateLimited(req, "bounty-entrant", 20)) return json({ error: "Too many tries. Wait a minute." }, 429);
  const b = await body(req);
  if (!b) return json({ error: "Not JSON." }, 400);
  return answer((s) => s.entrant(b));
}
