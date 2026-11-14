import { getStore, json, resolveRound } from "@/lib/vote/server";

export const dynamic = "force-dynamic";

/** Every signed vote in a round, so anyone can recount it. */
export async function GET(req: Request) {
  try {
    const round = await resolveRound(new URL(req.url).searchParams.get("round"));
    if (!round) return json({ error: "That round does not exist." }, 404);
    const store = getStore();
    if (!store) return json({ error: "Voting storage is not connected yet." }, 503);
    const votes = (await store.listVotes(round.id)).sort((a, b) => a.votedAt.localeCompare(b.votedAt));
    return json({ round: round.id, votes });
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
}
