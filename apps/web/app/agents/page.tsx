import Link from "next/link";
import { AgentsMarket } from "@/components/AgentsMarket";
import { SiteFooter } from "@/components/SiteFooter";

export const metadata = {
  title: "Minted agents",
  description: "Mint a Nomad agent on Robinhood Chain for a fee in $NOMAD, set a price for copies, or get a copy of someone else's agent."
};

export default function AgentsPage() {
  return (
    <>
      <main id="main" className="wrap ai-page">
        <p className="label">Minted agents</p>
        <h1 className="ai-title">Mint your agent</h1>
        <p className="lede ai-lede">
          Record your agent on Robinhood Chain: its name, the SHA-256 of its .nomad package and where to get it. Minting costs a fee in $NOMAD, part of it burned. You can set a price for others to get a copy, and you receive it minus Nomad&apos;s share.
        </p>

        <AgentsMarket />

        <div className="ai-note muted stack" style={{ gap: 8 }}>
          <p style={{ margin: 0 }}>
            Before you import a copy, check that the file&apos;s SHA-256 matches the one recorded here (<code>sha256sum agent.nomad</code>, or <code>Get-FileHash agent.nomad</code> in PowerShell), then import it with <code>npx thenomad import agent.nomad</code>. Nomad checks the package and shows what it will write before anything changes.
          </p>
          <p style={{ margin: 0 }}>
            A minted agent is a record that its creator published it, not a review of it. The contract has not had an outside audit. Fees are on the <Link href="/economy">economy page</Link>, and none of this is financial advice.
          </p>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
