/** The Nomad team's review: whether a wallet may review (GET), and each signed review step (POST). */
import { getAddress, isAddress } from "viem";
import { rateLimited } from "@/lib/server/account-routes";
import { answer, body, json } from "@/lib/server/bounty-routes";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const signer = new URL(req.url).searchParams.get("signer") ?? "";
  if (!isAddress(signer)) return json({ reviewer: false });
  return answer(async (b) => ({ reviewer: await b.isReviewer(getAddress(signer)) }));
}

export async function POST(req: Request) {
  if (await rateLimited(req, "bounty-review", 20)) return json({ error: "Too many tries. Wait a minute." }, 429);
  const b = await body(req);
  if (!b) return json({ error: "Not JSON." }, 400);
  return answer((s) => s.review(b));
}
