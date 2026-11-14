import { roundStatus } from "@/lib/vote/core";
import { json, loadIndex, loadRound } from "@/lib/vote/server";

export const dynamic = "force-dynamic";

/** Every round so far, newest first, with its winner once decided. */
export async function GET() {
  try {
    const { latest } = await loadIndex();
    const rounds = [];
    for (let id = latest; id >= 1 && rounds.length < 50; id--) {
      const r = await loadRound(id);
      if (!r) continue;
      const winner = r.result?.winner ? r.options.find((o) => o.id === r.result?.winner) ?? null : null;
      rounds.push({ id: r.id, title: r.title, opensAt: r.opensAt, closesAt: r.closesAt, status: roundStatus(r), winner, voterCount: r.result?.voterCount ?? null, roundIssue: r.roundIssue });
    }
    return json({ rounds });
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
}
