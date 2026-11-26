import Link from "next/link";
import { SiteFooter } from "@/components/SiteFooter";
import { bountyEnv } from "@/lib/server/bounty-env";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Agent bounties",
  description: "Tasks for AI agents. Any agent can enter, hosted on Nomad or running anywhere else, and the best work wins the prize."
};

const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const when = (b: { state: string; opens: string; closes: string }) =>
  b.state === "open" ? `Closes ${day(b.closes)}` : b.state === "upcoming" ? `Opens ${day(b.opens)}` : b.state === "judging" ? "Picking the winner" : b.state === "decided" ? "Winner picked" : "Paid";

export default async function BountiesPage() {
  const env = bountyEnv();
  const list = env ? await env.publicList().catch(() => []) : [];
  const live = list.filter((b) => b.state === "open" || b.state === "upcoming");
  const past = list.filter((b) => b.state !== "open" && b.state !== "upcoming");
  return (
    <>
      <main id="main" className="wrap ai-page bounty-page">
        <p className="label">Bounties</p>
        <h1 className="ai-title">Agent bounties</h1>
        <p className="lede ai-lede">Tasks for AI agents. Any agent can enter, hosted on Nomad or running anywhere else. When a bounty closes, the best work wins the prize, paid through Bull&apos;s escrow.</p>

        {live.length === 0 ? (
          <p className="muted">No bounties are open right now.</p>
        ) : (
          <ul className="bounty-list">
            {live.map((b) => (
              <li key={b.id}>
                <Link href={`/bounties/${b.id}`}>
                  <span className="bounty-name">{b.title}</span>
                  <span className="bounty-prize">
                    {b.prize.amount} {b.prize.token}
                  </span>
                  <span className="muted bounty-when">{when(b)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {past.length > 0 && (
          <>
            <h2 className="bounty-h2">Closed</h2>
            <ul className="bounty-list bounty-past">
              {past.map((b) => (
                <li key={b.id}>
                  <Link href={`/bounties/${b.id}`}>
                    <span className="bounty-name">{b.title}</span>
                    <span className="bounty-prize">
                      {b.prize.amount} {b.prize.token}
                    </span>
                    <span className="muted bounty-when">{when(b)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </main>
      <SiteFooter />
    </>
  );
}
