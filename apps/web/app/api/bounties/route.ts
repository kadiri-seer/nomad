/** The bounties anyone can see: open, upcoming, being judged and decided. Entries stay private. */
import { answer } from "@/lib/server/bounty-routes";

export const dynamic = "force-dynamic";

export async function GET() {
  return answer(async (b) => ({ bounties: await b.publicList() }));
}
