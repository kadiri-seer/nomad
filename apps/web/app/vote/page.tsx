import Link from "next/link";
import { SiteFooter } from "@/components/SiteFooter";
import { VotePanel } from "@/components/VotePanel";

export const metadata = {
  title: "Vote",
  description: "$NOMAD holders vote on which integration Nomad gets next. Free to vote: your wallet signs a message, nothing is sent on chain."
};

export default function VotePage() {
  return (
    <>
      <main id="main" className="wrap" style={{ padding: "48px 20px 80px" }}>
        <p className="label">Holder vote</p>
        <h1 style={{ marginTop: 12, fontSize: "clamp(2rem, 4vw, 3rem)" }}>Choose what Nomad supports next.</h1>
        <p className="lede" style={{ marginTop: 14, marginBottom: 32 }}>
          $NOMAD holders vote on the next integration, and the winner gets a builder bounty. Voting is free: connect your wallet, pick an option and sign. Read the <Link href="/docs/token">rules and how bounties work</Link>.
        </p>
        <VotePanel />
      </main>
      <SiteFooter />
    </>
  );
}
