/**
 * Locking a winner's prize in Bull's escrow from the treasury's own wallet. No sign-in: Bull's plan is checked before
 * it is returned and only the treasury can send it, and a lock is recorded only once it is read on chain.
 */
import { rateLimited } from "@/lib/server/account-routes";
import { answer, body, json } from "@/lib/server/bounty-routes";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (await rateLimited(req, "bounty-lock-list", 30)) return json({ error: "Too many tries. Wait a minute." }, 429);
  return answer((s) => s.lockList());
}

export async function POST(req: Request) {
  if (await rateLimited(req, "bounty-lock", 6)) return json({ error: "Too many tries. Wait a minute." }, 429);
  const b = await body(req);
  if (!b || typeof b.bounty !== "string") return json({ error: "Not JSON." }, 400);
  if (b.action === "plan") return answer((s) => s.lockPlan(b.bounty as string));
  if (b.action === "record") return answer((s) => s.lockRecord(b.bounty as string, b.tx));
  return json({ error: "Unknown step." }, 400);
}
