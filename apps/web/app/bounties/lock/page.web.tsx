import { SiteFooter } from "@/components/SiteFooter";
import { LockPrize } from "./LockPrize";

export const metadata = { title: "Lock a bounty prize", robots: { index: false, follow: false } };

/** For the treasury's own wallet: open this page in the wallet's browser to lock a picked winner's prize with Bull. */
export default function LockPage() {
  return (
    <>
      <main id="main" className="wrap ai-page bounty-page">
        <p className="label">Bounties</p>
        <h1 className="ai-title">Lock a prize with Bull</h1>
        <p className="lede ai-lede">Open this page in the treasury wallet&apos;s own browser. Each prize is locked for its winner and paid once the reviewer confirms. If nobody confirms within 3 days, it goes back to the treasury.</p>
        <LockPrize />
      </main>
      <SiteFooter />
    </>
  );
}
