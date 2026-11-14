import { formatAmount, isAddress, isExcluded, weightOf } from "@/lib/vote/core";
import { getStore, json, loadHolders, resolveRound } from "@/lib/vote/server";

export const dynamic = "force-dynamic";

/** A wallet's voting power in a round, and its vote if it has voted. */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const address = params.get("address");
  if (!isAddress(address)) return json({ error: "That is not a wallet address." }, 400);
  try {
    const round = await resolveRound(params.get("round"));
    if (!round) return json({ error: "That round does not exist." }, 404);
    const holders = await loadHolders(round.id);
    const weight = weightOf(round, holders, address);
    const store = getStore();
    const vote = store ? await store.getVote(round.id, address) : null;
    return json({
      round: round.id,
      address: address.toLowerCase(),
      excluded: isExcluded(round, address),
      weight: weight.toString(),
      weightText: formatAmount(weight, round.token.decimals),
      vote
    });
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
}
