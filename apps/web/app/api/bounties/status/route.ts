/** The status line of each bounty entry a Nomad account has. */
import { getAddress, isAddress } from "viem";
import { answer, json } from "@/lib/server/bounty-routes";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const owner = new URL(req.url).searchParams.get("owner") ?? "";
  if (!isAddress(owner)) return json({ error: "owner is not an address." }, 400);
  return answer(async (b) => ({ entries: await b.statusOf(getAddress(owner)) }));
}
