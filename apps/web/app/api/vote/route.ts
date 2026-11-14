import { checkVote } from "@/lib/vote/verify";
import { getStore, json, loadHolders, publicRound, resolveRound } from "@/lib/vote/server";

export const dynamic = "force-dynamic";

/** The current round (or `?round=N`) with its ballot and results. */
export async function GET(req: Request) {
  try {
    const round = await resolveRound(new URL(req.url).searchParams.get("round"));
    if (!round) return json({ round: null });
    const holders = await loadHolders(round.id);
    return json({ round: await publicRound(round, holders, getStore()), storage: getStore() !== null });
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
}

/** Casts a vote: `{ round, choice, address, signature }`. One vote per wallet per round. */
export async function POST(req: Request) {
  const store = getStore();
  if (!store) return json({ error: "Voting storage is not connected yet." }, 503);
  const text = await req.text();
  if (text.length > 4096) return json({ error: "Request too large." }, 413);
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(text);
  } catch {
    return json({ error: "Request is not valid JSON." }, 400);
  }
  try {
    const round = await resolveRound(String(input.round ?? ""));
    if (!round) return json({ error: "That round does not exist." }, 404);
    const holders = await loadHolders(round.id);
    const checked = await checkVote(round, holders, { round: input.round, choice: input.choice, address: input.address, signature: input.signature });
    if (!checked.ok) return json({ error: checked.error }, checked.status);
    const saved = await store.addVote(checked.vote);
    if (!saved) {
      const existing = await store.getVote(round.id, checked.vote.address);
      return json({ error: "This wallet has already voted in this round.", vote: existing }, 409);
    }
    return json({ ok: true, vote: checked.vote });
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
}
